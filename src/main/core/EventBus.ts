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
  | 'agent.plan.focus_switched'
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
  | 'behavior.state.updated'
  | 'behavior.mode.switch'
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

  // ── Pipeline 可观测性事件 ──
  | 'pipeline.collector.executed'

  // ── 干预生命周期事件 ──
  | 'intervention.started'
  | 'intervention.completed'
  | 'workflow.run.created'
  | 'workflow.run.updated'
  | 'workflow.run.step'
  | 'workflow.def.created'

  // ── Wallpaper 事件（版本化 Schema，用于 Wallpaper ↔ Plan 事件总线） ──
  | 'wallpaper.mode.changed'
  | 'wallpaper.config.changed'
  | 'wallpaper.lock.changed'
  | 'wallpaper.css.reloaded'

  // ── Memory 状态变更事件（用于 Wallpaper 信息浮层实时更新） ──
  | 'memory.entry.created'
  | 'memory.entry.updated'
  | 'memory.entry.deleted'
  | 'memory.context.changed'

  // ── Plan:TypeScript 学习计划事件（版本化 Schema，用于 Wallpaper ↔ Plan 事件总线） ──
  | 'plan.ts.step.completed'
  | 'plan.ts.difficulty.recorded'
  | 'plan.ts.strategy.adjusted'
  | 'plan.ts.progress.updated'
  | 'plan.ts.focus.synced'

  // ── MCP ↔ UserBehavior 强化回路事件 ──
  | 'feedback_loop.state_changed'
  | 'feedback_loop.parameter_adjusted'
  | 'evidence.report.ready'

  // ── Radar 推送事件（雷达合并领域，版本化 Schema） ──
  | 'radar.push.rule_fired'
  | 'radar.push.completed'

  // ── 工业颂歌修正事件（版本化 Schema） ──
  | 'songge.correction.ready'
  | 'songge.correction.applied'

  // ── 博客分析事件（版本化 Schema） ──
  | 'blog.analytics.report.ready'
  | 'blog.analytics.strategy.adjusted'

  // ── Plan Scheduler 事件（Agent 驱动的智能调度器） ──
  | 'plan_scheduler.plan_registered'
  | 'plan_scheduler.plan_execution_started'
  | 'plan_scheduler.plan_execution_completed'
  | 'plan_scheduler.plan_execution_failed'
  | 'plan_scheduler.task_state_changed'
  | 'plan_scheduler.task_tool_selected'
  | 'plan_scheduler.task_executing'
  | 'plan_scheduler.task_completed'
  | 'plan_scheduler.task_failed'
  | 'plan_scheduler.task_degraded'
  | 'plan_scheduler.task_needs_confirm'
  | 'plan_scheduler.feedback_collected'
  | 'plan_scheduler.suggestion_generated'

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
  'agent.plan.step': { planId: string; stepIndex: number; status: string; result?: string }
  'agent.plan.completed': { planId: string }
  'agent.plan.focus_switched': { planId: string; planTitle: string; status: string; stepCount: number; doneCount: number }
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
  'behavior.state.updated': {
    activityState: string
    fullscreen: boolean
    focused: boolean
    appCategory: string
    windowTitle: string
    idleTimeMs: number
  }
  'behavior.mode.switch': {
    fromMode: string
    toMode: string
    reason: string
    confidence: number
    timestamp: number
  }
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
  'workflow.def.created'

  // ── Wallpaper 事件（版本化 Schema，用于 Wallpaper ↔ Plan 事件总线） ──
  'wallpaper.mode.changed'
  'wallpaper.config.changed'
  'wallpaper.lock.changed'
  'wallpaper.css.reloaded'

  // ── Plan:TypeScript 学习计划事件（版本化 Schema，用于 Wallpaper ↔ Plan 事件总线） ──
  'plan.ts.step.completed'
  'plan.ts.difficulty.recorded'
  'plan.ts.strategy.adjusted'
  'plan.ts.progress.updated'
  'plan.ts.focus.synced': { workflowDefId: string; name: string }
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

  // ── Wallpaper 事件（版本化 Schema） ──

  /** 壁纸行为模式变化：version=1 时包含模式、情境和置信度 */
  'wallpaper.mode.changed': {
    version: 1
    mode: 'focus' | 'multitasking' | 'break'
    context: 'coding' | 'browsing' | 'resting'
    confidence: number
    timestamp: number
  }

  /** 壁纸配置变化：version=1 时包含变更字段列表 */
  'wallpaper.config.changed': {
    version: 1
    changes: Array<{ key: string; oldValue: unknown; newValue: unknown }>
    timestamp: number
  }

  /** 壁纸进化锁定状态切换：version=1 时包含锁定状态 */
  'wallpaper.lock.changed': {
    version: 1
    locked: boolean
    previous: boolean
    timestamp: number
  }

  /** 壁纸 CSS 热重载：version=1 时包含 CSS 元信息 */
  'wallpaper.css.reloaded': {
    version: 1
    filename: string
    cssSize: number
    timestamp: number
  }

  // ── Memory 状态变更事件（版本化 Schema，用于 Wallpaper 信息浮层实时更新） ──

  /** 记忆条目创建：version=1 时包含条目 ID、类型、内容片段和层级 */
  'memory.entry.created': {
    version: 1
    entryId: string
    type: string
    contentSnippet: string
    tier: string
    timestamp: number
  }

  /** 记忆条目更新（强化/晋升/降级）：version=1 时包含变更字段和旧值 */
  'memory.entry.updated': {
    version: 1
    entryId: string
    type: string
    contentSnippet: string
    tier: string
    changes: Array<{ field: string; oldValue?: unknown; newValue?: unknown }>
    timestamp: number
  }

  /** 记忆条目删除：version=1 时包含条目 ID */
  'memory.entry.deleted': {
    version: 1
    entryId: string
    type: string
    contentSnippet: string
    tier: string
    timestamp: number
  }

  /** 记忆上下文变更（批量操作/修剪/清理后触发）：version=1 时包含统计信息 */
  'memory.context.changed': {
    version: 1
    totalEntries: number
    tiers: Record<string, number>
    timestamp: number
  }

  // ── Plan:TypeScript 学习计划事件（版本化 Schema） ──

  /** 学习步骤完成：version=1 时包含步骤描述、成功状态和涉及知识点 */
  'plan.ts.step.completed': {
    version: 1
    stepDescription: string
    success: boolean
    concepts?: string[]
    focusCategories?: string[]
    timestamp: number
  }

  /** 困难记录：version=1 时包含知识点名称、描述和当前频次 */
  'plan.ts.difficulty.recorded': {
    version: 1
    conceptName: string
    description: string
    frequency: number
    category: string
    timestamp: number
  }

  /** 学习策略调整：version=1 时包含策略列表和触发原因 */
  'plan.ts.strategy.adjusted': {
    version: 1
    strategies: Array<{ type: string; description: string }>
    triggerReason: string
    timestamp: number
  }

  /** 学习进度更新：version=1 时包含掌握度和各项统计数据 */
  'plan.ts.progress.updated': {
    version: 1
    overallMastery: number
    masteredCount: number
    learningCount: number
    totalItems: number
    overallAccuracy: number
    timestamp: number
  }

  /** 学习焦点同步：version=1 时包含当前关注的分类和步骤信息 */
  'plan.ts.focus.synced': {
    version: 1
    focusCategories: string[]
    recentConcepts: string[]
    currentStepDescription?: string
    timestamp: number
  }

  // ── MCP ↔ UserBehavior 强化回路事件 ──
  'feedback_loop.state_changed': {
    mode: 'monitor' | 'auto'
    convergenceState: 'diverging' | 'exploring' | 'converging' | 'converged'
    totalAdjustments: number
    totalObservations: number
    dampingFactor: number
  }
  'feedback_loop.parameter_adjusted': {
    type: string
    previousValue: number
    newValue: number
    dampingFactor: number
    reason: string
  }
  'evidence.report.ready': {
    reportId: string
    report: any
    generatedAt: number
  }

  // ── Radar 推送事件（版本化 Schema） ──
  'radar.push.rule_fired': {
    version: 1
    ruleId: string
    ruleName: string
    message: string
    signalCount: number
    timestamp: number
  }
  'radar.push.completed': {
    version: 1
    ruleId: string
    success: boolean
    messageLength: number
    durationMs: number
    error?: string
    timestamp: number
  }

  // ── 工业颂歌修正事件（版本化 Schema） ──
  'songge.correction.ready': {
    version: 1
    compositeScore: number
    totalIssues: number
    chaptersNeedingFix: number
    severity: 'critical' | 'major' | 'minor' | 'info'
    timestamp: number
  }
  'songge.correction.applied': {
    version: 1
    fixedIssues: number
    remainingIssues: number
    newCompositeScore: number
    timestamp: number
  }

  // ── 博客分析事件（版本化 Schema） ──
  'blog.analytics.report.ready': {
    version: 1
    totalPosts: number
    platforms: string[]
    overallAvgViews: number
    overallAvgEngagementRate: number
    hasSufficientData: boolean
    insights: string[]
    timestamp: number
  }
  'blog.analytics.strategy.adjusted': {
    version: 1
    dataDriven: boolean
    recommendedTopics: string[]
    adjustmentCount: number
    avoidTopics: string[]
    timestamp: number
  }

  // ── Plan Scheduler 事件（Agent 驱动的智能调度器） ──
  'plan_scheduler.plan_registered': {
    planId: string
    planTitle: string
  }
  'plan_scheduler.plan_execution_started': {
    planId: string
    taskCount: number
  }
  'plan_scheduler.plan_execution_completed': {
    planId: string
    success: boolean
  }
  'plan_scheduler.plan_execution_failed': {
    planId: string
    error: string
  }
  'plan_scheduler.task_state_changed': {
    taskId: string
    planId: string
    from: string
    to: string
  }
  'plan_scheduler.task_tool_selected': {
    taskId: string
    toolName: string
  }
  'plan_scheduler.task_executing': {
    taskId: string
    toolName: string
  }
  'plan_scheduler.task_completed': {
    taskId: string
    planId: string
    durationMs: number
  }
  'plan_scheduler.task_failed': {
    taskId: string
    planId: string
    error: string
    attempt: number
  }
  'plan_scheduler.task_degraded': {
    taskId: string
    planId: string
    fallbackTool: string
    reason: string
  }
  'plan_scheduler.task_needs_confirm': {
    taskId: string
    planId: string
    issue: string
  }
  'plan_scheduler.feedback_collected': {
    planId: string
    stepIndex: number
    toolUsed: string | null
    success: boolean
    durationMs: number
  }
  'plan_scheduler.suggestion_generated': {
    suggestion: string
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
