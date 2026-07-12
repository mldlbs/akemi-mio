/**
 * PlanExperiment42Plugin — 实验42：并发 Workflow 隔离性测试 插件
 *
 * Phase 1 实现（旁路输出不做决策）：
 * - 订阅 EventBus 事件，被动观察 UserBehavior 和 Plan/Workflow 状态
 * - 模拟 Plan-aware 决策，与真实行为对比并记录差异
 * - 提供 UserBehaviorLayer 的 pre/post hooks
 * - 生成对比报告，评估"如果使用 Plan 驱动"会怎样
 *
 * 注入方式：
 * - 作为 UserBehaviorLayer 的钩子注册
 * - 独立监听 EventBus 事件
 * - 不修改任何现有决策逻辑
 */

import { log } from '../../logger/Logger'
import { eventBus } from '../../core/EventBus'
import type { PlanManagerLike } from '../../evolution/types'
import type { EventPayload } from '../../core/EventBus'
import type { UserBehaviorFeature } from '../types'
import type {
  PreProcessContext,
  PostProcessContext,
  PostProcessResult,
} from '../types'
import {
  type ExperimentPhase,
  type PlanExperiment42Config,
  type ModeSwitchObservation,
  type ConcurrencyObservation,
  type EvolutionCycleObservation,
  type ExperimentReport,
  DEFAULT_EXPERIMENT_CONFIG,
} from './types'

// =============================================================================
// 常量
// =============================================================================

/** 日志标签 */
const LOG_TAG = 'plan_exp42'

/** 事件订阅清理函数列表 */
type DisposeFn = () => void

// =============================================================================
// PlanExperiment42Plugin
// =============================================================================

export class PlanExperiment42Plugin {
  // ==================== 配置 ====================
  private config: PlanExperiment42Config
  private planManager: PlanManagerLike | null = null

  // ==================== 观察缓存 ====================
  private modeSwitchObs: ModeSwitchObservation[] = []
  private concurrencyObs: ConcurrencyObservation[] = []
  private evolutionCycleObs: EvolutionCycleObservation[] = []

  // ==================== 内部状态跟踪 ====================
  private workflowRunRegistry = new Map<string, { name?: string; startTime: number }>()
  // TODO: future Phase 2/3 may use behavior state. Currently unused; kept for event subscription symmetry.
  // private lastBehaviorState: Record<string, unknown> = {}
  private lastModeSwitchTime = 0
  private lastConcurrencyCheckTime = 0
  private startTime = Date.now()

  // ==================== 事件订阅 ====================
  private disposables: DisposeFn[] = []

  // ==================== 统计 ====================
  private planOverrideCount = 0
  private totalDecisionCount = 0
  private conflictCount = 0
  private totalConcurrencyChecks = 0

  constructor(config?: Partial<PlanExperiment42Config>, planManager?: PlanManagerLike) {
    this.config = { ...DEFAULT_EXPERIMENT_CONFIG, ...config }
    this.planManager = planManager ?? null
  }

  // ==================== 生命周期 ====================

  /** 设置 PlanManager 引用 */
  setPlanManager(pm: PlanManagerLike): void {
    this.planManager = pm
  }

  /**
   * 从 UserBehavior 的 feature flags 自动推导实验阶段。
   * 由注入方（UserBehaviorLayer）在 setExperimentPlugin 时调用。
   */
  autoDetectPhase(features: ReadonlySet<UserBehaviorFeature>): void {
    if (features.has('plan_experiment_42_replacement')) {
      this.config.phase = 'core_replacement'
    } else if (features.has('plan_experiment_42_suggestion')) {
      this.config.phase = 'suggestion_source'
    } else if (features.has('plan_experiment_42_passive')) {
      this.config.phase = 'passive_monitor'
    }
    // 没有匹配 flag 则保留默认值
  }

  /** 更新配置 */
  updateConfig(patch: Partial<PlanExperiment42Config>): void {
    this.config = { ...this.config, ...patch }
    log('INFO', `${LOG_TAG}_config_updated`, {
      phase: this.config.phase,
      debug: this.config.debug,
    })
  }

  /** 获取当前阶段 */
  getPhase(): ExperimentPhase {
    return this.config.phase
  }

