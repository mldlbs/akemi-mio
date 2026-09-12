/**
 * PlanSchedulerCoordinator — 智能并行任务协调器
 *
 * 在 Agent 中维护多计划任务 DAG，自动调度、监控和干预并行执行。
 *
 * 职责：
 * 1. 管理多个 PlanSchedulerService 实例（每个活跃计划一个）
 * 2. 自动加载 PlanManager 中的活跃计划并启动调度
 * 3. 定期心跳检查条件触发和任务就绪
 * 4. 提供对话干预接口（pause/skip/retry/status）
 * 5. 集成事件通知（TTS / 桌面提示）
 * 6. 自动清理已完成/已取消的计划
 *
 * 使用方式：
 * ```ts
 * const coordinator = new PlanSchedulerCoordinator(llmService, toolScheduler, deps)
 * coordinator.autoSync() // 自动同步 PlanManager 中的活跃计划
 * coordinator.startHeartbeat(30_000) // 每 30s 检查一次任务状态
 *
 * // 对话干预
 * await coordinator.pausePlan('plan-123')
 * await coordinator.skipTask('plan-123', 'pt_plan-123_1_xxx')
 * ```
 *
 * 集成方式：
 * - 在 AgentService 初始化时创建并启动
 * - 作为全局单例通过 deps.ts 注入到工具
 * - 事件通知通过 EventBus 传播到 TtsEventNotificationService
 */

import { eventBus } from '@akemi-mio/core/core/EventBus'
import { log } from '@akemi-mio/core/logger/Logger'
import type { LlmService } from '@akemi-mio/intelligence/llm/LlmService'
import type { ToolScheduler } from '@akemi-mio/intelligence/agent/ToolScheduler'
import type { PlanManagerLike, DevPlan } from '@akemi-mio/evolution/types'
import { PlanSchedulerService } from './PlanSchedulerService'
import { PlanSnapshotStore, type PlanSnapshotStoreConfig } from './PlanSnapshotStore'
import { type PlanTask, type PlanExecutionPlan, type PlanSchedulerEvent, type PlanSchedulerConfig } from './types'

// ════════════════════════════════════════════════════════════════
//  类型定义
// ════════════════════════════════════════════════════════════════

/** 计划调度状态快照（供工具返回） */
export interface PlanScheduleStatus {
  planId: string
  planTitle: string
  status: 'running' | 'paused' | 'completed' | 'failed' | 'idle'
  total: number
  completed: number
  failed: number
  skipped: number
  cancelled: number
  remaining: number
  progressPct: number
  lastError: string | null
}

/** 协调器配置 */
export interface CoordinatorConfig {
  /** 心跳间隔（毫秒），默认 30s */
  heartbeatIntervalMs: number
  /** 自动同步间隔（毫秒），默认 60s */
  autoSyncIntervalMs: number
  /** 是否自动加载活跃计划 */
  autoLoadActivePlans: boolean
  /** 是否启用自动通知（TTS/桌面） */
  enableNotifications: boolean
  /** 计划完成后的自动清理延迟（毫秒），默认 5min */
  autoCleanupDelayMs: number
  /** 调度器配置（传递给每个 PlanSchedulerService） */
  schedulerConfig: Partial<PlanSchedulerConfig>
  /** 快照存储配置 */
  snapshotConfig?: Partial<PlanSnapshotStoreConfig>
}

const DEFAULT_COORDINATOR_CONFIG: CoordinatorConfig = {
  heartbeatIntervalMs: 30_000,
  autoSyncIntervalMs: 60_000,
  autoLoadActivePlans: true,
  enableNotifications: true,
  autoCleanupDelayMs: 5 * 60 * 1000,
  schedulerConfig: {},
}

/** 协调器外部依赖 */
export interface CoordinatorDeps {
  planManager: PlanManagerLike
  llmService: { chatJson: (prompt: string, opts?: any) => Promise<{ data?: any; error?: string }> }
  emitEvent: (event: PlanSchedulerEvent) => void
  log: (level: string, msg: string, meta?: Record<string, any>) => void
}

// ════════════════════════════════════════════════════════════════
//  PlanSchedulerCoordinator
// ════════════════════════════════════════════════════════════════

