import { EventEmitter } from 'events'
import type { Priority, OnOptions, EventMeta, StoredListener, EventStoreEngine } from './EventBusTypes'
import { PRIORITY_ORDER } from './EventBusTypes'

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
  | 'plugin.health-changed'
  | 'plugin.quarantined'
  | 'plugin.dead'
  | 'plugin.zone-conflict'
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
  | 'evolution.plan.outcome'
  | 'evolution.action.executed'
  | 'task.graph.cycle_detected'
  | 'goal.guardrail.rejection'
  | 'goal.guardrail.tripped'
  | 'agent.observe'
  | 'agent.think'
  | 'agent.reflect'
  | 'guardrail.readonly_stuck'
  | 'guardrail.tool_error'
  | 'guardrail.context_corrupted'
  | 'guardrail.progress_stagnation'
  | 'runtime.health.updated'
  | 'skill.enabled'
  | 'skill.disabled'
  | 'pipeline.started'
  | 'pipeline.completed'
  | 'pipeline.errored'
  | 'workflow.run.created'
  | 'workflow.run.updated'
  | 'workflow.run.step'
  | 'workflow.def.created'

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
  'agent.tool.invoked': { tool: string; args: Record<string, any>; requestId: string }
  'agent.tool.completed': { tool: string; result: string; requestId: string }
  'agent.tool.failed': { tool: string; error: string; requestId: string }
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
    ideas: {
      id: string
      title: string
      idea: string
      expectedBenefit: string
      risk: string
      sourceLabels: string[]
      novelty: number
      feasibility: number
      impact: number
    }[]
  }
  'creativity.hypothesis.selected': {
    id: string
    title: string
    idea: string
    novelty: number
    feasibility: number
    impact: number
    sourceLabels: string[]
    expectedBenefit: string
    risk: string
  }
  'insight.analysis.started': {}
  'insight.detector.completed': { detector: string; findings: number }
  'insight.candidate.generated': { count: number }
  'insight.found': { count: number; insights: { id: string; title: string; score: number; confidence: number }[] }
  'insight.analysis.completed': { count: number; hasValue: boolean }
  'plugin.registered': { name: string; version: string; toolCount: number }
  'plugin.unregistered': { name: string; reason?: string }
  'plugin.error': { name: string; error: string; phase: string }
  'plugin.health-changed': { name: string; status: string; fitnessScore: number }
  'plugin.quarantined': { pluginName: string; reason: string; errorDetail?: string; quarantineDuration: number; timestamp: number }
  'plugin.dead': { name: string; reason: string; fitnessScore: number }
  'plugin.zone-conflict': { toolName: string; existingPlugin: string; incomingPlugin: string; resolution: string; resolvedAt: number }
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
  'pipeline.started': { timestamp: number }
  'pipeline.completed': {
    collected: number
    fixed: number
    failed: number
    queueRemaining: number
    timestamp: number
    durationMs: number
    details: Array<{
      problemId: string
      source: string
      file: string
      line: number | undefined
      title: string
      success: boolean
      summary: string
      durationMs: number
      output?: string
      error?: string
    }>
  }
  'pipeline.errored': { error: string }
  'workflow.run.created': {
    runId: string
    workflowDefId?: string
    workflowName?: string
    steps?: any[]
    startedAt?: number
    status?: string
  }
  'workflow.run.updated': { runId: string; status?: string; stepId?: string; error?: string; agentResult?: string }
  'workflow.run.step': { runId: string; stepId: string; status?: string; error?: string; agentResult?: any }
  'workflow.def.created': { workflowDefId: string; name: string }
  'stability.score.updated': { score: number; trend: string; status: string }
  'stability.status.changed': { previous: string; current: string; score: number }
  'budget.exhausted': { resource: string; utilization: number }
  'budget.restored': { resource: string; utilization: number }
  'evolution.snapshot.created': { tag: string; branch: string; timestamp: number }
  'evolution.rollback.completed': { level: string; ref: string; success: boolean; error?: string }
  'evolution.proposal.validated': { proposalId: string; passed: boolean; regressionRisk: string }
  'evolution.plan.outcome': {
    success: boolean
    summary: string
    planTitle?: string
    stepsCompleted: number
    stepsTotal: number
    hadTimeout: boolean
    hadRetry: boolean
    durationMs: number
  }
  'evolution.action.executed': {
    allOk: boolean
    details: { name: string; success: boolean; summary: string }[]
    durationMs?: number
  }
  'task.graph.cycle_detected': { cycle: string[] }
  'goal.guardrail.rejection': { reason: string; toolName: string; step: number }
  'goal.guardrail.tripped': { count: number; threshold: number }
  'agent.observe': { requestId: string; step: number; proceduresFound: number; patternsFound: number; durationMs: number }
  'agent.think': { requestId: string; step: number; toolCallCount: number; strategyPrompted: boolean }
  'agent.reflect': { requestId: string; step: number; toolResults: number; successCount: number; summary: string; durationMs: number }
  'guardrail.readonly_stuck': { count: number; consecutiveRounds: number }
  'guardrail.tool_error': { tool: string; error: string; consecutiveErrors: number }
  'guardrail.context_corrupted': { error: string; details?: string }
  'guardrail.progress_stagnation': { consecutiveRounds: number; step: number }
  'runtime.health.updated': {
    compositeScore: number
    compositeLevel: string
    sessionScore: number
    capabilityScore: number
    taskScore: number
    modelScore: number
    recommendedActions: string[]
    timestamp: number
  }
}

