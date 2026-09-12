/**
 * PlanSchedulerService — Agent 驱动的智能任务调度器主服务
 *
 * 将计划（DevPlan）转化为动态任务队列，自动排序、分配工具并处理依赖。
 *
 * 核心流程：
 *   1. 注册计划 → 读取 PlanManager 中的活跃计划
 *   2. 步骤分析 → PlanStepAnalyzer 用 LLM 分析每步的工具需求和依赖
 *   3. 执行计划 → PlanTaskEngine 状态机跟踪执行
 *   4. 降级处理 → 执行失败时自动重试/回退/需用户确认
 *   5. 反馈收集 → PlanFeedbackStore 收集指标，生成优化建议
 *
 * 设计原则：
 * - 每个 PlanSchedulerService 实例管理一个计划
 * - 通过事件总线向外通信
 * - 依赖注入所有外部服务（PlanManager、LLM、ToolExecutor）
 */

import { eventBus } from '@akemi-mio/core/core/EventBus'
import type { DevPlan } from '@akemi-mio/evolution/types'
import type { ToolResult, ToolScheduler } from '@akemi-mio/intelligence/agent/ToolScheduler'
import type { LlmService } from '@akemi-mio/intelligence/llm/LlmService'

import {
  type PlanTask,
  type PlanExecutionPlan,
  type PlanSchedulerEvent,
  type PlanSchedulerConfig,
  type PlanSchedulerDeps,
  type SchedulerMetrics,
  DEFAULT_SCHEDULER_CONFIG,
} from './types'
import { PlanStepAnalyzer } from './PlanStepAnalyzer'
import { PlanTaskEngine, type ToolExecutor } from './PlanTaskEngine'
import { PlanFeedbackStore } from './PlanFeedbackStore'
import { PlanSnapshotStore } from './PlanSnapshotStore'

// ════════════════════════════════════════════════════════════════
//  ToolExecutor 适配器：将 ToolScheduler 封装为 ToolExecutor
// ════════════════════════════════════════════════════════════════

class ToolSchedulerAdapter implements ToolExecutor {
  private toolScheduler: ToolScheduler

  constructor(toolScheduler: ToolScheduler) {
    this.toolScheduler = toolScheduler
  }

  async executeTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const results = await this.toolScheduler.executeAll([{ id: `sched_${Date.now()}`, name: toolName, arguments: args }])
    return (
      results[0] ?? {
        id: '',
        name: toolName,
        success: false,
        content: '',
        error: 'scheduler returned empty results',
        latencyMs: 0,
      }
    )
  }
}

// ════════════════════════════════════════════════════════════════
//  PlanSchedulerService
// ════════════════════════════════════════════════════════════════

export class PlanSchedulerService {
  /** 当前管理的计划 ID */
  private planId: string | null = null
  /** 计划标题 */
  private planTitle: string = ''
  /** 步骤分析器 */
  private analyzer: PlanStepAnalyzer
  /** 状态机引擎 */
  private engine: PlanTaskEngine | null = null
  /** 反馈存储 */
  private feedbackStore: PlanFeedbackStore
  /** 外部依赖 */
  private deps: PlanSchedulerDeps
  /** 配置 */
  private config: PlanSchedulerConfig
  /** LLM 服务 */
  private llmService: LlmService
  /** 工具调度器 */
  private toolScheduler: ToolScheduler
  /** 快照存储（可选注入） */
  private snapshotStore: PlanSnapshotStore | null = null
  /** 是否启用自动快照 */
  private enableAutoSnapshot: boolean = true

  // ── 事件监听 ──────────────────────────────────────────────
  private eventUnsubscribers: Array<() => void> = []

  constructor(
    llmService: LlmService,
    toolScheduler: ToolScheduler,
    deps: PlanSchedulerDeps,
    config?: Partial<PlanSchedulerConfig>,
    snapshotStore?: PlanSnapshotStore,
  ) {
    this.llmService = llmService
    this.toolScheduler = toolScheduler
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config }
    this.feedbackStore = new PlanFeedbackStore(deps, this.config.feedbackWindowMs)
    this.snapshotStore = snapshotStore ?? null

    // 构造 deps（确保 emitEvent 可用）
    this.deps = {
      ...deps,
      emitEvent: (event: PlanSchedulerEvent) => {
        this.emitEvent(event)
        deps.emitEvent(event)
      },
    }