export class PlanSchedulerCoordinator {
  /** 计划 ID → PlanSchedulerService 映射 */
  private schedules = new Map<string, PlanSchedulerService>()
  /** 计划 ID → PlanExecutionPlan（缓存执行计划以供查询） */
  private executionPlans = new Map<string, PlanExecutionPlan>()
  /** LLM 服务（传递给 PlanSchedulerService） */
  private llmService: LlmService
  /** 工具调度器（传递给 PlanSchedulerService） */
  private toolScheduler: ToolScheduler
  /** 协调器依赖 */
  private deps: CoordinatorDeps
  /** 配置 */
  private config: CoordinatorConfig
  /** 快照存储（共享实例，所有计划共用） */
  private snapshotStore: PlanSnapshotStore
  /** 心跳定时器 */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  /** 自动同步定时器 */
  private syncTimer: ReturnType<typeof setInterval> | null = null
  /** 是否已启动 */
  private _started = false
  /** EventBus 订阅清理 */
  private eventUnsubscribers: Array<() => void> = []
  /** 需清理的已完成计划（planId → timeout handle） */
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(llmService: LlmService, toolScheduler: ToolScheduler, deps: CoordinatorDeps, config?: Partial<CoordinatorConfig>) {
    this.llmService = llmService
    this.toolScheduler = toolScheduler
    this.deps = deps
    this.config = { ...DEFAULT_COORDINATOR_CONFIG, ...config }
    this.snapshotStore = new PlanSnapshotStore(this.config.snapshotConfig)
  }

  // ── 属性 ──────────────────────────────────────────────────

  /** 是否已启动 */
  get started(): boolean {
    return this._started
  }

  /** 当前管理的调度数量 */
  get scheduleCount(): number {
    return this.schedules.size
  }

  /** 获取所有活跃的计划 ID */
  get activePlanIds(): string[] {
    return Array.from(this.schedules.keys())
  }

  /** 获取快照存储 */
  get snapshots(): PlanSnapshotStore {
    return this.snapshotStore
  }

  /** 获取指定计划的调度器 */
  getSchedule(planId: string): PlanSchedulerService | undefined {
    return this.schedules.get(planId)
  }

  /** 获取配置（只读副本） */
  getConfig(): CoordinatorConfig {
    return { ...this.config }
  }

  // ── 生命周期 ──────────────────────────────────────────────

  /**
   * 启动协调器。
   * 1. 自动加载 PlanManager 中的活跃计划
   * 2. 启动心跳循环
   * 3. 启动自动同步
   * 4. 订阅事件
   */
  start(): void {
    if (this._started) {
      log('WARN', 'sched_coordinator_already_started')
      return
    }
    this._started = true

    log('INFO', 'sched_coordinator_start', {
      autoLoad: this.config.autoLoadActivePlans,
      heartbeatMs: this.config.heartbeatIntervalMs,
    })

    // 1. 自动加载活跃计划
    if (this.config.autoLoadActivePlans) {
      this.autoSync()
    }

    // 2. 启动心跳
    this.startHeartbeat()

    // 3. 启动自动同步
    if (this.config.autoSyncIntervalMs > 0) {
      this.syncTimer = setInterval(() => {
        this.autoSync().catch((err) => {
          log('WARN', 'sched_coordinator_autosync_error', { error: String(err) })
        })
      }, this.config.autoSyncIntervalMs)
    }

    // 4. 订阅需要通知的事件
    if (this.config.enableNotifications) {
      this.subscribeEvents()
    }

    log('INFO', 'sched_coordinator_started', { scheduleCount: this.scheduleCount })
  }

  /**
   * 停止协调器。
   * 停止所有定时器，取消所有 EventBus 订阅。
   * 不强制停止正在运行的调度（可选择暂停全部）。
   *
   * @param pauseSchedules 是否同时暂停所有调度
   */
  stop(pauseSchedules = false): void {
    if (!this._started) return
    this._started = false

    // 停止心跳
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    // 停止自动同步
    if (this.syncTimer) {
      clearInterval(this.syncTimer)
      this.syncTimer = null
    }

    // 取消清理定时器
    for (const [planId, timer] of this.cleanupTimers) {
      clearTimeout(timer)
      log('INFO', 'sched_coordinator_cleanup_cancelled', { planId })
    }
    this.cleanupTimers.clear()

    // 取消事件订阅
    for (const unsub of this.eventUnsubscribers) {
      try {
        unsub()
      } catch {
        /* ignore */
      }
    }
    this.eventUnsubscribers = []

    // 暂停调度
    if (pauseSchedules) {
      for (const [planId, scheduler] of this.schedules) {
        scheduler.pause()
        log('INFO', 'sched_coordinator_paused_on_stop', { planId })
      }
    }

    log('INFO', 'sched_coordinator_stopped', { pausedSchedules: pauseSchedules })
  }

