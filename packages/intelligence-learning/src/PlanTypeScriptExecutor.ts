/**
 * PlanTypeScriptExecutor — TypeScript 高级类型学习计划执行器
 *
 * 将 ASR 核心策略注入「Plan:TypeScript 高级类型学习计划」的执行链路：
 *
 * 注入点：
 * 1. planStepCompleted()  — 对应 AsrService.feedUserTextToHotwords()
 *    每次步骤完成时，将涉及的知识点记录到 LearningVocabularyManager
 *
 * 2. recordDifficulty()   — 对应 AsrService.feedback()
 *    学习困难记录 → 评估知识点是否需要调整难度
 *
 * 3. autoAdjustStrategy() — 对应 AsrEvolutionManager.applyPatches()
 *    基于 LearningProgressTracker 的困难模式分析，自动调整学习策略
 *
 * 4. syncFocusContext()   — 对应 AsrService.setConversationContext()
 *    将当前学习进度上下文同步给 DualModeController
 *
 * 5. createLearningPlan() — 使用 PlanManager 创建 TypeScript 学习计划
 *    根据 LearningVocabularyManager 中的未掌握项动态生成步骤
 *
 * 集成方式：
 * - 在 PlanManager.createPlan() 的步骤执行链路中插入钩子
 * - 在 DualModeController 模式切换时调用同步方法
 * - 定时调用 autoAdjustStrategy() 实现自适应学习
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus, SubscriptionTracker } from '@akemi-mio/core/core/EventBus'
import { learningVocabularyManager } from './LearningVocabularyManager'
import { learningProgressTracker } from './LearningProgressTracker'
import { buildFocusContext, buildPriorityItems, buildFocusSummary } from './LearningFocusBuilder'
import type { LearningProgress, LearningFocusContext, LearningItem } from './types'
import type { LearningStrategyChange, LearningStrategyType } from './LearningProgressTracker'
import type { DevPlan, PlanManagerLike } from '@akemi-mio/evolution/types'

// =============================================================================
// 常量
// =============================================================================

/** 策略自动调整最小间隔（毫秒）*/
const AUTO_ADJUST_INTERVAL_MS = 30 * 60 * 1000 // 30 分钟

/** 困难触发自适应调整的最小频次 */
const DIFFICULTY_TRIGGER_THRESHOLD = 3

/** 学习步骤模块前缀 */
const STEP_PREFIXES = ['学习', '理解', '掌握', '练习', '实践', '阅读', '完成', '实现', '复习', '总结']

// =============================================================================
// PlanTypeScriptExecutor
// =============================================================================

export class PlanTypeScriptExecutor {
  /** PlanManager 引用（延迟注入）*/
  private planManager: PlanManagerLike | null = null
  /** 当前活跃的学习计划 ID */
  private activePlanId: string | null = null
  /** 上次自动调整时间 */
  private lastAutoAdjustAt = 0
  /** 当前学习焦点上下文 */
  private currentFocusContext: LearningFocusContext | null = null
  /** EventBus 订阅追踪 — 统一清理 Wallpaper 事件订阅 */
  private wallpaperSubs = new SubscriptionTracker()
  /** 是否已订阅 Wallpaper 事件 */
  private wallpaperSubscribed = false

  /**
   * 注入 PlanManager 引用。
   */
  setPlanManager(pm: PlanManagerLike): void {
    this.planManager = pm
    log('INFO', 'plan_ts_executor_plan_manager_set')
  }

  // ==================== Wallpaper 事件订阅 ====================

