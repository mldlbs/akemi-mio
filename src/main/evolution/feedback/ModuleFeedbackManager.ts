/**
 * ModuleFeedbackManager — 模块级反馈状态管理器
 *
 * 管理每个模块的反馈累积状态，根据用户拒绝信号动态调整：
 * - modificationPriority: 模块修改优先级（越低越不应该被进化修改）
 * - regressionTestPriority: 回归测试优先级（越高越需要回归测试）
 *
 * 反馈策略：
 * 1. 每次检测到用户拒绝信号 → 降低 modificationPriority + 提高 regressionTestPriority
 * 2. 拒绝信号类型影响调整幅度：
 *    - git_revert: 强信号（-0.2 mod, +0.3 regression）
 *    - error_spike: 中信号（-0.15 mod, +0.2 regression）
 *    - tool_retry: 中信号（-0.1 mod, +0.15 regression）
 *    - undo_operation: 强信号（-0.25 mod, +0.3 regression）
 *    - repeated_fix: 弱信号（-0.05 mod, +0.1 regression）
 * 3. 权重随时间自然衰减（每 24 小时向默认值回归 10%）
 * 4. 状态持久化到 JSON 文件
 *
 * 集成方式：
 * - 被 EvolutionFeedbackCollector 消费
 * - 被 BehaviorPriorityWeighter 读取
 * - 被 SelfEvolutionService 在管道执行前调用
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { log } from '../../logger/Logger'
import { WORKSPACE } from '../../config'
import type {
  ModuleFeedbackState,
  RejectionSignalType,
  FeedbackStore,
  EvolutionPlanRecord,
  EvolutionModuleChange,
  EvolutionFeedbackSignalEvent,
  ModuleWeightAdjustedEvent,
} from './types'
import { eventBus } from '../../core/EventBus'
import type { EvolutionFeedbackSignalEvent, ModuleWeightAdjustedEvent } from './types'

// =============================================================================
// 常量
// =============================================================================

/** 持久化文件路径 */
const STORE_FILE = join(WORKSPACE.evolution, 'module_feedback.json')

/** 存储版本号 */
const STORE_VERSION = 1

/** 每个模块保留的最近信号数 */
const MAX_RECENT_SIGNALS = 50

/** 保留的最近计划记录数 */
const MAX_PLAN_RECORDS = 20

/** 衰减周期（毫秒）：24 小时 */
const DECAY_PERIOD_MS = 24 * 60 * 60 * 1000

/** 每天向默认值回归的比例 */
const DAILY_DECAY_RATE = 0.1

/** 默认修改优先级 */
const DEFAULT_MOD_PRIORITY = 1.0

/** 默认回归测试优先级 */
const DEFAULT_REGRESSION_PRIORITY = 0.5

/** 修改优先级最小值 */
const MIN_MOD_PRIORITY = 0.1

/** 修改优先级最大值 */
const MAX_MOD_PRIORITY = 1.5

/** 回归测试优先级最小值 */
const MIN_REGRESSION_PRIORITY = 0.0

/** 回归测试优先级最大值 */
const MAX_REGRESSION_PRIORITY = 2.0

/** 检测最近修改的时间窗口（毫秒） */
const RECENT_MODIFICATION_WINDOW_MS = 2 * 60 * 60 * 1000

// =============================================================================
// 信号类型 → 调整系数映射
// =============================================================================

const SIGNAL_ADJUSTMENT: Record<RejectionSignalType, { modPriorityDelta: number; regressionPriorityDelta: number }> = {
  git_revert: { modPriorityDelta: -0.2, regressionPriorityDelta: 0.3 },
  error_spike: { modPriorityDelta: -0.15, regressionPriorityDelta: 0.2 },
  tool_retry: { modPriorityDelta: -0.1, regressionPriorityDelta: 0.15 },
  undo_operation: { modPriorityDelta: -0.25, regressionPriorityDelta: 0.3 },
  repeated_fix: { modPriorityDelta: -0.05, regressionPriorityDelta: 0.1 },
}

// =============================================================================
// ModuleFeedbackManager
// =============================================================================

export class ModuleFeedbackManager {
  private store: FeedbackStore = {
    version: STORE_VERSION,
    updatedAt: Date.now(),
    modules: {},
    recentPlanRecords: [],
  }

  private initialized = false
  private decayLastCheck = Date.now()