    this.analyzer = new PlanStepAnalyzer(this.deps, this.config.enableLLMAnalysis)
  }

  // ── 属性 ──────────────────────────────────────────────

  /** 当前管理的计划 ID */
  get currentPlanId(): string | null {
    return this.planId
  }

  /** 当前计划标题 */
  get currentPlanTitle(): string {
    return this.planTitle
  }

  /** 引擎（可能为 null） */
  get taskEngine(): PlanTaskEngine | null {
    return this.engine
  }

  /** 是否正在执行 */
  get isRunning(): boolean {
    return this.engine?.isRunning ?? false
  }

  /** 反馈存储 */
  get feedback(): PlanFeedbackStore {
    return this.feedbackStore
  }

  // ── 事件发射 ──────────────────────────────────────────────

  private emitEvent(event: PlanSchedulerEvent): void {
    const eventName = event.type.replace(/\./g, '_')
    eventBus.emit(`plan_scheduler.${eventName}` as any, event as any)
  }

  // ── 核心流程 ──────────────────────────────────────────────

  /**
   * 从 PlanManager 加载活跃计划并开始调度。
   * 返回生成的执行计划。
   */
  async loadAndSchedule(options?: {
    /** 指定计划 ID（不指定时使用活跃计划） */
    planId?: string
    /** 完成后自动触发执行 */
    autoExecute?: boolean
  }): Promise<PlanExecutionPlan | { error: string }> {
    const plan = options?.planId ? this.deps.planManager.getPlan(options.planId) : this.deps.planManager.getActivePlan()

    if (!plan) {
      return { error: '没有活跃计划可供调度' }
    }

    return this.schedulePlan(plan, options?.autoExecute ?? false)
  }

  /**
   * 调度一个指定计划。
   * 1. 分析所有步骤
   * 2. 构建执行计划（拓扑排序）
   * 3. 初始化引擎
   * 4. 可选：自动开始执行
   */
  async schedulePlan(plan: DevPlan, autoExecute = false): Promise<PlanExecutionPlan> {
    this.planId = plan.id
    this.planTitle = plan.title

    this.deps.log('INFO', 'plan_scheduler_schedule', {
      planId: plan.id,
      title: plan.title,
      steps: plan.steps.length,
      autoExecute,
    })

    this.emitEvent({ type: 'plan.registered', planId: plan.id, planTitle: plan.title })

    // 1. 分析所有步骤
    const stepInputs = plan.steps.map((s, i) => ({
      index: i,
      description: s.description,
    }))

    const analysisResults = await this.analyzer.analyzePlan(plan.id, plan.title, plan.description, stepInputs)

    // 2. 构建执行计划
    const executionPlan = this.buildExecutionPlan(plan, analysisResults)

    this.deps.log('INFO', 'plan_scheduler_execution_plan', {
      planId: plan.id,
      taskCount: executionPlan.tasks.length,
      batchCount: executionPlan.batches.length,
      estimatedTotalSec: executionPlan.estimatedTotalSec,
    })

    // 3. 初始化引擎
    const toolExecutor = new ToolSchedulerAdapter(this.toolScheduler)
    this.engine = new PlanTaskEngine(plan.id, this.deps, toolExecutor, this.config)
    this.engine.initFromPlan(executionPlan)

    // 3a. 尝试从快照恢复（如果存在可用快照）
    // 这允许任务中断后恢复执行上下文
    if (this.snapshotStore) {
      const restored = this.tryRestoreFromSnapshot()
      if (restored) {
        this.deps.log('INFO', 'plan_scheduler_snapshot_restored_state', {
          planId: plan.id,
        })
      }
    }

    // 4. 自动执行
    if (autoExecute) {
      // 使用 setTimeout 延迟执行，避免阻塞当前流程
      setImmediate(() => {
        this.runExecutionLoop().catch((err) => {
          this.deps.log('ERROR', 'plan_scheduler_auto_execute_failed', {
            error: String(err),
          })
        })
      })
    }

    return executionPlan
  }

  /**
   * 构建执行计划。
   * 根据 LLM 分析结果排序步骤、创建任务、计算批次。
   */
  private buildExecutionPlan(plan: DevPlan, analysisResults: import('./types').StepAnalysisResult[]): PlanExecutionPlan {
    // 步骤索引 → 任务 ID 映射（用于依赖解析）
    const indexToTaskId = new Map<number, string>()

    // 使用临时引擎作为任务工厂（只用于 ID 生成和管理）
    const taskFactory = new PlanTaskEngine(
      plan.id,
      this.deps,
      { executeTool: async () => ({ id: '', name: '', success: false, content: '', error: 'pending', latencyMs: 0 }) },
      this.config,
    )

    // 先创建所有任务（无依赖），收集 taskId
    const tasks: PlanTask[] = []
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i]
      const analysis = analysisResults[i]
      const task = taskFactory.createTask(i, step.description, analysis, [], indexToTaskId)
      indexToTaskId.set(i, task.id)
      tasks.push(task)
    }

    // 二次遍历：解析依赖（将 stepIndex 转为 taskId）
    for (const task of tasks) {
      const analysis = analysisResults[task.stepIndex]
      const resolvedDeps = (analysis?.dependsOn ?? [])
        .filter((idx) => indexToTaskId.has(idx) && indexToTaskId.get(idx) !== task.id)
        .map((idx) => indexToTaskId.get(idx)!)
      task.dependsOnTaskIds = resolvedDeps
    }

    // 计算并行批次
    const batches = this.computeBatches(tasks)

    // 估计总时长
    const estimatedTotalSec = analysisResults.reduce((s, a) => s + (a?.estimatedDurationSec ?? 120), 0)

    return {
      planId: plan.id,
      planTitle: plan.title,
      tasks,
      estimatedTotalSec,
      batches,
    }
  }

  /**
   * 计算并行批次（拓扑分层）。
   * 同一批次的步骤可并行执行。
   */
  private computeBatches(tasks: PlanTask[]): PlanTask[][] {
    const taskMap = new Map(tasks.map((t) => [t.id, t]))
    const visited = new Set<string>()
    const batches: PlanTask[][] = []

    while (visited.size < tasks.length) {
      const batch: PlanTask[] = []

      for (const task of tasks) {
        if (visited.has(task.id)) continue
        // 检查所有依赖是否已访问
        const depsReady = task.dependsOnTaskIds.every((depId) => visited.has(depId))
        if (depsReady) {
          batch.push(task)
        }
      }

      if (batch.length === 0) {
        // 防止死循环（如有环依赖）
        this.deps.log('WARN', 'plan_scheduler_batch_stuck', {
          visited: visited.size,
          total: tasks.length,
          remaining: tasks.filter((t) => !visited.has(t.id)).map((t) => t.id),
        })
        break
      }

      for (const task of batch) {
        visited.add(task.id)
      }
      batches.push(batch)
    }

    return batches
  }

  // ── 执行循环 ──────────────────────────────────────────────

  /**
   * 运行执行循环，直到所有任务完成或失败。
   * 每批执行后检查是否有新的可执行任务。
   */
  async runExecutionLoop(): Promise<{
    success: boolean
    summary: string
    metrics: SchedulerMetrics
  }> {
    if (!this.engine) {
      return { success: false, summary: '引擎未初始化', metrics: this.feedbackStore.getMetrics() }
    }

    this.deps.log('INFO', 'plan_scheduler_execution_start', {
      planId: this.planId,
      taskCount: this.engine.getTasks().length,
    })

    this.emitEvent({
      type: 'plan.execution_started',
      planId: this.planId ?? '',
      taskCount: this.engine.getTasks().length,
    })

    const plan = this.planId ? this.deps.planManager.getPlan(this.planId) : undefined

    // 将所有 pending 任务推入 analyzing
    for (const task of this.engine.getTasks()) {
      if (task.state === 'pending') {
        this.engine.transitionTo(task.id, 'analyzing')
      }
    }

    // 执行循环
    let iterations = 0
    const maxIterations = 100 // 安全上限

    while (!this.engine.isAllTerminal() && iterations < maxIterations) {
      iterations++

      // 获取分析就绪的任务 → 使用已有的分析结果选择工具
      const readyForTool = this.engine.getAnalysisReadyTasks()
      for (const task of readyForTool) {
        if (task.analysis && task.analysis.toolSuggestions.length > 0) {
          const best = task.analysis.toolSuggestions[0]
          this.engine.selectTool(task.id, best.toolName, best.expectedArgs)
        } else {
          // 无分析结果时使用通用工具
          this.engine.selectTool(task.id, 'run_command', {})
        }
      }

      // 执行就绪的任务
      if (this.engine.getReadyTasks().length > 0) {
        const { completed, failed } = await this.engine.executeNextBatch()

        this.deps.log('INFO', 'plan_scheduler_batch_complete', {
          planId: this.planId,
          iteration: iterations,
          completed,
          failed,
          remaining: this.engine.getActiveCount(),
        })

        // 自动快照：批次完成后保存执行上下文
        this.createSnapshot('batch_complete')

        // 记录反馈
        const now = Date.now()
        for (const task of this.engine.getTasks()) {
          if (task.state === 'completed' && !task.output) continue
          // 只为刚完成的任务记录
          if (task.completedAt && now - task.completedAt < 5000) {
            this.feedbackStore.record({
              id: `fb_${task.id}_${now}`,
              planId: task.planId,
              stepIndex: task.stepIndex,
              stepDescription: task.description,
              toolUsed: task.activeTool,
              success: task.state === 'completed',
              durationMs: task.durationMs ?? 0,
              retryCount: task.attemptCount,
              wasDegraded: task.state === 'degraded',
              error: task.lastError,
              suggestedTools: task.analysis?.toolSuggestions.map((s) => s.toolName) ?? [],
              userRating: 0,
              createdAt: now,
            })
          }
        }
      } else if (this.engine.getActiveCount() === 0) {
        // 没有活跃任务，但检查是否所有都是终态
        break
      } else {
        // 没有就绪的任务但还有活跃任务 → 等待一小段时间
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }

    // 执行完成
    const summary = this.engine.getSummary()
    const metrics = this.feedbackStore.getMetrics()
    const hasFailures = summary.failed > 0 || summary.cancelled > 0

    // 更新计划状态
    if (plan) {
      if (summary.completed === summary.total) {
        this.deps.planManager.completePlan(plan.id, `调度执行完成: ${summary.completed}/${summary.total} 步骤成功`)
      } else if (hasFailures && summary.completed > 0) {
        // 部分成功 — 不标记完成
        this.deps.log('INFO', 'plan_scheduler_partial', {
          planId: plan.id,
          completed: summary.completed,
          failed: summary.failed,
        })
      }
    }

    this.emitEvent(
      hasFailures
        ? { type: 'plan.execution_failed', planId: this.planId ?? '', error: `${summary.failed} 个步骤失败` }
        : { type: 'plan.execution_completed', planId: this.planId ?? '', success: true },
    )

    this.deps.log('INFO', 'plan_scheduler_execution_done', {
      planId: this.planId,
      summary,
      successRate: `${(metrics.successRate * 100).toFixed(1)}%`,
      suggestionsCount: metrics.suggestions.length,
    })

    // 输出优化建议
    for (const suggestion of metrics.suggestions) {
      this.emitEvent({ type: 'suggestion.generated', suggestion })
    }

    return {
      success: !hasFailures,
      summary: `${summary.completed}/${summary.total} 步骤完成, ${summary.failed} 失败`,
      metrics,
    }
  }

  // ── 外部控制 ──────────────────────────────────────────────

  /**
   * 暂停执行。
   * 暂停前自动创建快照保存当前执行上下文，便于后续恢复。
   * 注意：当前实现使用取消任务，后续可扩展为真正暂停的恢复机制。
   */
  pause(): void {
    if (this.engine) {
      // 自动快照：暂停前保存当前任务状态
      this.createPauseSnapshot()
      this.engine.cancelAll()
      this.deps.log('INFO', 'plan_scheduler_paused', { planId: this.planId })
    }
  }

  /** 获取当前指标 */
  getMetrics(): SchedulerMetrics {
    return this.feedbackStore.getMetrics()
  }

  /** 获取当前计划的执行总结 */
  getSummary(): { total: number; completed: number; failed: number; skipped: number; cancelled: number; remaining: number } | null {
    return this.engine?.getSummary() ?? null
  }

  /** 重置（清除引擎和反馈） */
  reset(): void {
    this.planId = null
    this.planTitle = ''
    this.engine = null
    this.feedbackStore.clear()
    this.deps.log('INFO', 'plan_scheduler_reset', {})
  }

  // ── 快照管理 ──────────────────────────────────────────────

  /**
   * 注入或替换快照存储实例。
   */
  setSnapshotStore(store: PlanSnapshotStore): void {
    this.snapshotStore = store
  }

  /**
   * 启用或禁用自动快照。
   */
  setAutoSnapshot(enabled: boolean): void {
    this.enableAutoSnapshot = enabled
  }

  /**
   * 创建当前引擎状态的快照。
   * 仅在启用了自动快照且有快照存储和引擎时有效。
   *
   * @param reason 快照触发原因
   * @returns 快照条目 ID，或 null
   */
  createSnapshot(reason: import('./types').SnapshotReason): string | null {
    if (!this.enableAutoSnapshot || !this.snapshotStore || !this.engine) {
      return null
    }
    if (!this.planId) return null

    return this.snapshotStore.createSnapshot(this.planId, this.planTitle || '未知计划', this.engine.getTasks(), reason)
  }

  /**
   * 尝试从最近的快照恢复引擎状态。
   * 用于计划中断后恢复执行。
   *
   * @returns 是否成功恢复
   */
  tryRestoreFromSnapshot(): boolean {
    if (!this.snapshotStore || !this.engine || !this.planId) return false

    const snapshotData = this.snapshotStore.restoreLatest(this.planId)
    if (!snapshotData) return false

    // 重建引擎任务状态
    this.engine.importSnapshot(this.planId, snapshotData.tasks)

    this.deps.log('INFO', 'plan_scheduler_restored_from_snapshot', {
      planId: this.planId,
      taskCount: snapshotData.tasks.length,
      snapshotReason: snapshotData.snapshotReason,
    })

    return true
  }

  /**
   * 创建暂停时的快照（等价于 createSnapshot('pause') + 快速别名）。
   */
  private createPauseSnapshot(): void {
    if (this.enableAutoSnapshot && this.snapshotStore && this.engine) {
      this.createSnapshot('pause')
    }
  }
}