  /**
   * 订阅 Wallpaper 事件，实现 Plan:TypeScript 对壁纸状态变化的响应。
   *
   * 订阅的事件：
   * - wallpaper.mode.changed → 壁纸模式变化时调整学习策略
   * - wallpaper.lock.changed → 锁定状态变化时暂停/恢复自动调整
   * - wallpaper.config.changed → 配置变化时刷新学习上下文
   *
   * Schema 版本检查确保兼容：新字段用默认值填充。
   */
  subscribeToWallpaperEvents(): void {
    if (this.wallpaperSubscribed) return
    this.wallpaperSubscribed = true

    // ── wallpaper.mode.changed → 模式变化触发策略评估 ──
    eventBus.track(
      'wallpaper.mode.changed' as any,
      (payload: any) => {
        const version = payload.version ?? 0
        const mode: string = payload.mode ?? 'multitasking'
        const context: string = payload.context ?? 'resting'

        log('INFO', 'plan_ts_wallpaper_mode_changed', {
          mode,
          context,
          version,
          confidence: payload.confidence,
        })

        // 专注模式 → 学习计划自动调整策略
        if (mode === 'focus' && context === 'coding') {
          // 用户进入深度编码 → 检查是否需要调整学习策略
          this.autoAdjustStrategy()
        }

        // 休息模式 → 可能不需要立即干预，但记录上下文变化
        if (mode === 'break') {
          log('DEBUG', 'plan_ts_wallpaper_break_mode', {
            note: '用户进入休息模式，学习策略调整暂停',
          })
        }
      },
      this.wallpaperSubs,
      'plan_ts:wallpaper_mode',
    )

    // ── wallpaper.lock.changed → 锁定状态变化 ──
    eventBus.track(
      'wallpaper.lock.changed' as any,
      (payload: any) => {
        const locked: boolean = payload.locked ?? false

        log('INFO', 'plan_ts_wallpaper_lock_changed', {
          locked,
          previous: payload.previous,
          version: payload.version,
        })

        if (locked) {
          log('INFO', 'plan_ts_wallpaper_locked_pause_strategy', {
            note: '壁纸已锁定，暂停自动策略调整',
          })
        }
      },
      this.wallpaperSubs,
      'plan_ts:wallpaper_lock',
    )

    // ── wallpaper.config.changed → 配置变化 ──
    eventBus.track(
      'wallpaper.config.changed' as any,
      (_payload: any) => {
        // 配置变化可能影响壁纸透明度等内容，刷新学习上下文
        log('DEBUG', 'plan_ts_wallpaper_config_changed')
      },
      this.wallpaperSubs,
      'plan_ts:wallpaper_config',
    )

    log('INFO', 'plan_ts_wallpaper_events_subscribed')
  }

  /**
   * 取消 Wallpaper 事件订阅。
   */
  unsubscribeFromWallpaperEvents(): void {
    this.wallpaperSubs.dispose()
    this.wallpaperSubscribed = false
    log('INFO', 'plan_ts_wallpaper_events_unsubscribed')
  }

  /**
   * 获取当前活跃学习计划 ID。
   */
  getActivePlanId(): string | null {
    return this.activePlanId
  }

  /**
   * 获取当前学习焦点上下文。
   */
  getCurrentFocusContext(): LearningFocusContext | null {
    return this.currentFocusContext
  }

  // ==================== 注入点 1：创建学习计划 ====================

  /**
   * 创建 TypeScript 高级类型学习计划。
   * 使用 PlanManager.createPlan() 创建计划，
   * 步骤来自 LearningVocabularyManager 中未掌握的知识点。
   *
   * @returns 创建的 DevPlan
   */
  createLearningPlan(planManager?: PlanManagerLike): DevPlan | null {
    const pm = planManager || this.planManager
    if (!pm) {
      log('WARN', 'plan_ts_no_plan_manager')
      return null
    }

    // 初始化学习词表（如果未初始化）
    learningVocabularyManager.initialize()
    // 延迟加载学习进度追踪器
    learningProgressTracker.load()
    // 注入查询函数
    learningProgressTracker.setGetItemsFn(() => learningVocabularyManager.getAllItems())

    // 获取未掌握项和已掌握项
    const unmastered = learningVocabularyManager.getUnmasteredItems()
    const progress = learningVocabularyManager.getProgress()

    // 按分类分组生成步骤描述
    const stepTitles = this.buildStepDescriptions(unmastered)

    if (stepTitles.length === 0) {
      log('INFO', 'plan_ts_all_mastered', { overallMastery: progress.overallMastery })
      return null
    }

    const title = 'Plan:TypeScript 高级类型学习计划'
    const description = this.buildPlanDescription(progress, unmastered.length)

    try {
      const plan = pm.createPlan(title, description, stepTitles)
      this.activePlanId = plan.id

      // 创建初始评估快照
      learningProgressTracker.createSnapshot([`学习计划创建: ${unmastered.length} 个知识点待掌握`])

      log('INFO', 'plan_ts_created', {
        planId: plan.id,
        unmasteredCount: unmastered.length,
        overallMastery: progress.overallMastery,
        steps: stepTitles.length,
      })

      // 构建初始关注焦点上下文
      const allItems = learningVocabularyManager.getAllItems()
      this.currentFocusContext = buildFocusContext(
        allItems,
        stepTitles[0], // 第一步作为初始上下文
      )

      // ── 发射初始进度事件（Wallpaper 事件总线 Schema） ──
      this.emitProgressEvent()

      return plan
    } catch (err) {
      log('ERROR', 'plan_ts_create_failed', { error: String(err) })
      return null
    }
  }

