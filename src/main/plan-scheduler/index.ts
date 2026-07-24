/**
 * plan-scheduler/index.ts — Agent 驱动的智能任务调度器
 *
 * 将计划（DevPlan）转化为动态任务队列，自动排序、分配工具并处理依赖。
 *
 * 使用方式：
 * ```ts
 * import { PlanSchedulerService } from './plan-scheduler'
 *
 * const scheduler = new PlanSchedulerService(llmService, toolScheduler, {
 *   planManager,
 *   llmService: { chatJson },
 *   emitEvent: (event) => {},
 *   log: (level, msg, meta) => {},
 * })
 *
 * // 加载并调度活跃计划
 * const plan = await scheduler.loadAndSchedule({ autoExecute: true })
 *
 * // 或手动调度指定计划
 * await scheduler.schedulePlan(myPlan, true)
 * ```
 *
 * 事件监听：
 * ```ts
 * eventBus.on('plan_scheduler.task_completed', (event) => { ... })
 * eventBus.on('plan_scheduler.suggestion_generated', (event) => { ... })
 * ```
 */

export { PlanSchedulerService } from './PlanSchedulerService'
export { PlanStepAnalyzer } from './PlanStepAnalyzer'
export { PlanTaskEngine, type ToolExecutor } from './PlanTaskEngine'
export { PlanFeedbackStore } from './PlanFeedbackStore'
export { PlanSnapshotStore, type PlanSnapshotStoreConfig } from './PlanSnapshotStore'

export { PlanSchedulerCoordinator } from './PlanSchedulerCoordinator'
export { SchedulerNotificationBridge, schedulerNotificationBridge, createAndStartSchedulerNotificationBridge } from './SchedulerNotificationBridge'

export {
  type PlanTask,
  type PlanTaskState,
  type PlanExecutionPlan,
  type ToolSuggestion,
  type StepAnalysisResult,
  type FeedbackRecord,
  type SchedulerMetrics,
  type PlanSchedulerEvent,
  type PlanSchedulerConfig,
  type PlanSchedulerDeps,
  type SerializedTaskSnapshot,
  type PlanSnapshotData,
  type SnapshotReason,
  VALID_STATE_TRANSITIONS,
  DEFAULT_SCHEDULER_CONFIG,
} from './types'
export type { PlanScheduleStatus, CoordinatorConfig, CoordinatorDeps } from './PlanSchedulerCoordinator'