  // ── 计划管理 ──────────────────────────────────────────────

  /**
   * 自动同步 PlanManager 中的计划。
   * - 加载所有活跃的 'active' 状态计划
   * - 跳过已在调度中的计划
   * - 清理已在调度但 PlanManager 中已不存在的计划
   */
  async autoSync(): Promise<string[]> {
    const plans = this.deps.planManager.listPlans()
    const activePlans = plans.filter((p) => p.status === 'active')
    const loaded: string[] = []

    for (const plan of activePlans) {
      if (this.schedules.has(plan.id)) continue
      const result = await this.schedulePlan(plan)
      if (result && !('error' in result)) {
        loaded.push(plan.id)
      }
    }

    // 清理：调度中存在但 PlanManager 中已非 active 的
    const managerActiveIds = new Set(activePlans.map((p) => p.id))
    for (const [planId] of this.schedules) {
      if (!managerActiveIds.has(planId)) {
        this.removeSchedule(planId, '计划已不再活跃')
      }
    }

    if (loaded.length > 0) {
      log('INFO', 'sched_coordinator_autosync_loaded', {
        loaded: loaded.length,
        total: this.scheduleCount,
        planIds: loaded,
      })
    }

    return loaded
  }

  /**
   * 调度一个计划。
   * 创建 PlanSchedulerService 实例，分析步骤，构建 DAG，可选自动执行。
   *
   * @param plan 要调度的开发计划
   * @param autoExecute 是否自动开始执行
   * @returns 执行计划，或错误信息
   */
  async schedulePlan(plan: DevPlan, autoExecute = true): Promise<PlanExecutionPlan | { error: string }> {
    if (this.schedules.has(plan.id)) {
      return { error: `计划 ${plan.id} 已在调度中` }
    }

    if (plan.steps.length === 0) {
      return { error: `计划 ${plan.id} 没有步骤可执行` }
    }

    log('INFO', 'sched_coordinator_schedule_plan', {
      planId: plan.id,
      title: plan.title,
      steps: plan.steps.length,
      autoExecute,
    })

    try {
      const scheduler = new PlanSchedulerService(
        this.llmService as any,
        this.toolScheduler,
        this.buildSchedulerDeps(),
        this.config.schedulerConfig,
        this.snapshotStore,
      )

      const executionPlan = await scheduler.schedulePlan(plan, autoExecute)
      this.schedules.set(plan.id, scheduler)
      this.executionPlans.set(plan.id, executionPlan)

      // 监听调度完成/失败事件，触发自动清理
      this.watchScheduleCompletion(plan.id, scheduler)

      log('INFO', 'sched_coordinator_plan_scheduled', {
        planId: plan.id,
        tasks: executionPlan.tasks.length,
        batches: executionPlan.batches.length,
      })

      return executionPlan
    } catch (err: any) {
      const errorMsg = `调度计划 ${plan.id} 失败: ${err.message}`
      log('ERROR', 'sched_coordinator_schedule_error', {
        planId: plan.id,
        error: err.message,
      })
      return { error: errorMsg }
    }
  }

  /**
   * 移除一个计划调度。
   * 会先暂停正在运行的调度，然后清理资源。
   */
  private removeSchedule(planId: string, reason: string): boolean {
    const scheduler = this.schedules.get(planId)
    if (!scheduler) return false

    scheduler.pause()
    this.schedules.delete(planId)
    this.executionPlans.delete(planId)

    // 取消待处理的清理定时器
    const timer = this.cleanupTimers.get(planId)
    if (timer) {
      clearTimeout(timer)
      this.cleanupTimers.delete(planId)
    }

    log('INFO', 'sched_coordinator_removed', { planId, reason })
    return true
  }

  // ── 对话干预接口 ──────────────────────────────────────────