  // ==================== 注入点 2：步骤完成反馈 ====================

  /**
   * 学习计划步骤完成时调用。
   * 注入点：
   * 1. 将步骤涉及的知识点注入 LearningVocabularyManager
   * 2. 更新关注焦点上下文
   * 3. 检查是否需要自动调整策略
   *
   * 对应 AsrService.feedUserTextToHotwords().
   *
   * @param stepDescription 完成的步骤描述
   * @param success 是否成功完成
   * @param concepts 该步骤涉及的知识点列表（可选）
   */
  onPlanStepCompleted(stepDescription: string, success: boolean, concepts?: string[]): void {
    // 1. 记录知识点交互（对应 ASR 的 feedUserTextToHotwords）
    if (concepts && concepts.length > 0) {
      for (const concept of concepts) {
        learningVocabularyManager.recordInteraction(concept, success)
      }
    } else if (stepDescription) {
      // 没有显式提供知识点时，从步骤描述中尝试提取
      const extracted = this.extractConceptsFromText(stepDescription)
      for (const concept of extracted) {
        learningVocabularyManager.recordInteraction(concept, success)
      }
    }

    // 2. 如果不是成功完成的步骤，记录困难
    if (!success) {
      learningProgressTracker.recordDifficulty(
        concepts?.[0] || 'unknown',
        concepts?.[0] || stepDescription,
        `步骤执行失败: ${stepDescription}`,
      )
    }

    // 3. 更新关注焦点上下文
    const allItems = learningVocabularyManager.getAllItems()
    this.currentFocusContext = buildFocusContext(allItems, stepDescription)

    log('INFO', 'plan_ts_step_completed', {
      step: stepDescription.slice(0, 60),
      success,
      concepts: concepts?.slice(0, 5),
      focusCategories: this.currentFocusContext?.focusCategories,
    })

    // ── EventBus 发射标准化步骤完成事件（Wallpaper 事件总线 Schema） ──
    eventBus.emit('plan.ts.step.completed', {
      version: 1,
      stepDescription,
      success,
      concepts,
      focusCategories: this.currentFocusContext?.focusCategories,
      timestamp: Date.now(),
    })
  }

  // ==================== 注入点 3：困难记录 ====================

  /**
   * 记录学习困难。
   * 对应 AsrService.feedback().
   *
   * @param conceptName 知识点名称
   * @param description 困难描述
   */
  recordDifficulty(conceptName: string, description: string): void {
    // 1. 记录到 DifficultyTracker
    learningProgressTracker.recordDifficulty(conceptName.toLowerCase(), conceptName, description)

    // 2. 减少知识点掌握度
    learningVocabularyManager.recordInteraction(conceptName, false)

    log('INFO', 'plan_ts_difficulty_recorded', {
      concept: conceptName,
      description: description.slice(0, 80),
    })

    // ── EventBus 发射标准化困难记录事件（Wallpaper 事件总线 Schema） ──
    const patterns = learningProgressTracker.getDifficultyPatterns()
    const existingPattern = patterns.find((p) => p.conceptName.toLowerCase() === conceptName.toLowerCase())
    eventBus.emit('plan.ts.difficulty.recorded', {
      version: 1,
      conceptName,
      description,
      frequency: existingPattern?.frequency ?? 1,
      category: existingPattern?.category ?? 'unknown',
      timestamp: Date.now(),
    })
  }

  // ==================== 注入点 4：自动调整策略 ====================

