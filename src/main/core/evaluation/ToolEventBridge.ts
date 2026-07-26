/**
 * ToolEventBridge — EventBus agent.tool.* → EvaluationEmitter 桥接适配器
 *
 * 职责：
 * - 订阅 EventBus 的 agent.tool.invoked / completed / failed 事件
 * - 翻译为 EvaluationEvent (tool.invoked / tool.completed) 写入 EvaluationRepository
 * - 从 EventBus payload 中提取 requestId 传播为 traceId
 *
 * 约束：
 * - 不做领域建模修改。payload 保持 EventBus 原始结构。
 * - 不承担 Metrics、Sampling、Deduplication 等派生计算。
 */

import { eventBus, type EventName, type EventPayload } from '../EventBus'
import { EvaluationEmitter } from './EvaluationEmitter'

/** EventBus 的最小可订阅接口 — 适配 singleton 和 test double */
interface EventSubscriber {
  on<E extends EventName>(event: E, listener: (payload: EventPayload[E]) => void): () => void
  off<E extends EventName>(event: E, listener: (payload: EventPayload[E]) => void): void
}

/** 工具调用跟踪条目 — 用于匹配 invoked / completed 配对。 */
interface PendingInvocation {
  toolName: string
  invokedAt: number
  traceId: string
}

export class ToolEventBridge {
  private emitter: EvaluationEmitter
  private bus: EventSubscriber
  private disposers: Array<() => void> = []

  /** 每个工具名的 FIFO 调用队列 */
  private pendingMap = new Map<string, PendingInvocation[]>()

  constructor(emitter: EvaluationEmitter, bus?: EventSubscriber) {
    this.emitter = emitter
    this.bus = bus ?? eventBus
  }

  start(): void {
    this.disposers.push(
      this.bus.on('agent.tool.invoked', (p) => this.onToolInvoked(p)),
      this.bus.on('agent.tool.completed', (p) => this.onToolCompleted(p)),
      this.bus.on('agent.tool.failed', (p) => this.onToolFailed(p)),
      // P0 (ADR-015): capability 事件桥接
      this.bus.on('capability.invoked', (p) => this.onCapabilityInvoked(p)),
      this.bus.on('capability.completed', (p) => this.onCapabilityCompleted(p)),
      // P1.1 (ADR-015): capability shadow 事件
      this.bus.on('capability.suggested', (p) => this.onCapabilitySuggested(p)),
    )
  }

  stop(): void {
    for (const dispose of this.disposers) dispose()
    this.disposers = []
    this.pendingMap.clear()
  }

  private onToolInvoked(p: EventPayload['agent.tool.invoked']): void {
    const toolName = p.tool
    const now = Date.now()
    const traceId = p.requestId || ''

    // 入队 pending 记录
    const queue = this.pendingMap.get(toolName) ?? []
    queue.push({ toolName, invokedAt: now, traceId })
    this.pendingMap.set(toolName, queue)

    this.emitter.emit('tool.invoked', { type: 'tool.invoked', toolName, args: p.args as Record<string, unknown> | undefined }, { traceId })
  }

  private onToolCompleted(p: EventPayload['agent.tool.completed']): void {
    const pending = this.consumePending(p.tool)
    if (!pending) return // 无可匹配的 invoked

    this.emitter.emit(
      'tool.completed',
      {
        type: 'tool.completed',
        toolName: p.tool,
        durationMs: Date.now() - pending.invokedAt,
        output: p.result?.slice(0, 5000),
      },
      { traceId: pending.traceId },
    )
  }

  private onToolFailed(p: EventPayload['agent.tool.failed']): void {
    const pending = this.consumePending(p.tool)
    if (!pending) return

    this.emitter.emit(
      'tool.completed',
      {
        type: 'tool.completed',
        toolName: p.tool,
        durationMs: Date.now() - pending.invokedAt,
        error: p.error?.slice(0, 2000),
      },
      { traceId: pending.traceId },
    )
  }

  /** 消费 FIFO 队列中最旧的 pending 记录 */
  private consumePending(toolName: string): PendingInvocation | null {
    const queue = this.pendingMap.get(toolName)
    if (!queue || queue.length === 0) return null
    const pending = queue.shift()!
    if (queue.length === 0) this.pendingMap.delete(toolName)
    return pending
  }

  // ══════════════════════════════════════════
  // Capability events (ADR-015 P0)
  // ══════════════════════════════════════════

  private onCapabilityInvoked(p: EventPayload['capability.invoked']): void {
    this.emitter.emit('capability.invoked', {
      type: 'capability.invoked',
      capability: p.capability,
      provider: p.provider,
      tool: p.tool,
      input: p.input,
    })
  }

  private onCapabilityCompleted(p: EventPayload['capability.completed']): void {
    this.emitter.emit('capability.completed', {
      type: 'capability.completed',
      capability: p.capability,
      provider: p.provider,
      tool: p.tool,
      success: p.success,
      durationMs: p.durationMs,
      error: p.error,
    })
  }

  // ══════════════════════════════════════════
  // Capability Shadow (ADR-015 P1.1)
  // ══════════════════════════════════════════

  private onCapabilitySuggested(p: EventPayload['capability.suggested']): void {
    this.emitter.emit('capability.suggested', {
      type: 'capability.suggested',
      capability: p.capability,
      relatedTools: p.relatedTools,
      contextSource: p.contextSource,
    })
  }
}