  /**
   * 暂停指定计划的执行。
   * 暂停前自动创建快照，方便后续恢复。
   */
  pausePlan(planId: string): { success: boolean; error?: string } {
    const scheduler = this.schedules.get(planId)
    if (!scheduler) return { success: false, error: `计划 ${planId} 未在调度中` }
    if (!scheduler.isRunning) return { success: false, error: `计划 ${planId} 不在运行状态` }

    scheduler.pause()
    log('INFO', 'sched_coordinator_paused', { planId })
    return { success: true }
  }

  /**
   * 恢复指定计划的执行（从快照重建并重新执行）。
   * 当前 PlanSchedulerService 的 pause 会 cancel 所有任务，
   * 因此恢复需要重新调度（从快照恢复状态）。
   */
  async resumePlan(planId: string): Promise<{ success: boolean; error?: string }> {
    const plan = this.deps.planManager.getPlan(planId)
    if (!plan) return { success: false, error: `计划 ${planId} 不存在` }

    // 先移除旧的调度
    this.removeSchedule(planId, '重新调度以恢复')

    // 重新调度（快照恢复在 PlanSchedulerService.schedulePlan 内部自动处理）
    const result = await this.schedulePlan(plan, true)
    if ('error' in result) {
      return { success: false, error: result.error }
    }

    log('INFO', 'sched_coordinator_resumed', { planId })
    return { success: true }
  }

  /**
   * 跳过指定计划的特定任务。
   * 将任务状态设为 'skipped'，引擎会自动推进到下一个就绪任务。
   */
  skipTask(planId: string, taskId: string): { success: boolean; error?: string } {
    const scheduler = this.schedules.get(planId)
    if (!scheduler) return { success: false, error: `计划 ${planId} 未在调度中` }
    const engine = scheduler.taskEngine
    if (!engine) return { success: false, error: `计划 ${planId} 引擎未初始化` }

    const task = engine.getTask(taskId)
    if (!task) return { success: false, error: `任务 ${taskId} 不存在` }
    if (task.state === 'completed' || task.state === 'skipped' || task.state === 'cancelled') {
      return { success: false, error: `任务 ${taskId} 已是终态 (${task.state})` }
    }

    const ok = engine.skipTask(taskId)
    if (!ok) return { success: false, error: `跳过任务 ${taskId} 失败（状态转换非法）` }

    log('INFO', 'sched_coordinator_skipped', { planId, taskId, description: task.description })
    return { success: true }
  }

  /**
   * 重试指定计划的失败任务。
   * 将任务从 'failed' 状态重置为 'pending'，然后引擎重新尝试。
   */
  retryTask(planId: string, taskId: string): { success: boolean; error?: string } {
    const scheduler = this.schedules.get(planId)
    if (!scheduler) return { success: false, error: `计划 ${planId} 未在调度中` }
    const engine = scheduler.taskEngine
    if (!engine) return { success: false, error: `计划 ${planId} 引擎未初始化` }

    const task = engine.getTask(taskId)
    if (!task) return { success: false, error: `任务 ${taskId} 不存在` }
    if (task.state !== 'failed') {
      return { success: false, error: `任务 ${taskId} 状态为 ${task.state}，仅允许重试已失败的任务` }
    }

    // 将失败任务重置为 pending，引擎会重新分析和执行
    // 注：PlanTaskEngine 不直接支持 failed → pending，但我们可以通过重新调度任务来实现
    // 这里采用 state 机迂回：先清除旧状态，让引擎重新处理
    const ok = engine.transitionTo(taskId, 'analyzing')
    if (!ok) return { success: false, error: `重试任务 ${taskId} 失败（状态转换失败）` }

    task.attemptCount = 0
    task.lastError = null

    log('INFO', 'sched_coordinator_retried', { planId, taskId, description: task.description })
    return { success: true }
  }

  /**
   * 确认指定计划的待确认任务。
   * 将 'needs_confirm' 状态的任务转换为 'executing'。
   */
  confirmTask(planId: string, taskId: string): { success: boolean; error?: string } {
    const scheduler = this.schedules.get(planId)
    if (!scheduler) return { success: false, error: `计划 ${planId} 未在调度中` }
    const engine = scheduler.taskEngine
    if (!engine) return { success: false, error: `计划 ${planId} 引擎未初始化` }

    const task = engine.getTask(taskId)
    if (!task) return { success: false, error: `任务 ${taskId} 不存在` }
    if (task.state !== 'needs_confirm') {
      return { success: false, error: `任务 ${taskId} 状态为 ${task.state}，无需确认` }
    }

    const ok = engine.confirmExecution(taskId)
    if (!ok) return { success: false, error: `确认任务 ${taskId} 执行失败` }

    log('INFO', 'sched_coordinator_confirmed', { planId, taskId })
    return { success: true }
  }