  /** 初始化：从磁盘加载状态 */
  init(): void {
    this.load()
    this.initialized = true
    log('INFO', 'module_feedback_manager_init', {
      trackedModules: Object.keys(this.store.modules).length,
      planRecords: this.store.recentPlanRecords.length,
    })
  }

  /** 是否已初始化 */
  isInitialized(): boolean {
    return this.initialized
  }

  // ===========================================================================
  // 反馈记录
  // ===========================================================================

  /**
   * 记录一次用户拒绝信号。
   * @param moduleName 模块名
   * @param signalType 拒绝信号类型
   * @param strength 信号强度 (0~1)
   * @param description 信号描述
   */
  recordRejection(moduleName: string, signalType: RejectionSignalType, strength: number, description: string): void {
    this.ensureInitialized()

    const state = this.getOrCreateModuleState(moduleName)
    const adjustment = SIGNAL_ADJUSTMENT[signalType]

    // 记录信号
    state.recentSignals.push({
      type: signalType,
      strength,
      timestamp: Date.now(),
    })
    if (state.recentSignals.length > MAX_RECENT_SIGNALS) {
      state.recentSignals = state.recentSignals.slice(-MAX_RECENT_SIGNALS)
    }

    // 更新累计计数
    state.negativeFeedbackCount++
    state.lastFeedbackAt = Date.now()

    // 根据信号强度和类型调整优先级
    const effectiveDeltaMod = adjustment.modPriorityDelta * strength
    const effectiveDeltaRegression = adjustment.regressionPriorityDelta * strength

    const oldModPriority = state.modificationPriority
    const oldRegressionPriority = state.regressionTestPriority

    state.modificationPriority = Math.max(
      MIN_MOD_PRIORITY,
      Math.min(MAX_MOD_PRIORITY, state.modificationPriority + effectiveDeltaMod),
    )
    state.regressionTestPriority = Math.max(
      MIN_REGRESSION_PRIORITY,
      Math.min(MAX_REGRESSION_PRIORITY, state.regressionTestPriority + effectiveDeltaRegression),
    )

    // 重新计算拒绝率
    state.rejectionRate = this.computeRejectionRate(state)

    this.save()

    log('INFO', 'module_feedback_rejection_recorded', {
      module: moduleName,
      signalType,
      strength: strength.toFixed(2),
      modPriority: state.modificationPriority.toFixed(2),
      regressionPriority: state.regressionTestPriority.toFixed(2),
      negativeCount: state.negativeFeedbackCount,
    })

    // 发出事件
    eventBus.emit('evolution.feedback.signal' as any, {
      moduleName,
      signalType,
      strength,
      description,
      timestamp: Date.now(),
    } as EvolutionFeedbackSignalEvent)

    // 如果优先级有显著变化，发出调整事件
    if (Math.abs(state.modificationPriority - oldModPriority) > 0.05) {
      eventBus.emit('evolution.feedback.weight_adjusted' as any, {
        moduleName,
        oldModPriority,
        newModPriority: state.modificationPriority,
        oldRegressionPriority,
        newRegressionPriority: state.regressionTestPriority,
        reason: `${signalType}: ${description.slice(0, 60)}`,
      } as ModuleWeightAdjustedEvent)
    }
  }

  /**
   * 记录一次进化计划执行。
   * 关联到后续可能的用户反馈。
   */
  recordPlanExecution(
    planTitle: string,
    moduleChanges: Array<{
      moduleName: string
      filePaths: string[]
      changeType: EvolutionModuleChange['changeType']
    }>,
  ): void {
    this.ensureInitialized()

    const now = Date.now()
    const record: EvolutionPlanRecord = {
      planRunId: `plan_${now}_${Math.random().toString(36).slice(2, 8)}`,
      planTitle,
      moduleChanges: moduleChanges.map((mc) => ({
        moduleName: mc.moduleName,
        affectedFiles: mc.filePaths,
        changeType: mc.changeType,
        timestamp: now,
      })),
      createdAt: now,
      completedAt: now,
      success: true,
    }

    this.store.recentPlanRecords.push(record)
    if (this.store.recentPlanRecords.length > MAX_PLAN_RECORDS) {
      this.store.recentPlanRecords = this.store.recentPlanRecords.slice(-MAX_PLAN_RECORDS)
    }

    // 为所有涉及的模块添加正反馈基线（以区分"未反馈"和"无反馈"）
    for (const mc of moduleChanges) {
      const state = this.getOrCreateModuleState(mc.moduleName)
      // 记录该模块被修改过，但不增加正/负计数
      state.lastFeedbackAt = now
    }

    this.save()
    log('INFO', 'module_feedback_plan_recorded', {
      planTitle: planTitle.slice(0, 60),
      modules: moduleChanges.map((mc) => mc.moduleName),
      planRunId: record.planRunId,
    })
  }