  /** 获取当前配置 */
  getConfig(): PlanExperiment42Config {
    return { ...this.config }
  }

  /**
   * 启动插件：订阅事件总线并开始观察
   *
   * Phase 1: 仅观察和日志，不做任何决策影响
   */
  start(): void {
    if (this.disposables.length > 0) {
      log('WARN', `${LOG_TAG}_already_started`)
      return
    }

    this.startTime = Date.now()

    // 1. 监听行为模式切换
    this.disposables.push(
      eventBus.on('behavior.mode.switch', (payload) => {
        this.onModeSwitch(payload)
      }),
    )

    // 2. 行为状态更新时检查并发（保留订阅，供未来 Phase 使用）
    this.disposables.push(
      eventBus.on('behavior.state.updated', () => {
        this.checkConcurrency()
      }),
    )

    // 3. 监听 Workflow 运行事件
    this.disposables.push(
      eventBus.on('workflow.run.created', (payload) => {
        this.workflowRunRegistry.set(payload.runId, {
          name: payload.workflowName,
          startTime: payload.startedAt ?? Date.now(),
        })
      }),
    )
    this.disposables.push(
      eventBus.on('workflow.run.updated', (payload) => {
        if (payload.status === 'completed' || payload.status === 'failed' || payload.status === 'cancelled') {
          this.workflowRunRegistry.delete(payload.runId)
        }
      }),
    )

    // 4. 监听计划事件
    this.disposables.push(
      eventBus.on('agent.plan.created', () => {
        this.checkConcurrency()
      }),
    )
    this.disposables.push(
      eventBus.on('agent.plan.completed', () => {
        this.checkConcurrency()
      }),
    )

    log('INFO', `${LOG_TAG}_started`, {
      phase: this.config.phase,
      debug: this.config.debug,
    })
  }

  /** 停止插件：清理事件订阅和缓存 */
  stop(): void {
    for (const dispose of this.disposables) {
      try {
        dispose()
      } catch {
        // 静默清理
      }
    }
    this.disposables = []
    this.workflowRunRegistry.clear()

    log('INFO', `${LOG_TAG}_stopped`, {
      observations: {
        modeSwitches: this.modeSwitchObs.length,
        concurrency: this.concurrencyObs.length,
        evolutionCycles: this.evolutionCycleObs.length,
      },
    })
  }

  /** 重置观察缓存（保留配置和订阅） */
  resetObservations(): void {
    this.modeSwitchObs = []
    this.concurrencyObs = []
    this.evolutionCycleObs = []
    this.planOverrideCount = 0
    this.totalDecisionCount = 0
    this.conflictCount = 0
    this.totalConcurrencyChecks = 0
    log('INFO', `${LOG_TAG}_observations_reset`)
  }

  // ==================== UserBehaviorLayer 钩子 ====================

  /**
   * 预处理钩子 — 在 Evolution 管道执行前调用
   *
   * Phase 1 行为：记录当前状态、检查活跃计划、模拟 Plan-aware 预处理调整
   * 但**不修改** PreProcessContext，仅旁路日志输出
   */
  onPreProcess(ctx: PreProcessContext): PreProcessContext {
    if (this.config.phase !== 'passive_monitor' && this.config.phase !== 'suggestion_source') {
      return ctx
    }

    try {
      const activePlan = this.planManager?.getActivePlan()
      const planContext = activePlan
        ? `活跃计划「${activePlan.title}」(${activePlan.steps.filter((s) => s.status === 'done').length}/${activePlan.steps.length} 步完成)`
        : '无活跃计划'

      // Phase 1: 仅输出旁路日志，不修改 ctx
      log('INFO', `${LOG_TAG}_pre_process_passive`, {
        phase: this.config.phase,
        planContext,
        hoursSinceLastRun: ctx.hoursSinceLastRun.toFixed(1),
        consecutiveFailures: ctx.consecutiveFailures,
        safetyMode: ctx.safetyMode,
        userActive: ctx.userActive,
        simulation: `Plan-aware 建议：${activePlan ? '检查计划步骤完成度后触发管道' : '按现有调度执行'}`,
      })

      if (this.config.debug) {
        log('DEBUG', `${LOG_TAG}_pre_ctx_detail`, {
          activePlanTitle: activePlan?.title ?? null,
          planStepProgress: activePlan
            ? `${activePlan.steps.filter((s) => s.status === 'done').length}/${activePlan.steps.length}`
            : null,
        })
      }
    } catch (err: any) {
      log('WARN', `${LOG_TAG}_pre_process_error`, { error: err.message })
    }

    return ctx
  }