  /**
   * 获取所有活跃计划的调度状态。
   * 返回 PlanScheduleStatus 数组，供工具返回给用户。
   */
  getAllStatuses(): PlanScheduleStatus[] {
    const statuses: PlanScheduleStatus[] = []

    for (const [planId, scheduler] of this.schedules) {
      const plan = this.deps.planManager.getPlan(planId)
      const summary = scheduler.getSummary()

      let status: PlanScheduleStatus['status'] = 'idle'
      if (scheduler.isRunning) status = 'running'
      else if (summary && summary.completed === summary.total) status = 'completed'
      else if (summary && summary.failed > 0) status = 'failed'
      else if (summary && summary.cancelled > 0) status = 'failed'
      else if (!scheduler.isRunning && summary) status = 'paused'

      const completed = summary?.completed ?? 0
      const total = summary?.total ?? 0

      statuses.push({
        planId,
        planTitle: scheduler.currentPlanTitle || plan?.title || '未知计划',
        status,
        total,
        completed,
        failed: summary?.failed ?? 0,
        skipped: summary?.skipped ?? 0,
        cancelled: summary?.cancelled ?? 0,
        remaining: summary?.remaining ?? 0,
        progressPct: total > 0 ? Math.round((completed / total) * 100) : 0,
        lastError: null,
      })
    }

    return statuses.sort((a, b) => b.progressPct - a.progressPct)
  }

  /**
   * 获取指定计划的详细状态（含任务列表）。
   */
  getPlanDetail(planId: string): { status: PlanScheduleStatus | null; tasks: PlanTask[]; error?: string } {
    const scheduler = this.schedules.get(planId)
    if (!scheduler) return { status: null, tasks: [], error: `计划 ${planId} 未在调度中` }
    const engine = scheduler.taskEngine
    if (!engine) return { status: null, tasks: [], error: `计划 ${planId} 引擎未初始化` }

    const status = this.getAllStatuses().find((s) => s.planId === planId) ?? null
    return { status, tasks: engine.getTasks() }
  }

  // ── 心跳 ──────────────────────────────────────────────────

