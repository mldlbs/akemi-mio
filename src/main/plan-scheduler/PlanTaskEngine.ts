/**
 * PlanTaskEngine — 计划任务状态机执行引擎
 *
 * 职责：
 * 1. 管理 PlanTask 生命周期（状态机迁移）
 * 2. 解析依赖图决定可执行任务
 * 3. 分发工具调用并收集结果
 * 4. 实现降级策略（重试 → 回退工具 → 用户确认）
 * 5. 生成反馈数据供优化
 *
 * 状态机流转：
 *   pending → analyzing → tool_selected → executing → completed
 *                                   ↕              ↘ failed → analyzing (重试)
 *                                   ↕                       ↘ degraded → executing
 *                                   ↕                       ↘ needs_confirm → executing
 *                                   ↕                       ↘ skipped/cancelled
 *                                   ↕                           （终态）
 *                                   ↕分析失败 → failed
 *                                   ↕
 *                               cancelled（随时可取消）
 *
 * 与 ToolScheduler 的关系：
 * - 本引擎负责"做什么"和"何时做"
 * - ToolScheduler 负责"怎么做"（并发、超时、降级）
 * - 本引擎将工具调用委托给 ToolScheduler
 */

import {
  type PlanTask,
  type PlanTaskState,
  type PlanExecutionPlan,
  type PlanSchedulerDeps,
  type SerializedTaskSnapshot,
  VALID_STATE_TRANSITIONS,
  DEFAULT_SCHEDULER_CONFIG,
  type PlanSchedulerConfig,
} from './types'
import { type ToolResult } from '../agent/ToolScheduler'

// ════════════════════════════════════════════════════════════════
//  辅助：工具调用接口（适配 ToolScheduler 或 Mock）
// ════════════════════════════════════════════════════════════════

export interface ToolExecutor {
  executeTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult>
}

// ════════════════════════════════════════════════════════════════
//  PlanTaskEngine
// ════════════════════════════════════════════════════════════════

export class PlanTaskEngine {
  private tasks = new Map<string, PlanTask>()
  private deps: PlanSchedulerDeps
  private config: PlanSchedulerConfig
  private toolExecutor: ToolExecutor
  private running = false
  private taskIdCounter = 0
  private planId: string