  /**
   * 后处理钩子 — 在 Evolution 管道执行后调用
   *
   * Phase 1 行为：记录执行结果、模拟 Plan-aware 后处理建议
   * 但**不修改** PostProcessResult，仅旁路日志输出
   */
  onPostProcess(ctx: PostProcessContext): PostProcessResult {
    if (this.config.phase !== 'passive_monitor' && this.config.phase !== 'suggestion_source') {
      return { enhancedSummary: undefined }
    }

    try {
      const activePlan = this.planManager?.getActivePlan()

      // 构建 Plan-aware 建议
      let planSuggestion: string | null = null
      if (activePlan && ctx.success) {
        const doneSteps = activePlan.steps.filter((s) => s.status === 'done').length
        const totalSteps = activePlan.steps.length
        const planProgress = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0

        if (planProgress >= 80 && totalSteps - doneSteps <= 2) {
          planSuggestion = `计划「${activePlan.title}」接近完成 (${planProgress}%)，建议在本次报告末尾附加计划完成提醒`
        } else if (planProgress < 20 && doneSteps === 0) {
          planSuggestion = `计划「${activePlan.title}」尚未开始，建议调整分析重点以覆盖计划前置步骤`
        }
      }

      // 记录 Evolution 周期观察
      const observation: EvolutionCycleObservation = {
        timestamp: Date.now(),
        success: ctx.success,
        durationMs: ctx.durationMs,
        preContextSummary: `成功=${ctx.success}, 耗时=${ctx.durationMs}ms, 有指标=${!!ctx.rawMetrics}`,
        postEnhancementSummary: ctx.rawSummary.length > 80 ? ctx.rawSummary.slice(0, 80) + '...' : ctx.rawSummary,
        planSuggestedAdjustment: planSuggestion,
        adjustmentReason: planSuggestion ? 'Plan-aware 周期建议' : null,
        activePlanInfo: activePlan
          ? {
              title: activePlan.title,
              stepProgress: `${activePlan.steps.filter((s) => s.status === 'done').length}/${activePlan.steps.length}`,
            }
          : null,
      }
      this.evolutionCycleObs.push(observation)
      this.trimCache(this.evolutionCycleObs)

      // 统计决策差异
      this.totalDecisionCount++
      if (planSuggestion) {
        this.planOverrideCount++
      }

      // Phase 1: 仅日志，不修改 result
      if (planSuggestion) {
        log('INFO', `${LOG_TAG}_post_process_passive`, {
          phase: this.config.phase,
          success: ctx.success,
          planSuggestion,
          planOverrideRate: this.getPlanOverrideRate(),
        })
      }

      if (this.config.debug) {
        log('DEBUG', `${LOG_TAG}_post_ctx_detail`, {
          durationMs: ctx.durationMs,
          hasMetrics: !!ctx.rawMetrics,
          planSuggestion,
        })
      }

      // Phase 1 不修改结果，返回空
      return { enhancedSummary: undefined }
    } catch (err: any) {
      log('WARN', `${LOG_TAG}_post_process_error`, { error: err.message })
      return { enhancedSummary: undefined }
    }
  }

  // ==================== 事件处理 ====================