  /**
   * 启动心跳定时器，定期检查任务就绪状态。
   * 心跳检测到新就绪任务时自动推动执行引擎。
   */
  startHeartbeat(intervalMs?: number): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
    }

    const ms = intervalMs ?? this.config.heartbeatIntervalMs
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat().catch((err) => {
        log('WARN', 'sched_coordinator_heartbeat_error', { error: String(err) })
      })
    }, ms)

    log('INFO', 'sched_coordinator_heartbeat_started', { intervalMs: ms })
  }

  /**
   * 停止心跳定时器。
   */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
      log('INFO', 'sched_coordinator_heartbeat_stopped')
    }
  }

  /**
   * 单次心跳：检查所有正在运行的调度，
   * 对仍有 pending/analyzing 任务的调度自动触发执行循环。
   */
  private async heartbeat(): Promise<void> {
    for (const [planId, scheduler] of this.schedules) {
      if (!scheduler.isRunning) continue

      const engine = scheduler.taskEngine
      if (!engine) continue

      const summary = engine.getSummary()
      if (summary.remaining === 0) continue

      // 检查是否有 analyzing 任务等待工具选择，或 tool_selected 任务等待执行
      const hasReady = engine.getAnalysisReadyTasks().length > 0 || engine.getReadyTasks().length > 0 || engine.getPendingTasks().length > 0

      if (hasReady) {
        log('INFO', 'sched_coordinator_heartbeat_push', {
          planId,
          pending: engine.getPendingTasks().length,
          analyzing: engine.getAnalysisReadyTasks().length,
          ready: engine.getReadyTasks().length,
        })

        // 触发执行循环（非阻塞）
        scheduler.runExecutionLoop().catch((err) => {
          log('WARN', 'sched_coordinator_heartbeat_exec_err', {
            planId,
            error: String(err),
          })
        })
      }
    }
  }

  // ── 事件管理 ──────────────────────────────────────────────

  /**
   * 订阅计划调度相关事件，用于通知和日志。
   */
  private subscribeEvents(): void {
    // 任务完成通知
    const unsub1 = eventBus.on(
      'plan_scheduler.task_completed' as any,
      (payload: any) => {
        log('INFO', 'sched_coordinator_task_done', {
          planId: payload.planId,
          taskId: payload.taskId,
          durationMs: payload.durationMs,
        })
      },
      { priority: 'low', label: 'sched_coordinator:task_completed' },
    )
    this.eventUnsubscribers.push(unsub1)

    // 任务失败通知
    const unsub2 = eventBus.on(
      'plan_scheduler.task_failed' as any,
      (payload: any) => {
        log('WARN', 'sched_coordinator_task_failed', {
          planId: payload.planId,
          taskId: payload.taskId,
          error: payload.error,
          attempt: payload.attempt,
        })
      },
      { priority: 'normal', label: 'sched_coordinator:task_failed' },
    )
    this.eventUnsubscribers.push(unsub2)

    // 任务需人工确认
    const unsub3 = eventBus.on(
      'plan_scheduler.task_needs_confirm' as any,
      (payload: any) => {
        log('WARN', 'sched_coordinator_task_needs_confirm', {
          planId: payload.planId,
          taskId: payload.taskId,
          issue: payload.issue,
        })
      },
      { priority: 'normal', label: 'sched_coordinator:needs_confirm' },
    )
    this.eventUnsubscribers.push(unsub3)

    // 降级通知
    const unsub4 = eventBus.on(
      'plan_scheduler.task_degraded' as any,
      (payload: any) => {
        log('INFO', 'sched_coordinator_task_degraded', {
          planId: payload.planId,
          taskId: payload.taskId,
          fallbackTool: payload.fallbackTool,
          reason: payload.reason,
        })
      },
      { priority: 'low', label: 'sched_coordinator:degraded' },
    )
    this.eventUnsubscribers.push(unsub4)
  }

  // ── 自动清理 ──────────────────────────────────────────────

  /**
   * 监听计划完成事件，延迟后自动清理。
   */
  private watchScheduleCompletion(planId: string, _scheduler: PlanSchedulerService): void {
    const unsub = eventBus.on(
      'plan_scheduler.plan_execution_completed' as any,
      (payload: any) => {
        if (payload.planId !== planId) return
        this.scheduleCleanup(planId, '执行完成')
      },
      { priority: 'low', label: `sched_coordinator:watch_${planId}` },
    )
    this.eventUnsubscribers.push(unsub)

    const unsub2 = eventBus.on(
      'plan_scheduler.plan_execution_failed' as any,
      (payload: any) => {
        if (payload.planId !== planId) return
        this.scheduleCleanup(planId, `执行失败: ${payload.error}`)
      },
      { priority: 'low', label: `sched_coordinator:watch_fail_${planId}` },
    )
    this.eventUnsubscribers.push(unsub2)
  }

  /**
   * 延迟后自动清理已完成/失败的计划。
   * 用户可通过对话干预取消自动清理。
   */
  private scheduleCleanup(planId: string, reason: string): void {
    if (this.cleanupTimers.has(planId)) return

    const timer = setTimeout(() => {
      this.cleanupTimers.delete(planId)
      this.removeSchedule(planId, `自动清理: ${reason}`)
    }, this.config.autoCleanupDelayMs)

    this.cleanupTimers.set(planId, timer)

    log('INFO', 'sched_coordinator_cleanup_scheduled', {
      planId,
      reason,
      delayMs: this.config.autoCleanupDelayMs,
    })
  }

  // ── 辅助方法 ──────────────────────────────────────────────

  /**
   * 构建传递给 PlanSchedulerService 的 deps。
   * 包装协调器的 emitEvent/log 以加入调度器前缀追踪。
   */
  private buildSchedulerDeps(): CoordinatorDeps {
    return {
      planManager: this.deps.planManager,
      llmService: this.deps.llmService,
      emitEvent: (event: PlanSchedulerEvent) => {
        this.deps.emitEvent(event)
      },
      log: (level: string, msg: string, meta?: Record<string, any>) => {
        this.deps.log(level, `[coordinator] ${msg}`, meta)
      },
    }
  }
}