  constructor(
    planId: string,
    deps: PlanSchedulerDeps,
    toolExecutor: ToolExecutor,
    config?: Partial<PlanSchedulerConfig>,
  ) {
    this.planId = planId
    this.deps = deps
    this.toolExecutor = toolExecutor
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config }
  }

  /** 当前计划 ID */
  get plan(): string {
    return this.planId
  }

  /** 是否正在运行 */
  get isRunning(): boolean {
    return this.running
  }

  /** 获取所有任务 */
  getTasks(): PlanTask[] {
    return Array.from(this.tasks.values())
  }

  /** 获取指定任务 */
  getTask(taskId: string): PlanTask | undefined {
    return this.tasks.get(taskId)
  }

  /** 获取活跃（未终态）任务数 */
  getActiveCount(): number {
    const terminal = new Set<PlanTaskState>(['completed', 'skipped', 'cancelled', 'failed'])
    return Array.from(this.tasks.values()).filter((t) => !terminal.has(t.state)).length
  }

  /** 获取已完成的步数 */
  getCompletedCount(): number {
    return Array.from(this.tasks.values()).filter((t) => t.state === 'completed').length
  }

  // ── 任务创建 ──────────────────────────────────────────────

  /**
   * 从执行计划创建内部任务跟踪。
   * 返回创建的任务列表。
   */
  initFromPlan(plan: PlanExecutionPlan): PlanTask[] {
    this.tasks.clear()
    this.taskIdCounter = 0

    // 先构建索引映射
    const indexToTaskId = new Map<number, string>()
    for (const task of plan.tasks) {
      indexToTaskId.set(task.stepIndex, task.id)
    }

    // 增强依赖（将 stepIndex 转为 taskId）
    for (const task of plan.tasks) {
      const resolvedDepIds = (task.analysis?.dependsOn ?? [])
        .filter((idx) => indexToTaskId.has(idx) && indexToTaskId.get(idx) !== task.id)
        .map((idx) => indexToTaskId.get(idx)!)
      task.dependsOnTaskIds = resolvedDepIds
      this.tasks.set(task.id, task)
    }

    this.deps.log('INFO', 'plan_engine_init', {
      planId: this.planId,
      taskCount: this.tasks.size,
    })

    return this.getTasks()
  }

  /** 生成唯一任务 ID */
  private nextTaskId(): string {
    return `pt_${this.planId}_${++this.taskIdCounter}_${Date.now().toString(36)}`
  }

  // ── 状态机操作 ──────────────────────────────────────────────

  /**
   * 迁移任务状态。
   * 校验迁移合法性，返回是否成功。
   */
  transitionTo(taskId: string, newState: PlanTaskState): boolean {
    const task = this.tasks.get(taskId)
    if (!task) return false

    const current = task.state
    const allowed = VALID_STATE_TRANSITIONS[current]
    if (!allowed.includes(newState)) {
      this.deps.log('WARN', 'plan_engine_invalid_transition', {
        taskId,
        from: current,
        to: newState,
        allowed,
      })
      return false
    }

    const oldState = task.state
    task.state = newState

    // 时间戳追踪
    if (newState === 'executing' && !task.startedAt) {
      task.startedAt = Date.now()
    }
    if (newState === 'completed' || newState === 'failed' || newState === 'skipped' || newState === 'cancelled') {
      task.completedAt = Date.now()
      if (task.startedAt) {
        task.durationMs = task.completedAt - task.startedAt
      }
    }

    this.deps.emitEvent({
      type: 'task.state_changed',
      taskId,
      planId: this.planId,
      from: oldState,
      to: newState,
    })

    this.deps.log('INFO', 'plan_engine_transition', {
      taskId,
      from: oldState,
      to: newState,
      stepIndex: task.stepIndex,
    })

    return true
  }

  // ── 调度决策 ──────────────────────────────────────────────

  /**
   * 获取当前可以执行的任务列表。
   * 条件：状态为 tool_selected，且所有依赖已完成。
   */
  getReadyTasks(): PlanTask[] {
    const completedIds = new Set(
      Array.from(this.tasks.values())
        .filter((t) => t.state === 'completed')
        .map((t) => t.id),
    )

    return Array.from(this.tasks.values()).filter((t) => {
      if (t.state !== 'tool_selected') return false
      // 所有依赖必须已完成
      return t.dependsOnTaskIds.every((depId) => completedIds.has(depId))
    })
  }

  /**
   * 获取等待分析的任务列表。
   */
  getPendingTasks(): PlanTask[] {
    return Array.from(this.tasks.values()).filter((t) => t.state === 'pending')
  }

  /**
   * 获取等待工具选择的任务列表。
   */
  getAnalysisReadyTasks(): PlanTask[] {
    const completedIds = new Set(
      Array.from(this.tasks.values())
        .filter((t) => t.state === 'completed')
        .map((t) => t.id),
    )

    return Array.from(this.tasks.values()).filter((t) => {
      if (t.state !== 'analyzing') return false
      return t.dependsOnTaskIds.every((depId) => completedIds.has(depId))
    })
  }

  /**
   * 创建一个任务。
   * 自动设置依赖的 taskId。
   */
  createTask(
    stepIndex: number,
    description: string,
    analysis: import('./types').StepAnalysisResult | null,
    dependsOnStepIndices: number[],
    indexToTaskId: Map<number, string>,
  ): PlanTask {
    const id = this.nextTaskId()
    const resolvedDepIds = dependsOnStepIndices
      .filter((idx) => indexToTaskId.has(idx))
      .map((idx) => indexToTaskId.get(idx)!)

    const task: PlanTask = {
      id,
      planId: this.planId,
      stepIndex,
      description,
      state: 'pending',
      analysis,
      activeTool: analysis?.toolSuggestions[0]?.toolName ?? null,
      activeArgs: analysis?.toolSuggestions[0]?.expectedArgs ?? null,
      attemptCount: 0,
      maxAttempts: this.config.maxRetriesPerStep,
      lastError: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      durationMs: null,
      dependsOnTaskIds: resolvedDepIds,
      output: null,
    }

    this.tasks.set(id, task)
    return task
  }

  // ── 执行循环 ──────────────────────────────────────────────

  /**
   * 异步执行准备就绪的任务。
   * 同时执行多个任务（受 maxConcurrency 限制）。
   */
  async executeNextBatch(): Promise<{ completed: number; failed: number }> {
    const ready = this.getReadyTasks()
    if (ready.length === 0) return { completed: 0, failed: 0 }

    const batch = ready.slice(0, this.config.maxConcurrency)
    this.deps.log('INFO', 'plan_engine_batch', {
      planId: this.planId,
      batchSize: batch.length,
      remaining: ready.length - batch.length,
    })

    let completed = 0
    let failed = 0

    await Promise.all(
      batch.map(async (task) => {
        const result = await this.executeTask(task)
        if (result) completed++
        else failed++
      }),
    )

    return { completed, failed }
  }

  /**
   * 执行单个任务。
   * 包含完整的降级链路。
   */
  private async executeTask(task: PlanTask): Promise<boolean> {
    if (!this.transitionTo(task.id, 'executing')) return false

    const toolName = task.activeTool || 'run_command'
    const args = task.activeArgs || {}

    this.deps.emitEvent({
      type: 'task.executing',
      taskId: task.id,
      toolName,
    })

    try {
      const result = await this.toolExecutor.executeTool(toolName, args)

      if (result.success) {
        task.output = result.content
        task.attemptCount = 0
        this.transitionTo(task.id, 'completed')
        this.deps.emitEvent({
          type: 'task.completed',
          taskId: task.id,
          planId: this.planId,
          durationMs: result.latencyMs,
        })
        return true
      }

      // 工具执行失败 → 降级链路
      return this.handleExecutionFailure(task, result)
    } catch (err: any) {
      return this.handleExecutionFailure(task, {
        id: task.id,
        name: toolName,
        success: false,
        content: '',
        error: err.message,
        latencyMs: 0,
      })
    }
  }

  /**
   * 处理执行失败 — 降级策略链路。
   *
   * 链路：
   *   1. 尝试重试（未达 maxAttempts）
   *   2. 尝试使用备选工具（degraded）
   *   3. 需要用户确认（needs_confirm）
   *   4. 标记为 failed
   */
  private async handleExecutionFailure(task: PlanTask, result: ToolResult): Promise<boolean> {
    task.lastError = result.error || '未知错误'
    task.attemptCount++

    this.deps.emitEvent({
      type: 'task.failed',
      taskId: task.id,
      planId: this.planId,
      error: result.error || 'unknown',
      attempt: task.attemptCount,
    })

    this.deps.log('WARN', 'plan_engine_task_failed', {
      taskId: task.id,
      stepIndex: task.stepIndex,
      tool: result.name,
      error: result.error,
      attempt: task.attemptCount,
      maxAttempts: task.maxAttempts,
    })

    // 1. 尝试重试（未达上限且是暂时性错误）
    if (task.attemptCount <= task.maxAttempts) {
      this.deps.log('INFO', 'plan_engine_retry', {
        taskId: task.id,
        attempt: task.attemptCount,
        maxAttempts: task.maxAttempts,
      })
      this.transitionTo(task.id, 'analyzing')
      return false
    }

    // 2. 启用降级且存在备选工具
    if (this.config.enableDegradation && task.analysis) {
      const currentToolIdx = task.analysis.toolSuggestions.findIndex(
        (s) => s.toolName === task.activeTool,
      )
      // 尝试下一个备选工具
      if (currentToolIdx >= 0 && currentToolIdx < task.analysis.toolSuggestions.length - 1) {
        const fallback = task.analysis.toolSuggestions[currentToolIdx + 1]
        const fallbackReason = `${task.activeTool} 失败，降级到 ${fallback.toolName}`

        this.deps.emitEvent({
          type: 'task.degraded',
          taskId: task.id,
          planId: this.planId,
          fallbackTool: fallback.toolName,
          reason: fallbackReason,
        })

        this.deps.log('WARN', 'plan_engine_degrading', {
          taskId: task.id,
          from: task.activeTool,
          to: fallback.toolName,
        })

        task.activeTool = fallback.toolName
        task.activeArgs = fallback.expectedArgs
        this.transitionTo(task.id, 'degraded')
        // degraded → 自动继续执行
        return this.executeTask(task)
      }

      // 尝试 fallbackTools
      if (currentToolIdx >= 0) {
        const primary = task.analysis.toolSuggestions[currentToolIdx]
        if (primary.fallbackTools.length > 0) {
          const fallbackToolName = primary.fallbackTools[0]
          this.deps.emitEvent({
            type: 'task.degraded',
            taskId: task.id,
            planId: this.planId,
            fallbackTool: fallbackToolName,
            reason: `${task.activeTool} 失败，回退到 ${fallbackToolName}`,
          })

          task.activeTool = fallbackToolName
          task.activeArgs = {}
          this.transitionTo(task.id, 'degraded')
          return this.executeTask(task)
        }
      }
    }

    // 3. 需要用户确认
    if (this.config.requireUserConfirmation) {
      this.deps.emitEvent({
        type: 'task.needs_confirm',
        taskId: task.id,
        planId: this.planId,
        issue: `步骤 "${task.description}" 执行失败: ${task.lastError}`,
      })
      this.transitionTo(task.id, 'needs_confirm')
      return false
    }

    // 4. 最终失败
    this.transitionTo(task.id, 'failed')
    return false
  }

  // ── 外部控制 ──────────────────────────────────────────────

  /** 设置工具选择（由外部 LLM 分析后调用） */
  selectTool(taskId: string, toolName: string, args: Record<string, unknown>): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.state !== 'analyzing') return false

    task.activeTool = toolName
    task.activeArgs = args
    this.transitionTo(task.id, 'tool_selected')

    this.deps.emitEvent({
      type: 'task.tool_selected',
      taskId,
      toolName,
    })

    return true
  }

  /** 用户确认继续（needs_confirm → executing） */
  confirmExecution(taskId: string): boolean {
    return this.transitionTo(taskId, 'executing')
  }

  /** 用户选择跳过 */
  skipTask(taskId: string): boolean {
    return this.transitionTo(taskId, 'skipped')
  }

  /** 取消任务 */
  cancelTask(taskId: string): boolean {
    return this.transitionTo(taskId, 'cancelled')
  }

  /** 取消所有任务 */
  cancelAll(): void {
    for (const [id, task] of this.tasks) {
      if (task.state !== 'completed' && task.state !== 'skipped' && task.state !== 'cancelled') {
        this.transitionTo(id, 'cancelled')
      }
    }
  }

  /** 检查所有任务是否已进入终态 */
  isAllTerminal(): boolean {
    const terminal = new Set<PlanTaskState>(['completed', 'skipped', 'cancelled', 'failed'])
    return Array.from(this.tasks.values()).every((t) => terminal.has(t.state))
  }

  /**
   * 获取执行总结。
   * 包含成功/失败/跳过的计数。
   */
  getSummary(): { total: number; completed: number; failed: number; skipped: number; cancelled: number; remaining: number } {
    const tasks = this.getTasks()
    return {
      total: tasks.length,
      completed: tasks.filter((t) => t.state === 'completed').length,
      failed: tasks.filter((t) => t.state === 'failed').length,
      skipped: tasks.filter((t) => t.state === 'skipped').length,
      cancelled: tasks.filter((t) => t.state === 'cancelled').length,
      remaining: tasks.filter((t) => !['completed', 'skipped', 'cancelled', 'failed'].includes(t.state)).length,
    }
  }

  // ── 快照导出/导入 ──────────────────────────────────────────────

  /**
   * 导出当前所有任务的快照序列化数据。
   * 用于 PlanSnapshotStore 持久化任务状态。
   *
   * @returns 序列化的任务快照数组
   */
  exportSnapshot(): SerializedTaskSnapshot[] {
    return Array.from(this.tasks.values()).map((t) => ({
      id: t.id,
      stepIndex: t.stepIndex,
      description: t.description,
      state: t.state,
      analysis: t.analysis,
      activeTool: t.activeTool,
      activeArgs: t.activeArgs,
      attemptCount: t.attemptCount,
      maxAttempts: t.maxAttempts,
      lastError: t.lastError,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
      durationMs: t.durationMs,
      dependsOnTaskIds: t.dependsOnTaskIds,
      output: t.output,
    }))
  }

  /**
   * 从序列化的快照数据导入并重建任务状态。
   * 会清除当前所有任务，用快照中的任务替代。
   *
   * @param planId 计划 ID（覆盖当前 planId）
   * @param tasks 序列化的任务快照数据
   * @returns 重建的 PlanTask 列表
   */
  importSnapshot(planId: string, tasks: SerializedTaskSnapshot[]): PlanTask[] {
    // 覆盖 planId
    this.planId = planId

    // 清除当前所有任务
    this.tasks.clear()

    // 计算最大计数器值（从现有任务 ID 中解析）
    let maxCounter = 0
    for (const t of tasks) {
      // ID 格式：pt_{planId}_{counter}_{timestamp}
      const match = t.id.match(/pt_.*?_(\d+)_/)
      if (match) {
        const counter = parseInt(match[1], 10)
        if (counter > maxCounter) maxCounter = counter
      }
    }
    this.taskIdCounter = maxCounter

    // 重建 PlanTask 对象
    for (const st of tasks) {
      const task: PlanTask = {
        id: st.id,
        planId: this.planId,
        stepIndex: st.stepIndex,
        description: st.description,
        state: st.state,
        analysis: st.analysis,
        activeTool: st.activeTool,
        activeArgs: st.activeArgs,
        attemptCount: st.attemptCount,
        maxAttempts: st.maxAttempts,
        lastError: st.lastError,
        createdAt: Date.now(), // 使用当前时间（快照是新的起点）
        startedAt: st.startedAt,
        completedAt: st.completedAt,
        durationMs: st.durationMs,
        dependsOnTaskIds: st.dependsOnTaskIds,
        output: st.output,
      }
      this.tasks.set(task.id, task)
    }

    this.deps.log('INFO', 'plan_engine_snapshot_imported', {
      planId,
      taskCount: this.tasks.size,
      maxCounter,
    })

    return this.getTasks()
  }
}
