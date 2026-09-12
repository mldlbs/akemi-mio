/**
 * MemoryContextProvider — ADR-013 Phase 3 Context Injection
 *
 * 中间层：SessionMemory 和 ChatExecutor 之间
 * - 调用 retrieval (mode='context')
 * - token budget 裁剪（实际 format 后估算，非 compaction.tokenCount）
 * - 格式化 MemoryContextBlock → 注入文本
 * - 失败时降级（空 context，不阻断主流程）
 *
 * Phase 3 Observation Contract 约束：
 *   - 单次 retrieve() 调用（避免双重 call）
 *   - tokenEstimate = estimateTokenCount(formattedText)（实际文本估算）
 *   - traceId 贯通 injection 事件 → 可关联 model.invoked/completed
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { EvaluationEmitter } from '@akemi-mio/core/core/evaluation/EvaluationEmitter'
import { type RetrievalSpec, SessionMemory, estimateTokenCount } from './SessionMemory'

// ══════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════

export interface InjectionContext {
  /** 格式化后的文本（最终注入 prompt） */
  text: string
  /** 源 compaction 的 session IDs */
  sourceSessions: string[]
  /** token 估算（基于 formatMemoryContextBlock 实际输出） */
  tokenEstimate: number
  /** fallback 模式标识 */
  fallbackMode: boolean
  /** 注入模式 */
  mode: 'observation' | 'context'
}

// ══════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════

const DEFAULT_MAX_TOKENS = 800

/** Memory Context block 首尾标签（截断时保留） */
const HEADER_LINE = '<Memory Context>'
const FOOTER_LINE = '</Memory Context>'

// ══════════════════════════════════════════════
// MemoryContextProvider
// ══════════════════════════════════════════════

export class MemoryContextProvider {
  private emitter: EvaluationEmitter | null = null

  constructor(private sessionMemory: SessionMemory) {}

  setEvaluationEmitter(emitter: EvaluationEmitter): void {
    this.emitter = emitter
  }

  /**
   * Phase 3: 构建注入用的 context block。
   *
   * 调用 chain:
   *   SessionMemory.retrieve(mode='context') → scored + filtered + budget cut
   *   → 内联构建 block（避免二次 retrieve）
   *   → formatMemoryContextBlock() → injection text
   *   → estimateTokenCount() → 真实 token 估算
   *   → 超限时尾部截断（保证不超 budget）
   *
   * 集成 traceId 传递：
   *   injection 事件通过 meta.traceId 携带 traceId，
   *   供 Observation Window 关联 model.invoked/completed。
   *
   * 任何失败降级返回空 context，不抛异常。
   */
  buildInjectionContext(spec: RetrievalSpec, traceId?: string): InjectionContext {
    try {
      const maxTokens = spec.maxTokens ?? DEFAULT_MAX_TOKENS

      // Step 1: 单次 retrieve（mode='context'）
      const results = this.sessionMemory.retrieve({
        ...spec,
        mode: 'context',
        maxTokens,
      })

      if (!results || results.length === 0) {
        this.emitInjectionSkipped(spec.sessionId || '', 'no_results', traceId)
        return emptyContext()
      }

      // Step 2: 内联构建 block（避免二次调用 buildContext()）
      const digests = results.map((r) => r.compaction.digest)
      const facts = results.flatMap((r) => r.compaction.facts.map((f) => `[${f.type}] ${f.subject}: ${f.newValue}`))
      const decisions = results.flatMap((r) => r.compaction.decisions.map((d) => `${d.subject}: ${d.decision}`))
      const sourceSessions = [...new Set(results.map((r) => r.compaction.sessionId))]

      if (digests.length === 0) {
        this.emitInjectionSkipped(spec.sessionId || '', 'no_results', traceId)
        return emptyContext()
      }

      // Step 3: format + 实际 token 估算
      let text = formatMemoryContextBlock({ digests, facts, decisions, sourceSessions })
      let actualTokens = estimateTokenCount([text])

      // Step 4: 超限截断 — 按结果顺序从尾部移除（results 已按 score 降序排列）
      // 保留 HEADER + FOOTER，从尾部移除 digest/fact/decision 条目
      if (actualTokens > maxTokens && results.length > 0) {
        // 从尾部开始逐个移除 compaction 条目，直到在 budget 内
        const toRemove = new Set<number>()
        for (let i = results.length - 1; i >= 0; i--) {
          if (actualTokens <= maxTokens) break
          toRemove.add(i)
          // 重新计算 tokens
          const keptResults = results.filter((_, idx) => !toRemove.has(idx))
          const keptDigests = keptResults.map((r) => r.compaction.digest)
          const keptFacts = keptResults.flatMap((r) => r.compaction.facts.map((f) => `[${f.type}] ${f.subject}: ${f.newValue}`))
          const keptDecisions = keptResults.flatMap((r) => r.compaction.decisions.map((d) => `${d.subject}: ${d.decision}`))
          const keptSources = [...new Set(keptResults.map((r) => r.compaction.sessionId))]
          text = formatMemoryContextBlock({
            digests: keptDigests,
            facts: keptFacts,
            decisions: keptDecisions,
            sourceSessions: keptSources,
          })
          actualTokens = estimateTokenCount([text])
        }
      }

      // 截断后可能为空（全部移除），返回空 context
      if (!text) {
        this.emitInjectionSkipped(spec.sessionId || '', 'budget_exhausted', traceId)
        return emptyContext()
      }

      this.emitInjected(spec.sessionId || '', sourceSessions, actualTokens, traceId)

      return {
        text,
        sourceSessions,
        tokenEstimate: actualTokens,
        fallbackMode: false,
        mode: 'context',
      }
    } catch (err) {
      log('WARN', 'memory_context_provider_failed', { error: String(err) })
      this.emitInjectionSkipped(spec.sessionId || '', 'provider_error', traceId)
      return emptyContext()
    }
  }

