import { EventEmitter } from 'events'

export type EventName =
  | 'task.lifecycle'
  | 'task.registered'
  | 'task.unregistered'
  | 'voice.recording.started'
  | 'voice.recording.stopped'
  | 'voice.recognition.completed'
  | 'agent.input.received'
  | 'agent.response.generated'
  | 'agent.error'
  | 'agent.tool.invoked'
  | 'agent.tool.completed'
  | 'agent.tool.failed'
  | 'agent.plan.created'
  | 'agent.plan.step'
  | 'agent.plan.completed'
  | 'tts.playback.started'
  | 'tts.playback.finished'
  | 'scheduler.tick'
  | 'scheduler.task.completed'
  | 'scheduler.task.failed'
  | 'engine.registered'
  | 'engine.unregistered'
  | 'engine.activated'
  | 'evolution.cycle.started'
  | 'evolution.cycle.completed'
  | 'insight.analysis.started'
  | 'insight.detector.completed'
  | 'insight.candidate.generated'
  | 'insight.found'
  | 'insight.analysis.completed'
  | 'creativity.cycle.started'
  | 'creativity.cycle.completed'
  | 'creativity.dream.completed'
  | 'creativity.ideas.generated'
  | 'plugin.registered'
  | 'plugin.unregistered'
  | 'plugin.error'
  | 'recovery.checkpoint.created'
  | 'recovery.session.restored'
  | 'recovery.error.classified'
  | 'recovery.recovery.started'
  | 'recovery.recovery.completed'
  | 'recovery.context.compress'
  | 'stability.score.updated'
  | 'stability.status.changed'
  | 'budget.exhausted'
  | 'budget.restored'
  | 'evolution.snapshot.created'
  | 'evolution.rollback.completed'
  | 'evolution.proposal.validated'
  | 'task.graph.cycle_detected'
  | 'goal.guardrail.rejection'
  | 'goal.guardrail.tripped'
  | 'agent.observe'
  | 'agent.think'
  | 'agent.reflect'

export interface EventPayload {
  'task.lifecycle': { taskId: string; type: string; status: string; durationMs?: number; error?: string }
  'task.registered': { type: string; label: string }
  'task.unregistered': { type: string }
  'voice.recording.started': {}
  'voice.recording.stopped': {}
  'voice.recognition.completed': { text: string; duration: number }
  'agent.input.received': { text: string; requestId: string; source: 'electron' | 'telegram' }
  'agent.response.generated': { text: string; requestId: string; source: 'electron' | 'telegram' }
  'agent.error': { error: string; requestId: string }
  'agent.tool.invoked': { tool: string; args: Record<string, any> }
  'agent.tool.completed': { tool: string; result: string }
  'agent.tool.failed': { tool: string; error: string }
  'agent.plan.created': { planId: string; title: string }
  'agent.plan.step': { planId: string; stepIndex: number; status: string }
  'agent.plan.completed': { planId: string }
  'tts.playback.started': { text: string }
  'tts.playback.finished': {}
  'scheduler.tick': { taskId: string; cron: string }
  'scheduler.task.completed': { taskId: string; result?: string }
  'scheduler.task.failed': { taskId: string; error: string }
  'engine.registered': { name: string; type: string }
  'engine.unregistered': { name: string }
  'engine.activated': { name: string; previous: string | null }
  'evolution.cycle.started': { timestamp: number; mode?: string; failures?: number; strategyName?: string; historyCount?: number }
  'evolution.cycle.completed': {
    success: boolean
    summary: string
    timestamp: number
    mode?: string
    planTitle?: string
    planProgress?: string
    durationMs?: number
  }
  'creativity.cycle.started': {}
  'creativity.cycle.completed': { count: number; hasValue: boolean }
  'creativity.dream.completed': { count: number; topNovelty: number }
  'creativity.ideas.generated': {
    count: number
    ideas: { id: string; title: string; novelty: number; feasibility: number; impact: number }[]
  }
  'insight.analysis.started': {}
  'insight.detector.completed': { detector: string; findings: number }
  'insight.candidate.generated': { count: number }
  'insight.found': { count: number; insights: { id: string; title: string; score: number; confidence: number }[] }
  'insight.analysis.completed': { count: number; hasValue: boolean }
  'plugin.registered': { name: string; version: string; toolCount: number }
  'plugin.unregistered': { name: string; reason?: string }
  'plugin.error': { name: string; error: string; phase: string }
  'recovery.checkpoint.created': { runId: string; trigger: string; path: string }
  'recovery.session.restored': { runId: string; hasUnfinishedPlan: boolean }
  'recovery.error.classified': { category: string; strategy: string; retryDelayMs: number }
  'recovery.recovery.started': { oldRunId: string; error: string }
  'recovery.recovery.completed': { newRunId: string; success: boolean }
  'recovery.context.compress': { beforeTokens: number; afterTokens: number }
  'skill.installed': { name: string; version: string; tools: number }
  'skill.uninstalled': { name: string }
  'skill.enabled': { name: string }
  'skill.disabled': { name: string; reason?: string }
  'skill.error': { name: string; error: string; phase: string }
  'stability.score.updated': { score: number; trend: string; status: string }
  'stability.status.changed': { previous: string; current: string; score: number }
  'budget.exhausted': { resource: string; utilization: number }
  'budget.restored': { resource: string; utilization: number }
  'evolution.snapshot.created': { tag: string; branch: string; timestamp: number }
  'evolution.rollback.completed': { level: string; ref: string; success: boolean; error?: string }
  'evolution.proposal.validated': { proposalId: string; passed: boolean; regressionRisk: string }
  'task.graph.cycle_detected': { cycle: string[] }
  'goal.guardrail.rejection': { reason: string; toolName: string; step: number }
  'goal.guardrail.tripped': { count: number; threshold: number }
  'agent.observe': { requestId: string; step: number; proceduresFound: number; patternsFound: number; durationMs: number }
  'agent.think': { requestId: string; step: number; toolCallCount: number; strategyPrompted: boolean }
  'agent.reflect': { requestId: string; step: number; toolResults: number; successCount: number; summary: string; durationMs: number }
}

