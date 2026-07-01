/**
 * IntentExtractor — 用户意图链路追踪（Phase 2）
 *
 * 监听 agent.input.received / agent.response.generated / agent.tool.* 事件，
 * 将用户消息序列聚合为结构化意图链路。
 *
 * 双来源融合设计：
 * - User-level signal：user message、task goal、follow-up correction
 * - Execution-level abstraction：repeated tool patterns、branching structure
 *
 * 输出 IntentTrace 供 TraceAligner 与 ExecutionTrace 对齐。
 */

import { eventBus } from '../core/EventBus'
import { log } from '../logger/Logger'

// ─── Intent Trace 数据结构 ─────────────────────────────────────────

export interface IntentSegment {
  type: 'user_input' | 'assistant_response' | 'tool_call'
  text: string
  toolName?: string
  timestamp: number
}

export interface IntentTrace {
  traceId: string
  sessionId: string
  timestamp: number
  abstractGoal: string
  subGoals: string[]
  constraints: string[]
  confidence: number
  segments: IntentSegment[]
}

// ─── IntentExtractor ───────────────────────────────────────────────

export class IntentExtractor {
  /** requestId → intent trace（进行中） */
  private pendingTraces = new Map<string, IntentTrace>()
  /** 已完成 intent trace 缓存 */
  private completedTraces: IntentTrace[] = []

  private disposed = false
  private disposers: (() => void)[] = []

  constructor() {
    this.subscribe()
  }

  private subscribe(): void {
    // 用户输入 → 创建/追加 intent trace
    const onInput = eventBus.on('agent.input.received', (p: { text: string; requestId: string; source: string }) => {
      if (this.disposed) return
      this.appendUserInput(p.requestId, p.text)
    })
    this.disposers.push(onInput)

    // 助手响应 → 追加回复段
    const onResponse = eventBus.on('agent.response.generated', (p: { text: string; requestId: string; source: string }) => {
      if (this.disposed) return
      this.appendResponse(p.requestId, p.text)
    })
    this.disposers.push(onResponse)

    // 工具调用 → 追加工具段
    const onToolInvoked = eventBus.on('agent.tool.invoked' as any, (p: { tool: string; args: Record<string, any> }) => {
      if (this.disposed) return
      // 工具调用没有 requestId，用最近的活跃 requestId
      this.appendToolCall(p.tool)
    })
    this.disposers.push(onToolInvoked)
  }

  /** 用户输入 → 创建新 trace 或追加到已有 trace */
  private appendUserInput(requestId: string, text: string): void {
    let trace = this.pendingTraces.get(requestId)
    if (!trace) {
      trace = {
        traceId: `intent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        sessionId: requestId,
        timestamp: Date.now(),
        abstractGoal: this.extractAbstractGoal(text),
        subGoals: [],
        constraints: this.extractConstraints(text),
        confidence: 0.5,
        segments: [],
      }
      this.pendingTraces.set(requestId, trace)
    }

    trace.segments.push({
      type: 'user_input',
      text,
      timestamp: Date.now(),
    })
    trace.subGoals = this.updateSubGoals(trace)

    // 超时保护：超过 10 分钟自动完成
    this.scheduleAutoComplete(requestId, trace)
  }

  /** 助手响应 → 追加到对应 trace */
  private appendResponse(requestId: string, text: string): void {
    const trace = this.pendingTraces.get(requestId)
    if (!trace) return

    trace.segments.push({
      type: 'assistant_response',
      text,
      timestamp: Date.now(),
    })
  }

  /** 工具调用 → 追加到最近的 trace */
  private appendToolCall(toolName: string): void {
    // 找最近活跃的 trace
    let latestTrace: IntentTrace | null = null
    let latestTs = 0
    for (const trace of this.pendingTraces.values()) {
      const lastSeg = trace.segments[trace.segments.length - 1]
      if (lastSeg && lastSeg.timestamp > latestTs) {
        latestTs = lastSeg.timestamp
        latestTrace = trace
      }
    }
    if (!latestTrace) return

    latestTrace.segments.push({
      type: 'tool_call',
      text: '',
      toolName,
      timestamp: Date.now(),
    })
  }

  /** 从用户消息提取抽象目标（简单规则，Phase 3 可用 LLM 升级） */
  private extractAbstractGoal(text: string): string {
    // 去常见前缀
    const cleaned = text.replace(/^(请|帮我|帮忙|可以|能不能|需要|想)\s*/i, '').trim()
    // 取第一个句子
    const firstSentence = cleaned.split(/[。！？\n]/)[0]?.trim() || cleaned
    return firstSentence.slice(0, 120)
  }

  /** 提取约束条件（简单规则） */
  private extractConstraints(text: string): string[] {
    const constraints: string[] = []
    // 匹配 "用 X" "使用 X" "通过 X" 模式
    const toolMatch = text.match(/(?:用|使用|通过)\s*(\S+)/)
    if (toolMatch) constraints.push(`tool:${toolMatch[1]}`)
    return constraints
  }

  /** 更新子目标列表 */
  private updateSubGoals(trace: IntentTrace): string[] {
    const goals: string[] = []
    for (const seg of trace.segments) {
      if (seg.type === 'user_input') {
        const text = seg.text
        // 分割复合请求：用 "和" "并" "然后" 分隔
        const parts = text.split(/[和并然后,，]/).filter(Boolean)
        for (const p of parts) {
          const trimmed = p.trim()
          if (trimmed && trimmed.length > 4) goals.push(trimmed.slice(0, 80))
        }
      }
    }
    return [...new Set(goals)]
  }

  /** 超时自动完成 trace */
  private scheduleAutoComplete(requestId: string, trace: IntentTrace): void {
    setTimeout(
      () => {
        if (this.disposed) return
        const t = this.pendingTraces.get(requestId)
        if (!t || t === trace) {
          // 标记为已完成
          trace.confidence = Math.min(0.9, 0.5 + trace.segments.length * 0.1)
          this.completedTraces.push(trace)
          this.pendingTraces.delete(requestId)
          log('INFO', 'intent_trace_completed', {
            traceId: trace.traceId,
            goal: trace.abstractGoal,
            segments: trace.segments.length,
            confidence: trace.confidence,
          })
        }
      },
      10 * 60 * 1000,
    ).unref()
  }

  /** 获取所有已完成的 intent trace */
  getCompletedTraces(): IntentTrace[] {
    return [...this.completedTraces]
  }

  /** 获取所有进行中的 intent trace */
  getPendingTraces(): Map<string, IntentTrace> {
    return new Map(this.pendingTraces)
  }

  /** 立即完成指定 requestId 的 trace */
  completeTrace(requestId: string): IntentTrace | null {
    const trace = this.pendingTraces.get(requestId)
    if (!trace) return null
    trace.confidence = Math.min(0.95, 0.5 + trace.segments.length * 0.1)
    this.completedTraces.push(trace)
    this.pendingTraces.delete(requestId)
    return trace
  }

  dispose(): void {
    this.disposed = true
    for (const d of this.disposers) d()
    this.disposers = []
  }
}