  /**
   * 基于学习数据分析自动调整学习策略。
   * 对应 AsrEvolutionManager.applyPatches() + evaluateAndDecide().
   *
   * 当检测到以下情况时触发：
   * - 某个分类的困难频次超过阈值
   * - 整体掌握度提升停滞
   * - 某知识点反复出错
   */
  autoAdjustStrategy(): void {
    const now = Date.now()
    if (now - this.lastAutoAdjustAt < AUTO_ADJUST_INTERVAL_MS) return
    this.lastAutoAdjustAt = now

    // 获取难点模式
    const difficultyPatterns = learningProgressTracker.getDifficultyPatterns()

    if (difficultyPatterns.length === 0) {
      log('INFO', 'plan_ts_auto_adjust_no_difficulties')
      return
    }

    // 检查是否需要调整
    const highFreqDifficulties = difficultyPatterns.filter((d) => d.frequency >= DIFFICULTY_TRIGGER_THRESHOLD)

    if (highFreqDifficulties.length === 0) return

    log('INFO', 'plan_ts_auto_adjust_triggered', {
      highFreqCount: highFreqDifficulties.length,
      topDifficulty: highFreqDifficulties[0].conceptName,
    })

    // 为每个高频难点生成策略变更
    const strategies = this.buildAdjustmentStrategies(highFreqDifficulties)

    for (const strategy of strategies) {
      // 应用策略（创建快照基线）
      const result = learningProgressTracker.applyLearningStrategy(strategy)

      if (result) {
        log('INFO', 'plan_ts_strategy_applied', {
          type: strategy.type,
          description: strategy.description,
          snapshotId: result.snapshotId,
        })
      }
    }

    // 评估上一次 pending 的策略效果
    const pendingSnapshots = learningProgressTracker.getPendingSnapshots()
    for (const snapshot of pendingSnapshots) {
      const decision = learningProgressTracker.evaluateAndDecide(snapshot.id)
      log('INFO', 'plan_ts_strategy_evaluated', {
        snapshotId: snapshot.id,
        verdict: decision.verdict,
        action: decision.action,
      })
    }

    // ── EventBus 发射标准化策略调整事件（Wallpaper 事件总线 Schema） ──
    eventBus.emit('plan.ts.strategy.adjusted', {
      version: 1,
      strategies: strategies.map((s) => ({ type: s.type, description: s.description })),
      triggerReason: `检测到 ${highFreqDifficulties.length} 个高频难点`,
      timestamp: Date.now(),
    })

    // 同时发射进度更新事件
    this.emitProgressEvent()
  }

  /**
   * 发射标准化进度更新事件。
   */
  private emitProgressEvent(): void {
    const progress = learningVocabularyManager.getProgress()
    eventBus.emit('plan.ts.progress.updated', {
      version: 1,
      overallMastery: progress.overallMastery,
      masteredCount: progress.masteredCount,
      learningCount: progress.learningCount,
      totalItems: progress.totalItems,
      overallAccuracy: progress.overallAccuracy,
      timestamp: Date.now(),
    })
  }

  // ==================== 注入点 5：同步关注上下文 ====================

  /**
   * 同步当前学习进度和关注上下文。
   * 由 DualModeController 在模式切换时调用。
   * 对应 AsrService.setConversationContext()。
   */
  syncFocusContext(): LearningFocusContext | null {
    const allItems = learningVocabularyManager.getAllItems()

    if (allItems.length === 0) {
      // 没有初始化时自动初始化
      learningVocabularyManager.initialize()
    }

    const currentPlan = this.getCurrentLearningPlan()
    const currentStepDesc = currentPlan ? this.getCurrentStepDescription(currentPlan) : undefined

    this.currentFocusContext = buildFocusContext(learningVocabularyManager.getAllItems(), currentStepDesc)

    log('INFO', 'plan_ts_focus_synced', {
      focusCategories: this.currentFocusContext.focusCategories,
      totalItems: learningVocabularyManager.getSize(),
    })

    // ── EventBus 发射标准化焦点同步事件（Wallpaper 事件总线 Schema） ──
    eventBus.emit('plan.ts.focus.synced', {
      version: 1,
      focusCategories: this.currentFocusContext.focusCategories,
      recentConcepts: this.currentFocusContext.recentConcepts,
      currentStepDescription: this.currentFocusContext.currentStepDescription,
      timestamp: Date.now(),
    })

    return this.currentFocusContext
  }

  /**
   * 获取当前学习关注摘要文本（用于日志/UI）。
   */
  getFocusSummary(): string {
    if (!this.currentFocusContext) {
      this.syncFocusContext()
    }
    return this.currentFocusContext ? buildFocusSummary(this.currentFocusContext) : '【无活跃学习上下文】'
  }

  // ==================== 进度查询 ====================

  /**
   * 获取整体学习进度。
   */
  getProgress(): LearningProgress {
    const progress = learningVocabularyManager.getProgress()
    // 发射进度更新事件（防过度发射 — 只在外显调用时发射）
    this.emitProgressEvent()
    return progress
  }

  /**
   * 获取关注项列表（最高优先级的待学知识点）。
   */
  getPriorityItems(): LearningItem[] {
    return buildPriorityItems(learningVocabularyManager.getAllItems(), this.currentFocusContext || undefined)
  }

  /**
   * 应用遗忘曲线衰减。
   */
  applyForgettingDecay(): void {
    learningVocabularyManager.applyForgettingDecay()
    // 遗忘可能导致进度变化，通知壁纸侧更新
    this.emitProgressEvent()
  }

  // ==================== 内部方法 ====================