  /**
   * 处理模式切换事件
   *
   * 模拟 Plan-aware 决策，与实际的 DualModeController 决策对比
   */
  private onModeSwitch(payload: { fromMode: string; toMode: string; reason: string; confidence: number; timestamp: number }): void {
    const activePlan = this.planManager?.getActivePlan()

    // 模拟 Plan-aware 推荐：如果有活跃计划，检查模式是否匹配
    let planRecommendedMode: string | null = null
    let planRecommendationReason: string | null = null
    let difference = ''

    if (activePlan) {
      // Plan 活跃时，Plan-aware 系统会根据计划的性质推荐模式
      const planTitleLower = activePlan.title.toLowerCase()
      const isTypeScriptPlan = planTitleLower.includes('typescript') || planTitleLower.includes('type') || planTitleLower.includes('学习')

      if (isTypeScriptPlan && payload.toMode !== 'plan-typescript') {
        planRecommendedMode = 'plan-typescript'
        planRecommendationReason = `活跃计划「${activePlan.title}」建议使用 plan-typescript 模式`
        difference = `实际切换到 ${payload.toMode}，但 Plan-aware 建议 ${planRecommendedMode}（原因：${planRecommendationReason}）`
      } else if (!isTypeScriptPlan && payload.toMode === 'plan-typescript') {
        planRecommendedMode = 'user-behavior'
        planRecommendationReason = `活跃计划「${activePlan.title}」不涉及 TypeScript 学习，建议使用 user-behavior 模式`
        difference = `实际切换到 plan-typescript，但 Plan-aware 建议 user-behavior（原因：${planRecommendationReason}）`
      }
    }

    const observation: ModeSwitchObservation = {
      timestamp: payload.timestamp ?? Date.now(),
      actualFromMode: payload.fromMode,
      actualToMode: payload.toMode,
      actualReason: payload.reason,
      planRecommendedMode,
      planRecommendationReason,
      hasActivePlan: !!activePlan,
      activePlanTitle: activePlan?.title ?? null,
      wouldChange: planRecommendedMode !== null && planRecommendedMode !== payload.toMode,
      difference: difference || 'Plan-aware 与实际决策一致',
    }

    this.modeSwitchObs.push(observation)
    this.trimCache(this.modeSwitchObs)

    this.totalDecisionCount++
    if (observation.wouldChange) {
      this.planOverrideCount++
    }

    // Phase 1: 仅日志
    if (observation.wouldChange) {
      log('INFO', `${LOG_TAG}_mode_switch_passive`, {
        actual: `${payload.fromMode} → ${payload.toMode} (${payload.reason})`,
        planRecommended: planRecommendedMode,
        planRecommendationReason,
        planOverrideRate: this.getPlanOverrideRate(),
      })
    } else if (this.config.debug) {
      log('DEBUG', `${LOG_TAG}_mode_switch_aligned`, {
        mode: payload.toMode,
        hasPlan: !!activePlan,
      })
    }
  }

  /**
   * 检查并发 Workflow 状态
   *
   * 定期检查并发的 Workflow 运行情况，检测潜在的隔离冲突
   */
  private checkConcurrency(): void {
    const now = Date.now()
    if (now - this.lastConcurrencyCheckTime < this.config.concurrencyWindowMs) return
    this.lastConcurrencyCheckTime = now

    // 清理过期的 Workflow 注册
    for (const [runId, reg] of this.workflowRunRegistry) {
      if (now - reg.startTime > 5 * 60 * 1000) {
        this.workflowRunRegistry.delete(runId)
      }
    }

    const activePlans = this.planManager?.listPlans()?.filter((p) => p.status === 'active') ?? []
    const runningWorkflows = Array.from(this.workflowRunRegistry.entries()).map(([runId, reg]) => ({
      runId,
      name: reg.name,
    }))

    const totalActive = runningWorkflows.length + activePlans.length
    if (totalActive < 2) return // 不足两个并发项，无需检查

    this.totalConcurrencyChecks++

    // 检测隔离冲突：多个活跃计划 + 正在运行的 Workflow
    let hasConflict = false
    let conflictDetail: string | null = null
    let suggestion: string | null = null

    if (runningWorkflows.length > 0 && activePlans.length > 0) {
      hasConflict = true
      this.conflictCount++
      conflictDetail = `并发执行: ${runningWorkflows.length} 个 Workflow + ${activePlans.length} 个活跃计划`
      suggestion = `建议暂停低优先级 Workflow，确保计划「${activePlans[0].title}」的独占资源访问`
    } else if (activePlans.length > 1) {
      hasConflict = true
      this.conflictCount++
      conflictDetail = `多个活跃计划并行: ${activePlans.map((p) => p.title).join(', ')}`
      suggestion = `多个活跃计划可能竞争相同资源，建议按优先级串行执行`
    }

    const observation: ConcurrencyObservation = {
      timestamp: now,
      concurrentCount: totalActive,
      runningWorkflows,
      activePlans: activePlans.map((p) => ({ id: p.id, title: p.title })),
      hasConflict,
      conflictDetail,
      suggestedPriority: hasConflict ? '按计划优先级 + Workflow 启动时间排序' : null,
      suggestion,
    }

    this.concurrencyObs.push(observation)
    this.trimCache(this.concurrencyObs)

    if (hasConflict) {
      log('INFO', `${LOG_TAG}_concurrency_conflict`, {
        concurrentCount: totalActive,
        runningWorkflows: runningWorkflows.length,
        activePlans: activePlans.length,
        conflictDetail,
        suggestion,
      })
    }
  }