  private emitInjected(sessionId: string, sourceSessions: string[], tokenEstimate: number, traceId?: string): void {
    if (!this.emitter) return
    this.emitter.emit(
      'memory.context.injected' as any,
      {
        type: 'memory.context.injected',
        sessionId,
        sourceSessions,
        tokenEstimate,
        sourceCount: sourceSessions.length,
        fallbackMode: false,
      } as any,
      { sessionId, traceId },
    )
  }

  private emitInjectionSkipped(sessionId: string, reason: 'no_results' | 'provider_error' | 'budget_exhausted', traceId?: string): void {
    if (!this.emitter) return
    this.emitter.emit(
      'memory.context.injection_skipped' as any,
      {
        type: 'memory.context.injection_skipped',
        sessionId,
        reason,
      } as any,
      { sessionId, traceId },
    )
  }
}

function emptyContext(): InjectionContext {
  return {
    text: '',
    sourceSessions: [],
    tokenEstimate: 0,
    fallbackMode: true,
    mode: 'context',
  }
}

/**
 * 格式化 MemoryContextBlock → 可注入 prompt 的纯文本。
 *
 * 输出格式：
 *   <Memory Context>
 *   [来自 session: {sid}] {digest}
 *   [事实] {fact}
 *   [决策] {decision}
 *   </Memory Context>
 *
 * 约束：
 *   - 纯文本，无 JSON 拼接
 *   - 每个条目一行，便于 LLM 解析
 *   - 空 block 输出空字符串
 */
export function formatMemoryContextBlock(block: {
  digests: string[]
  facts: string[]
  decisions: string[]
  sourceSessions: string[]
}): string {
  const lines: string[] = []
  lines.push(HEADER_LINE)

  for (let i = 0; i < block.digests.length; i++) {
    const sid = block.sourceSessions[i] || 'unknown'
    if (block.digests[i]) {
      lines.push(`[来自 session: ${sid}] ${block.digests[i]}`)
    }
  }

  for (const f of block.facts) {
    lines.push(`[事实] ${f}`)
  }

  for (const d of block.decisions) {
    lines.push(`[决策] ${d}`)
  }

  lines.push(FOOTER_LINE)

  // 如果只有标签（无内容），返回空
  if (lines.length <= 2) return ''

  return lines.join('\n')
}