type Listener<E extends EventName> = (payload: EventPayload[E]) => void

/**
 * 订阅追踪器 — 收集所有 EventBus 订阅的清理函数，统一 dispose
 */
export class SubscriptionTracker {
  private disposers: Set<() => void> = new Set()

  add(disposer: () => void): void {
    this.disposers.add(disposer)
  }

  dispose(): void {
    for (const fn of this.disposers) {
      try {
        fn()
      } catch {
        // 静默处理单个清理的异常
      }
    }
    this.disposers.clear()
  }

  get count(): number {
    return this.disposers.size
  }
}

export class EventBus {
  private emitter = new EventEmitter()
  private static instance: EventBus
  private static readonly MAX_LISTENERS = 50
  /** 记录每个事件的订阅来源（label → disposer），用于诊断 */
  private subscriptionLabels = new Map<string, Set<string>>()

  static getInstance(): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus()
      EventBus.instance.emitter.setMaxListeners(EventBus.MAX_LISTENERS)
    }
    return EventBus.instance
  }

  on<E extends EventName>(event: E, listener: Listener<E>, label?: string): () => void {
    const count = this.emitter.listenerCount(event)
    if (count >= EventBus.MAX_LISTENERS) {
      console.warn(`[EventBus] Listener leak warning: "${event}" has ${count} listeners (max ${EventBus.MAX_LISTENERS})`)
    }
    this.emitter.on(event, listener)
    const disposer = () => {
      this.emitter.off(event, listener)
    }
    if (label) {
      if (!this.subscriptionLabels.has(event)) {
        this.subscriptionLabels.set(event, new Set())
      }
      this.subscriptionLabels.get(event)!.add(label)
    }
    return disposer
  }

  /** 注册订阅并自动加入 tracker */
  track<E extends EventName>(event: E, listener: Listener<E>, tracker: SubscriptionTracker, label?: string): void {
    const disposer = this.on(event, listener, label)
    tracker.add(disposer)
  }

  off<E extends EventName>(event: E, listener: Listener<E>): void {
    this.emitter.off(event, listener)
  }

  once<E extends EventName>(event: E, listener: Listener<E>): () => void {
    this.emitter.once(event, listener)
    return () => {
      this.emitter.off(event, listener)
    }
  }

  emit<E extends EventName>(event: E, payload: EventPayload[E]): void {
    try {
      this.emitter.emit(event, payload)
    } catch (err) {
      console.error(`[EventBus] emit ${event} failed:`, err)
    }
  }

  removeAll(event?: EventName): void {
    if (event) {
      this.emitter.removeAllListeners(event)
      this.subscriptionLabels.delete(event)
    } else {
      this.emitter.removeAllListeners()
      this.subscriptionLabels.clear()
    }
  }

  listenerCount(event: EventName): number {
    return this.emitter.listenerCount(event)
  }

  /** 诊断：当前所有活跃订阅概况 */
  getStats(): Record<string, { count: number; labels: string[] }> {
    const stats: Record<string, { count: number; labels: string[] }> = {}
    const events = this.emitter.eventNames() as string[]
    for (const event of events) {
      const count = this.emitter.listenerCount(event)
      const labels = Array.from(this.subscriptionLabels.get(event) || [])
      stats[event] = { count, labels }
    }
    return stats
  }
}

export const eventBus = EventBus.getInstance()