  /**
   * 从步骤描述中提取知识点名称。
   */
  private extractConceptsFromText(text: string): string[] {
    const concepts: string[] = []
    const allItems = learningVocabularyManager.getAllItems()

    for (const item of allItems) {
      const lowerName = item.name.toLowerCase()
      const lowerText = text.toLowerCase()
      if (lowerText.includes(lowerName)) {
        concepts.push(item.name)
      }
    }

    return concepts
  }

  /**
   * 从未掌握项构建步骤描述列表。
   * 按分类分组，每个分类生成一条步骤。
   */
  private buildStepDescriptions(unmastered: LearningItem[]): string[] {
    if (unmastered.length === 0) return []

    // 按分类分组
    const categoryMap = new Map<string, LearningItem[]>()
    for (const item of unmastered) {
      const cat = item.category
      if (!categoryMap.has(cat)) categoryMap.set(cat, [])
      categoryMap.get(cat)!.push(item)
    }

    const steps: string[] = []

    // 每个分类生成一条步骤
    for (const [category, items] of categoryMap) {
      const conceptNames = items.map((i) => i.name).join(', ')
      steps.push(`学习${category}: ${conceptNames}`)
    }

    // 添加综合复习和总结步骤
    if (steps.length > 0) {
      const masteredCount = learningVocabularyManager.getMasteredItems().length
      steps.push(`复习已掌握知识点: ${masteredCount} 个已掌握概念`)
      steps.push('总结与测试: 综合练习所有已学知识点')
    }

    return steps
  }

  /**
   * 构建计划描述文本。
   */
  private buildPlanDescription(progress: LearningProgress, unmasteredCount: number): string {
    const masteredCount = progress.masteredCount
    const totalCount = progress.totalItems

    const categoryBreakdown = progress.categorySummary
      .map((cs) => `${cs.category}(${cs.count}项, 掌握${Math.round(cs.avgMastery * 100)}%)`)
      .join(', ')

    return [
      `TypeScript 高级类型系统学习计划。`,
      `当前进度: 已掌握 ${masteredCount}/${totalCount} 个知识点。`,
      `待学习: ${unmasteredCount} 个知识点。`,
      `总体掌握率: ${Math.round(progress.overallMastery * 100)}%。`,
      `分类分布: ${categoryBreakdown}`,
      `提示: 系统将根据你的学习进度自动调整关注重点。`,
    ].join('\n')
  }

  /**
   * 获取当前活跃的学习计划。
   */
  private getCurrentLearningPlan(): DevPlan | undefined {
    const pm = this.planManager
    if (!pm) return undefined

    // 优先使用缓存的 activePlanId
    if (this.activePlanId) {
      const plan = pm.getPlan(this.activePlanId)
      if (plan && plan.status === 'active') return plan
    }

    // 回退到 PlanManager 的 getActivePlan()
    const activePlan = pm.getActivePlan()
    if (activePlan) {
      this.activePlanId = activePlan.id
    }
    return activePlan
  }

  /**
   * 获取当前正在进行的步骤描述。
   */
  private getCurrentStepDescription(plan: DevPlan): string | undefined {
    if (!plan.steps) return undefined
    const inProgress = plan.steps.find((s) => s.status === 'in_progress')
    if (inProgress) return inProgress.description
    // 没有进行中的，返回第一个待执行的
    const pending = plan.steps.find((s) => s.status === 'pending')
    return pending?.description
  }

  /**
   * 根据高频难点构建自适应调整策略。
   * 对应 AsrEvolutionManager 的补丁构建逻辑。
   */
  private buildAdjustmentStrategies(
    highFreqDifficulties: Array<{ conceptName: string; frequency: number; category: string }>,
  ): LearningStrategyChange[] {
    const strategies: LearningStrategyChange[] = []

    for (const diff of highFreqDifficulties) {
      // 策略 1：复习增强
      strategies.push({
        type: 'review_boost',
        description: `加强对 "${diff.conceptName}" 的复习（已困难 ${diff.frequency} 次）`,
        params: { concept: diff.conceptName, frequency: diff.frequency },
      })

      // 策略 2：如果某个分类反复出错，降低节奏
      if (diff.frequency >= DIFFICULTY_TRIGGER_THRESHOLD * 2) {
        strategies.push({
          type: 'pace_adjust',
          description: `降低 "${diff.conceptName}" 的学习节奏（高错误率）`,
          params: { concept: diff.conceptName, newPace: 'slow' },
        })
      }
    }

    return strategies
  }
}

/** 全局单例 */
export const planTypeScriptExecutor = new PlanTypeScriptExecutor()