  // ===========================================================================
  // 状态查询
  // ===========================================================================

  /**
   * 获取指定模块的反馈状态。
   */
  getModuleState(moduleName: string): ModuleFeedbackState | undefined {
    this.applyDecay()
    return this.store.modules[moduleName]
  }

  /**
   * 获取所有跟踪的模块名列表。
   */
  getTrackedModules(): string[] {
    this.applyDecay()
    return Object.keys(this.store.modules)
  }

  /**
   * 获取最近被进化修改过的模块列表。
   * @param windowMs 时间窗口（毫秒）
   */
  getRecentModifiedModules(windowMs: number = RECENT_MODIFICATION_WINDOW_MS): string[] {
    this.applyDecay()
    const cutoff = Date.now() - windowMs
    const modifiedModules = new Set<string>()

    // 从计划记录中提取最近被修改的模块
    for (const plan of this.store.recentPlanRecords) {
      if (plan.completedAt < cutoff) continue
      for (const change of plan.moduleChanges) {
        modifiedModules.add(change.moduleName)
      }
    }

    return Array.from(modifiedModules)
  }

  /**
   * 获取指定模块的修改优先级（0~1.5）。
   * 如果模块未被跟踪，返回默认值 1.0。
   */
  getModuleModificationPriority(moduleName: string): number {
    this.applyDecay()
    const state = this.store.modules[moduleName]
    return state?.modificationPriority ?? DEFAULT_MOD_PRIORITY
  }

  /**
   * 获取指定模块的回归测试优先级（0~2）。
   * 如果模块未被跟踪，返回默认值 0.5。
   */
  getModuleRegressionPriority(moduleName: string): number {
    this.applyDecay()
    const state = this.store.modules[moduleName]
    return state?.regressionTestPriority ?? DEFAULT_REGRESSION_PRIORITY
  }

  /**
   * 获取指定模块的 Git 回滚次数。
   */
  getModuleRevertCount(moduleName: string): number {
    const state = this.store.modules[moduleName]
    if (!state) return 0
    return state.recentSignals.filter((s) => s.type === 'git_revert').length
  }

  /**
   * 生成模块优先级的格式化上下文，供进化分析 Prompt 注入。
   * 包含：每个跟踪模块的 modificationPriority 和 regressionTestPriority。
   */
  getFormattedContext(): string {
    this.applyDecay()

    const modules = Object.entries(this.store.modules)
      .filter(([, state]) => state.negativeFeedbackCount > 0 || state.positiveFeedbackCount > 0)
      .sort(([, a], [, b]) => b.rejectionRate - a.rejectionRate)

    if (modules.length === 0) return ''

    const lines: string[] = [
      '---',
      '【进化行为反馈 — Evolution Feedback】',
      '以下模块有用户反馈记录，修改优先级和回归测试优先级已自动调整：',
      '',
    ]

    for (const [moduleName, state] of modules) {
      const rejectionPct = (state.rejectionRate * 100).toFixed(0)
      const lastSignal = state.recentSignals.length > 0 ? state.recentSignals[state.recentSignals.length - 1] : null
      const lastType = lastSignal ? this.signalTypeLabel(lastSignal.type) : '无'
      lines.push(
        `  - ${moduleName}:`,
        `    修改优先级: ${state.modificationPriority.toFixed(2)}x | 回归测试优先级: ${state.regressionTestPriority.toFixed(2)}x`,
        `    负反馈: ${state.negativeFeedbackCount}次 | 拒绝率: ${rejectionPct}% | 最近信号: ${lastType}`,
      )
    }
    lines.push('', '  说明: 修改优先级越低越不应被进化系统修改，回归测试优先级越高越需要回归验证。', '---')

    return lines.join('\n')
  }

