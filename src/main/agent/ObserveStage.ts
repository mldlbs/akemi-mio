/**
 * ObserveStage — OTPAR Observe 阶段
 *
 * 在 LLM 返回 toolCalls 后、Guardrail 之前运行。
 * 查询 ProceduralMemory 和 FailureAnalyzer 获取与当前工具相关的上下文。
 * 纯本地逻辑，无额外 LLM 调用，<50ms。
 */

import type { ToolCallInfo } from '../llm/LlmService'
import type { Message } from './context'
import type { RunContext } from './runstate'
import type { ProceduralMemory } from './ProceduralMemory'
import type { FailureAnalyzer } from './FailureAnalyzer'
import { eventBus } from '../core/EventBus'

export interface ObserveResult {
  injected: boolean
  proceduresFound: number
  patternsFound: number
}

export function runObserve(
  toolCalls: ToolCallInfo[],
  messages: Message[],
  ctx: RunContext,
  deps: {
    proceduralMemory: ProceduralMemory | null
    failureAnalyzer: FailureAnalyzer | null
  },
): ObserveResult {
  // Fast path: no deps or no tools
  if ((!deps.proceduralMemory && !deps.failureAnalyzer) || !toolCalls?.length) {
    return { injected: false, proceduresFound: 0, patternsFound: 0 }
  }

  const t0 = Date.now()
  const toolNames = toolCalls.map((t) => t.name)
  const toolNamesStr = toolNames.join(' ')
  const toolNamesSet = new Set(toolNames)

  const relevantProcedures: { name: string; description: string; steps: string[] }[] = []
  const relevantPatterns: { count: number; names: string[]; error: string }[] = []

  // 1. Query procedural memory for matching procedures
  if (deps.proceduralMemory && toolNamesStr.length > 0) {
    const procedures = deps.proceduralMemory.findByEmbedding(toolNamesStr, 2)
    for (const p of procedures) {
      relevantProcedures.push({ name: p.name, description: p.description, steps: p.steps })
    }
  }

  // 2. Query failure analyzer for patterns matching proposed tools
  if (deps.failureAnalyzer) {
    const hotPatterns = deps.failureAnalyzer.getHotPatterns(3)
    for (const p of hotPatterns) {
      const names = Array.from(p.names)
      const matches = names.some((n) => toolNamesSet.has(n))
      if (matches) {
        relevantPatterns.push({ count: p.count, names, error: p.errors[0] || '' })
      }
    }
  }

  const injected = relevantProcedures.length > 0 || relevantPatterns.length > 0

  // 3. Inject observations into messages
  if (injected) {
    const parts: string[] = []

    if (relevantProcedures.length > 0) {
      parts.push('【观察】以下已保存流程与当前操作相关：')
      for (const p of relevantProcedures) {
        parts.push(`- ${p.name}: ${p.description.slice(0, 80)}`)
        parts.push(`  步骤: ${p.steps.map((s, i) => `${i + 1}.${s}`).join(' → ')}`)
      }
    }

    if (relevantPatterns.length > 0) {
      parts.push('【注意】以下失败模式与当前工具调用相关：')
      for (const p of relevantPatterns) {
        parts.push(`- [${p.count}次] ${p.names.join(', ')}: ${p.error.slice(0, 80)}`)
      }
    }

    messages.push({ role: 'user', content: parts.join('\n') })
  }

  eventBus.emit('agent.observe', {
    requestId: ctx.runId,
    step: ctx.step,
    proceduresFound: relevantProcedures.length,
    patternsFound: relevantPatterns.length,
    durationMs: Date.now() - t0,
  })

  return { injected, proceduresFound: relevantProcedures.length, patternsFound: relevantPatterns.length }
}