export type Listener<E extends EventName> = (payload: EventPayload[E]) => void

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
  /** priority-ordered listeners per event */
  private priorityListeners = new Map<string, Map<Priority, StoredListener<any>[]>>()
  /** 记录每个事件的订阅来源（label → disposer），用于诊断 */
  private subscriptionLabels = new Map<string, Set<string>>()
  private store: EventStoreEngine | null = null

  static getInstance(): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus()
      EventBus.instance.emitter.setMaxListeners(EventBus.MAX_LISTENERS)
    }
    return EventBus.instance
  }

  /** Enable event persistence. Call once at boot before any subscribers. */
  enablePersistence(store: EventStoreEngine): void {
    this.store = store
  }

  on<E extends EventName>(event: E, listener: Listener<E>, labelOrOpts?: string | OnOptions): () => void {
    const opts: OnOptions = typeof labelOrOpts === 'string' ? { label: labelOrOpts } : (labelOrOpts ?? {})
    const priority: Priority = opts.priority ?? 'normal'

    // Track label for diagnostics
    if (opts.label) {
      if (!this.subscriptionLabels.has(event)) this.subscriptionLabels.set(event, new Set())
      this.subscriptionLabels.get(event)!.add(opts.label)
    }

    // Store in priority bucket (not in base emitter — avoid double-fire on emit)
    if (!this.priorityListeners.has(event)) this.priorityListeners.set(event, new Map())
    const buckets = this.priorityListeners.get(event)!
    if (!buckets.has(priority)) buckets.set(priority, [])
    buckets.get(priority)!.push({ listener, label: opts.label, filter: opts.filter })

    const disposer = () => {
      const b = this.priorityListeners.get(event)?.get(priority)
      if (b) {
        const idx = b.findIndex((s) => s.listener === listener)
        if (idx >= 0) b.splice(idx, 1)
      }
    }
    return disposer
  }

  /** Register subscription with auto-cleanup via tracker */
  track<E extends EventName>(event: E, listener: Listener<E>, tracker: SubscriptionTracker, labelOrOpts?: string | OnOptions): void {
    const disposer = this.on(event, listener, labelOrOpts)
    tracker.add(disposer)
  }

  off<E extends EventName>(event: E, listener: Listener<E>): void {
    for (const buckets of this.priorityListeners.get(event)?.values() ?? []) {
      const idx = buckets.findIndex((s) => s.listener === listener)
      if (idx >= 0) buckets.splice(idx, 1)
    }
  }

  once<E extends EventName>(event: E, listener: Listener<E>): () => void {
    this.emitter.once(event, listener)
    return () => {
      this.emitter.off(event, listener)
    }
  }

  emit<E extends EventName>(event: E, payload: EventPayload[E], meta?: EventMeta): void {
    // Persist if store configured
    if (this.store) {
      this.store
        .append({
          channel: event,
          payload: JSON.stringify(payload),
          source: meta?.source ?? null,
          traceId: meta?.traceId ?? null,
          timestamp: Date.now(),
        })
        .catch(() => {})
    }

    // Fire in priority order with optional filter
    const buckets = this.priorityListeners.get(event)
    if (buckets && buckets.size > 0) {
      for (const p of PRIORITY_ORDER) {
        const listeners = buckets.get(p)
        if (!listeners) continue
        for (const stored of listeners) {
          if (stored.filter?.sources && meta?.source && !stored.filter.sources.includes(meta.source)) continue
          try {
            stored.listener(payload)
          } catch (err) {
            console.error(`[EventBus] ${event} handler error (${stored.label || 'unlabeled'}):`, err)
          }
        }
      }
    }

    // Fallback: fire via base emitter for listeners registered outside priority buckets (once())
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
      this.priorityListeners.delete(event)
    } else {
      this.emitter.removeAllListeners()
      this.subscriptionLabels.clear()
      this.priorityListeners.clear()
    }
  }

  listenerCount(event: EventName): number {
    // priority buckets + base emitter, deduplicated
    const priorityCount = Array.from(this.priorityListeners.get(event)?.values() ?? []).reduce((sum, list) => sum + list.length, 0)
    return Math.max(priorityCount, this.emitter.listenerCount(event))
  }

  /** 诊断：当前所有活跃订阅概况 */
  getStats(): Record<string, { count: number; labels: string[]; priorityBuckets: Record<string, number> }> {
    const stats: Record<string, { count: number; labels: string[]; priorityBuckets: Record<string, number> }> = {}
    const events = new Set([...this.emitter.eventNames().map(String), ...this.priorityListeners.keys()])
    for (const event of events) {
      const priorityCount = Array.from(this.priorityListeners.get(event)?.values() ?? []).reduce((sum, list) => sum + list.length, 0)
      const count = Math.max(priorityCount, this.emitter.listenerCount(event))
      const labels = Array.from(this.subscriptionLabels.get(event) || [])
      const buckets: Record<string, number> = {}
      for (const [p, listeners] of this.priorityListeners.get(event) ?? []) buckets[p] = listeners.length
      stats[event] = { count, labels, priorityBuckets: buckets }
    }
    return stats
  }
}

export const eventBus = EventBus.getInstance()