  /**
   * 获取完整的反馈状态快照（用于持久化/恢复）。
   */
  getStoreSnapshot(): FeedbackStore {
    this.applyDecay()
    return {
      ...this.store,
      modules: Object.fromEntries(
        Object.entries(this.store.modules).map(([key, val]) => [key, { ...val }]),
      ),
      recentPlanRecords: [...this.store.recentPlanRecords],
    }
  }

  // ===========================================================================
  // 内部方法
  // ===========================================================================

  private ensureInitialized(): void {
    if (!this.initialized) {
      this.load()
      this.initialized = true
    }
  }

  private getOrCreateModuleState(moduleName: string): ModuleFeedbackState {
    if (!this.store.modules[moduleName]) {
      this.store.modules[moduleName] = {
        moduleName,
        negativeFeedbackCount: 0,
        positiveFeedbackCount: 0,
        lastFeedbackAt: Date.now(),
        rejectionRate: 0,
        modificationPriority: DEFAULT_MOD_PRIORITY,
        regressionTestPriority: DEFAULT_REGRESSION_PRIORITY,
        recentSignals: [],
      }
    }
    return this.store.modules[moduleName]
  }

  /**
   * 计算拒绝率。
   */
  private computeRejectionRate(state: ModuleFeedbackState): number {
    const total = state.negativeFeedbackCount + state.positiveFeedbackCount
    if (total === 0) return 0
    return state.negativeFeedbackCount / total
  }

  /**
   * 应用时间衰减：每 DECAY_PERIOD_MS 向默认值回归 DAILY_DECAY_RATE。
   */
  private applyDecay(): void {
    const now = Date.now()
    const elapsed = now - this.decayLastCheck
    if (elapsed < DECAY_PERIOD_MS) return

    const periods = Math.floor(elapsed / DECAY_PERIOD_MS)
    let changed = false

    for (const state of Object.values(this.store.modules)) {
      for (let i = 0; i < periods; i++) {
        // 向默认值回归
        const modDiff = state.modificationPriority - DEFAULT_MOD_PRIORITY
        const regDiff = state.regressionTestPriority - DEFAULT_REGRESSION_PRIORITY

        if (Math.abs(modDiff) > 0.01) {
          state.modificationPriority += -modDiff * DAILY_DECAY_RATE
          changed = true
        }
        if (Math.abs(regDiff) > 0.01) {
          state.regressionTestPriority += -regDiff * DAILY_DECAY_RATE
          changed = true
        }
      }
    }

    this.decayLastCheck = now
    if (changed) {
      this.save()
      log('INFO', 'module_feedback_decay_applied', { periods })
    }
  }

  // ===========================================================================
  // 持久化
  // ===========================================================================

  private load(): void {
    try {
      if (!existsSync(STORE_FILE)) {
        this.store = {
          version: STORE_VERSION,
          updatedAt: Date.now(),
          modules: {},
          recentPlanRecords: [],
        }
        return
      }
      const raw = readFileSync(STORE_FILE, 'utf-8')
      const data = JSON.parse(raw) as FeedbackStore
      this.store = {
        version: data.version ?? STORE_VERSION,
        updatedAt: data.updatedAt ?? Date.now(),
        modules: data.modules ?? {},
        recentPlanRecords: data.recentPlanRecords ?? [],
      }
      log('INFO', 'module_feedback_store_loaded', {
        modules: Object.keys(this.store.modules).length,
        planRecords: this.store.recentPlanRecords.length,
      })
    } catch (err: any) {
      log('WARN', 'module_feedback_store_load_failed', { error: err.message })
      this.store = {
        version: STORE_VERSION,
        updatedAt: Date.now(),
        modules: {},
        recentPlanRecords: [],
      }
    }
  }

  private save(): void {
    try {
      this.store.updatedAt = Date.now()
      const dir = dirname(STORE_FILE)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(STORE_FILE, JSON.stringify(this.store, null, 2), 'utf-8')
    } catch (err: any) {
      log('WARN', 'module_feedback_store_save_failed', { error: err.message })
    }
  }

  // ===========================================================================
  // 辅助
  // ===========================================================================

  private signalTypeLabel(type: RejectionSignalType): string {
    const labels: Record<RejectionSignalType, string> = {
      git_revert: 'Git 回滚',
      tool_retry: '工具重试',
      error_spike: '错误率飙升',
      undo_operation: '用户撤销',
      repeated_fix: '反复修复',
    }
    return labels[type] || type
  }
}

/** 全局单例 */
export const moduleFeedbackManager = new ModuleFeedbackManager()