  // ==================== 报告生成 ====================

  /**
   * 生成实验报告
   *
   * 包含 Phase 1 期间的所有观察记录和统计数据
   */
  generateReport(): ExperimentReport {
    const allTs = [
      ...this.modeSwitchObs.map((o) => o.timestamp),
      ...this.concurrencyObs.map((o) => o.timestamp),
      ...this.evolutionCycleObs.map((o) => o.timestamp),
    ]

    const collectionWindow: ExperimentReport['collectionWindow'] =
      allTs.length > 0
        ? { from: Math.min(...allTs), to: Math.max(...allTs) }
        : { from: this.startTime, to: Date.now() }

    const planOverrideRate = this.totalDecisionCount > 0
      ? this.planOverrideCount / this.totalDecisionCount
      : 0
    const conflictRate = this.totalConcurrencyChecks > 0
      ? this.conflictCount / this.totalConcurrencyChecks
      : 0

    // 构建摘要文本
    const summaryLines: string[] = [
      `【实验42：并发Workflow隔离性测试】Phase 1 观察报告`,
      ``,
      `采集窗口: ${new Date(collectionWindow.from).toISOString()} ~ ${new Date(collectionWindow.to).toISOString()}`,
      `运行时长: ${Math.round((Date.now() - this.startTime) / 60000)} 分钟`,
      ``,
      `📊 观察统计:`,
      `  - 模式切换: ${this.modeSwitchObs.length} 次`,
      `  - 并发检测: ${this.concurrencyObs.length} 次 (${this.totalConcurrencyChecks} 次检查)`,
      `  - Evolution 周期: ${this.evolutionCycleObs.length} 次`,
      ``,
      `📈 Plan 覆盖分析:`,
      `  - 总决策次数: ${this.totalDecisionCount}`,
      `  - Plan-aware 建议不同: ${this.planOverrideCount} 次`,
      `  - Plan 决策差异率: ${(planOverrideRate * 100).toFixed(1)}%`,
      ``,
    ]

    if (this.conflictCount > 0) {
      summaryLines.push(`⚠️ 并发冲突: ${this.conflictCount} 次 (${(conflictRate * 100).toFixed(1)}%)`)
      summaryLines.push(`  - 建议评估 Workflow/Plan 资源隔离策略`)
    } else {
      summaryLines.push(`✅ 并发冲突: 0 次`)
    }

    return {
      phase: this.config.phase,
      totalObservations: this.modeSwitchObs.length + this.concurrencyObs.length + this.evolutionCycleObs.length,
      modeSwitches: [...this.modeSwitchObs],
      concurrencyEvents: [...this.concurrencyObs],
      evolutionCycles: [...this.evolutionCycleObs],
      planOverrideRate,
      conflictRate,
      collectionWindow,
      generatedAt: Date.now(),
      summary: summaryLines.join('\n'),
    }
  }

  /**
   * 获取 Plan 决策差异率（Plan-aware 与实际决策不一致的比例）
   */
  getPlanOverrideRate(): number {
    return this.totalDecisionCount > 0 ? this.planOverrideCount / this.totalDecisionCount : 0
  }

  /**
   * 获取并发冲突率
   */
  getConflictRate(): number {
    return this.totalConcurrencyChecks > 0 ? this.conflictCount / this.totalConcurrencyChecks : 0
  }

  // ==================== 内部工具 ====================

  /**
   * 裁剪观察缓存，防止内存泄漏
   */
  private trimCache<T>(arr: T[]): void {
    if (arr.length > this.config.observationWindowSize) {
      arr.splice(0, arr.length - this.config.observationWindowSize)
    }
  }
}
