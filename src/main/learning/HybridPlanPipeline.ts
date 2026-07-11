/**
 * HybridPlanPipeline — 混合流水线编排器
 *
 * 将 Evolution 的处理流程嵌入 Plan:TypeScript 学习计划管线，
 * 在关键节点插入 Evolution 的判断逻辑，两条路径并行执行并交叉验证。
 *
 * 路径 A（原始路径）：PlanTypeScriptExecutor 原有流程
 * 路径 B（进化路径）：Evolution 方法论在学习域的映射应用
 *
 * 汇合点：
 * 1. step_planning       — 创建学习计划 / 建议下一步时
 * 2. difficulty          — 记录学习困难时
 * 3. strategy            — 自动调整学习策略时
 * 4. progress_evaluation — 评估学习进度时
 *
 * 集成方式：
 * - HybridPlanPipeline 包装 PlanTypeScriptExecutor，
 *   在其每个关键节点处插入双路径并行和交叉验证
 * - 通过 EventBus 发射仲裁事件供其他组件消费
 * - 仲裁结果可通过 getLastResult() 查询
 */

import { log } from '../logger/Logger'
import { eventBus } from '../core/EventBus'
import { learningVocabularyManager } from './LearningVocabularyManager'
import { learningProgressTracker } from './LearningProgressTracker'
import { PlanTypeScriptExecutor } from './PlanTypeScriptExecutor'
import { HybridArbitrator } from './HybridArbitrator'
import { DEFAULT_HYBRID_CONFIG } from './HybridTypes'
import type {
  HybridPathOutput,
  ConvergenceResult,
  ConvergencePointName,
  StepSuggestion,
  DifficultyAssessmentOutput,
  StrategySuggestion,
  ProgressEvaluationOutput,
  HybridPipelineConfig,
  HybridPipelineMetrics,
} from './HybridTypes'
import type { LearningItem, LearningDifficulty, LearningCategory } from './types'
import type { LearningStrategyChange } from './LearningProgressTracker'

// =============================================================================
// 常量
// =============================================================================

/** 进化路径的基线置信度 */
const EVOLUTION_BASE_CONFIDENCE = 0.65

/** 原始路径的基线置信度 */
const ORIGINAL_BASE_CONFIDENCE = 0.75

/** 进化路径分析使用的困难回顾窗口（毫秒）*/
const EVOLUTION_DIFFICULTY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000 // 7 天

/** 进化路径的难度阈值（频次 >= 此值视为高难度）*/
const EVOLUTION_DIFFICULTY_THRESHOLD = 2

// =============================================================================
// HybridPlanPipeline
// =============================================================================

export class HybridPlanPipeline {
  /** 底层 PlanTypeScriptExecutor 实例 */
  private executor: PlanTypeScriptExecutor

  /** 仲裁器 */
  private arbitrator: HybridArbitrator

  /** 混合流水线配置 */
  private config: HybridPipelineConfig

  /** 最近一次各汇合点的仲裁结果 */
  private lastResults = new Map<ConvergencePointName, ConvergenceResult<unknown>>()

  /** 运行计数 */
  private convergenceCounts: Record<ConvergencePointName, number> = {
    step_planning: 0,
    difficulty: 0,
    strategy: 0,
    progress_evaluation: 0,
  }

  /** 是否已初始化 */
  private initialized = false

  // =============================================================================
  // 构造
  // =============================================================================

  constructor(
    executor: PlanTypeScriptExecutor,
    config?: Partial<HybridPipelineConfig>,
  ) {
    this.executor = executor
    this.config = { ...DEFAULT_HYBRID_CONFIG, ...config }
    this.arbitrator = new HybridArbitrator(config)
  }

  /**
   * 初始化混合流水线：验证 executor 状态并发射就绪事件。
   */
  init(): void {
    if (this.initialized) return
    this.initialized = true
    log('INFO', 'hybrid_pipeline_init', {
      enabled: this.config.enabled,
      originalWeight: this.config.originalPathWeight,
      evolutionWeight: this.config.evolutionPathWeight,
      divergenceThreshold: this.config.divergenceThreshold,
    })
    eventBus.emit('hybrid.pipeline.initialized', {
      config: this.config,
      timestamp: Date.now(),
    })
  }

  /**
   * 获取底层 executor 的引用。
   */
  getExecutor(): PlanTypeScriptExecutor {
    return this.executor
  }

  /**
   * 获取仲裁器引用。
   */
  getArbitrator(): HybridArbitrator {
    return this.arbitrator
  }

  /**
   * 检查混合流水线是否已启用。
   */
  isEnabled(): boolean {
    return this.config.enabled
  }

  /**
   * 启用/禁用混合流水线。
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled
    log('INFO', 'hybrid_pipeline_enabled', { enabled })
  }

  // =============================================================================
  // 汇合点 1：步骤规划（创建学习计划 / 建议下一步）
  // =============================================================================

  /**
   * 生成步骤建议的双路径并行与交叉验证版本。
   *
   * 路径 A（原始）：从未掌握项按分类分组生成步骤
   * 路径 B（进化）：从困难模式、分类分布、趋势数据生成步骤
   *
   * @returns 仲裁后的步骤建议列表，或 null（所有知识点已掌握）
   */
  createLearningPlan(): StepSuggestion[] | null {
    if (!this.config.enabled) {
      // 禁用时回退到原始路径
      const plan = this.executor.createLearningPlan()
      if (!plan) return null
      return plan.steps.map((s, i) => ({
        description: s.description,
        priority: i,
      }))
    }

    // ── 路径 A：原始路径 ──
    const originalSteps = this.runOriginalStepPlanning()

    // ── 路径 B：进化路径 ──
    const evolutionSteps = this.runEvolutionStepPlanning()

    // ── 汇合：交叉验证 ──
    if (!originalSteps && !evolutionSteps) return null
    if (!originalSteps) {
      log('INFO', 'hybrid_step_planning_evolution_only')
      return evolutionSteps
    }
    if (!evolutionSteps) {
      log('INFO', 'hybrid_step_planning_original_only')
      return originalSteps
    }

    const originalOutput: HybridPathOutput<StepSuggestion[]> = {
      path: 'original',
      output: originalSteps,
      confidence: ORIGINAL_BASE_CONFIDENCE,
      metadata: { source: 'learning_vocabulary' },
    }
    const evolutionOutput: HybridPathOutput<StepSuggestion[]> = {
      path: 'evolution',
      output: evolutionSteps,
      confidence: EVOLUTION_BASE_CONFIDENCE,
      metadata: { source: 'difficulty_pattern_analysis' },
    }

    const result = this.arbitrator.arbitrate<StepSuggestion[]>(
      'step_planning',
      originalOutput,
      evolutionOutput,
    )

    this.recordConvergence('step_planning', result)

    // 发射仲裁事件
    eventBus.emit('hybrid.step_planning.completed', {
      point: 'step_planning',
      divergenceScore: result.divergenceScore,
      method: result.arbitrationMethod,
      stepCount: result.arbitratedOutput.length,
      timestamp: Date.now(),
    })

    return result.arbitratedOutput
  }

  /**
   * 原始路径的步骤规划：从 LearningVocabularyManager 获取未掌握项。
   */
  private runOriginalStepPlanning(): StepSuggestion[] | null {
    const unmastered = learningVocabularyManager.getUnmasteredItems()
    if (unmastered.length === 0) return null

    const categoryMap = new Map<string, LearningItem[]>()
    for (const item of unmastered) {
      const cat = item.category
      if (!categoryMap.has(cat)) categoryMap.set(cat, [])
      categoryMap.get(cat)!.push(item)
    }

    const steps: StepSuggestion[] = []
    let priority = 0
    for (const [category, items] of categoryMap) {
      const conceptNames = items.map((i) => i.name).join(', ')
      steps.push({
        description: `学习${category}: ${conceptNames}`,
        priority: priority++,
        category: category as LearningCategory,
      })
    }

    // 添加复习和总结步骤
    if (steps.length > 0) {
      const masteredCount = learningVocabularyManager.getMasteredItems().length
      steps.push({
        description: `复习已掌握知识点: ${masteredCount} 个已掌握概念`,
        priority: priority++,
      })
      steps.push({
        description: '总结与测试: 综合练习所有已学知识点',
        priority: priority++,
      })
    }

    return steps
  }

  /**
   * 进化路径的步骤规划：基于困难模式分析和分类分布。
   */
  private runEvolutionStepPlanning(): StepSuggestion[] | null {
    learningVocabularyManager.initialize()
    learningProgressTracker.load()

    const unmastered = learningVocabularyManager.getUnmasteredItems()
    if (unmastered.length === 0) return null

    // 1. 获取困难模式
    learningProgressTracker.setGetItemsFn(() => learningVocabularyManager.getAllItems())
    const difficultyPatterns = learningProgressTracker.getDifficultyPatterns(
      Date.now() - EVOLUTION_DIFFICULTY_LOOKBACK_MS,
    )

    // 2. 建立分类 → 困难指数的映射
    const categoryDifficultyMap = new Map<string, { frequency: number; concepts: Set<string> }>()
    for (const pattern of difficultyPatterns) {
      const cat = pattern.category
      if (!categoryDifficultyMap.has(cat)) {
        categoryDifficultyMap.set(cat, { frequency: 0, concepts: new Set() })
      }
      const entry = categoryDifficultyMap.get(cat)!
      entry.frequency += pattern.frequency
      entry.concepts.add(pattern.conceptName)
    }

    // 3. 按困难指数对分类排序（困难最高的优先）
    const categoriesByDifficulty = Array.from(categoryDifficultyMap.entries())
      .sort(([, a], [, b]) => b.frequency - a.frequency)

    // 4. 建立分类 → 未掌握项的映射
    const categoryItemMap = new Map<string, LearningItem[]>()
    for (const item of unmastered) {
      const cat = item.category
      if (!categoryItemMap.has(cat)) categoryItemMap.set(cat, [])
      categoryItemMap.get(cat)!.push(item)
    }

    // 5. 按困难指数排序生成步骤（高困难项优先）
    const steps: StepSuggestion[] = []
    const addedCategories = new Set<string>()
    let priority = 0

    // 先处理有困难模式的分类
    for (const [category] of categoriesByDifficulty) {
      const items = categoryItemMap.get(category) || []
      if (items.length === 0) continue
      addedCategories.add(category)
      const difficultyInfo = categoryDifficultyMap.get(category)!
      const conceptNames = items.map((i) => i.name).join(', ')
      steps.push({
        description: `学习${category}: ${conceptNames}`,
        priority: priority++,
        category: category as LearningCategory,
        weight: 1 + (difficultyInfo.frequency / 10),
      })
    }

    // 再处理无困难模式的分类
    for (const [category, items] of categoryItemMap) {
      if (addedCategories.has(category)) continue
      const conceptNames = items.map((i) => i.name).join(', ')
      steps.push({
        description: `学习${category}: ${conceptNames}`,
        priority: priority++,
        category: category as LearningCategory,
      })
    }

    // 进化路径的复习步骤：优先复习高错误率项
    if (steps.length > 0) {
      const masteredCount = learningVocabularyManager.getMasteredItems().length
      steps.push({
        description: `难度强化复习: 针对 ${difficultyPatterns.length} 个困难模式进行针对性练习`,
        priority: priority++,
      })
      steps.push({
        description: `复习已掌握知识点: ${masteredCount} 个已掌握概念`,
        priority: priority++,
      })
    }

    return steps
  }

  // =============================================================================
  // 汇合点 2：困难记录
  // =============================================================================

  /**
   * 记录学习困难的双路径版本。
   *
   * 路径 A（原始）：直接记录并更新掌握度
   * 路径 B（进化）：分析困难根因，追加深度分类
   */
  recordDifficulty(conceptName: string, description: string): void {
    if (!this.config.enabled) {
      this.executor.recordDifficulty(conceptName, description)
      return
    }

    // ── 路径 A：原始路径 ──
    const originalAssessment = this.runOriginalDifficulty(conceptName, description)

    // ── 路径 B：进化路径 ──
    const evolutionAssessment = this.runEvolutionDifficulty(conceptName, description)

    // ── 汇合：交叉验证 ──
    const result = this.arbitrator.arbitrate<DifficultyAssessmentOutput>(
      'difficulty',
      {
        path: 'original',
        output: originalAssessment,
        confidence: ORIGINAL_BASE_CONFIDENCE,
      },
      {
        path: 'evolution',
        output: evolutionAssessment,
        confidence: EVOLUTION_BASE_CONFIDENCE + 0.05, // 进化路径在分类上有额外分析
        metadata: { difficultyPatterns: evolutionAssessment.frequency },
      },
    )

    // 应用仲裁结果：使用仲裁后的分类
    const finalCategory = result.arbitratedOutput.category
    learningProgressTracker.recordDifficulty(
      conceptName.toLowerCase(),
      conceptName,
      description,
      finalCategory as any,
    )
    learningVocabularyManager.recordInteraction(conceptName, false)

    this.recordConvergence('difficulty', result)

    log('INFO', 'hybrid_difficulty_recorded', {
      concept: conceptName,
      originalCategory: originalAssessment.category,
      evolutionCategory: evolutionAssessment.category,
      finalCategory,
      divergenceScore: result.divergenceScore.toFixed(3),
      method: result.arbitrationMethod,
    })

    eventBus.emit('hybrid.difficulty.recorded', {
      point: 'difficulty',
      conceptName,
      finalCategory,
      divergenceScore: result.divergenceScore,
      method: result.arbitrationMethod,
      timestamp: Date.now(),
    })
  }

  /**
   * 原始路径的困难评估。
   */
  private runOriginalDifficulty(conceptName: string, description: string): DifficultyAssessmentOutput {
    // 使用原有分类逻辑（LearningProgressTracker 的 classifyDifficulty）
    return {
      conceptId: conceptName.toLowerCase(),
      conceptName,
      category: this.inferCategoryFromText(description),
      frequency: 1,
      description,
    }
  }

  /**
   * 进化路径的困难评估：分析根因，参考历史困难模式。
   */
  private runEvolutionDifficulty(conceptName: string, description: string): DifficultyAssessmentOutput {
    const lookupMs = EVOLUTION_DIFFICULTY_LOOKBACK_MS
    const patterns = learningProgressTracker.getDifficultyPatterns(Date.now() - lookupMs)

    // 查找同一知识点的历史困难记录
    const relatedPatterns = patterns.filter(
      (p) => p.conceptName.toLowerCase() === conceptName.toLowerCase(),
    )

    const baseFrequency = relatedPatterns.length > 0
      ? relatedPatterns.reduce((s, p) => s + p.frequency, 0)
      : 1

    // 进化路径的深度分类：综合分析描述文本
    const category = this.evolutionClassifyDifficulty(description, conceptName, patterns)

    return {
      conceptId: conceptName.toLowerCase(),
      conceptName,
      category,
      frequency: baseFrequency + 1,
      description: relatedPatterns.length > 0
        ? `${description}（历史出现 ${baseFrequency} 次）`
        : description,
    }
  }

  // =============================================================================
  // 汇合点 3：策略调整
  // =============================================================================

  /**
   * 自动调整学习策略的双路径版本。
   *
   * 路径 A（原始）：基于高频困难直接构建策略
   * 路径 B（进化）：基于策略上下文选择和元评估
   */
  autoAdjustStrategy(): void {
    if (!this.config.enabled) {
      this.executor.autoAdjustStrategy()
      return
    }

    // ── 路径 A：原始路径 ──
    const originalStrategies = this.runOriginalStrategyAdjustment()

    // ── 路径 B：进化路径 ──
    const evolutionStrategies = this.runEvolutionStrategyAdjustment()

    // ── 汇合：交叉验证 ──
    if (originalStrategies.length === 0 && evolutionStrategies.length === 0) return

    if (originalStrategies.length === 0) {
      this.applyStrategies(evolutionStrategies)
      return
    }
    if (evolutionStrategies.length === 0) {
      this.applyStrategies(originalStrategies)
      return
    }

    const originalOutput: HybridPathOutput<StrategySuggestion[]> = {
      path: 'original',
      output: originalStrategies,
      confidence: ORIGINAL_BASE_CONFIDENCE,
    }
    const evolutionOutput: HybridPathOutput<StrategySuggestion[]> = {
      path: 'evolution',
      output: evolutionStrategies,
      confidence: EVOLUTION_BASE_CONFIDENCE + 0.1, // 进化路径有更全局的视角
    }

    const result = this.arbitrator.arbitrate<StrategySuggestion[]>(
      'strategy',
      originalOutput,
      evolutionOutput,
    )

    this.recordConvergence('strategy', result)

    // 应用仲裁后的策略
    this.applyFusedStrategies(result.arbitratedOutput)

    log('INFO', 'hybrid_strategy_adjusted', {
      originalCount: originalStrategies.length,
      evolutionCount: evolutionStrategies.length,
      fusedCount: result.arbitratedOutput.length,
      divergenceScore: result.divergenceScore.toFixed(3),
      method: result.arbitrationMethod,
    })

    eventBus.emit('hybrid.strategy.adjusted', {
      point: 'strategy',
      divergenceScore: result.divergenceScore,
      method: result.arbitrationMethod,
      strategies: result.arbitratedOutput.map((s) => ({ type: s.type, confidence: s.confidence })),
      timestamp: Date.now(),
    })
  }

  /**
   * 原始路径的策略构建。
   */
  private runOriginalStrategyAdjustment(): StrategySuggestion[] {
    const patterns = learningProgressTracker.getDifficultyPatterns()
    if (patterns.length === 0) return []

    const highFreq = patterns.filter((p) => p.frequency >= 3)
    if (highFreq.length === 0) return []

    const strategies: StrategySuggestion[] = []

    for (const diff of highFreq) {
      strategies.push({
        type: 'review_boost',
        description: `加强对 "${diff.conceptName}" 的复习（已困难 ${diff.frequency} 次）`,
        params: { concept: diff.conceptName, frequency: diff.frequency },
        confidence: Math.min(0.9, 0.5 + diff.frequency * 0.1),
      })

      if (diff.frequency >= 6) {
        strategies.push({
          type: 'pace_adjust',
          description: `降低 "${diff.conceptName}" 的学习节奏（高错误率）`,
          params: { concept: diff.conceptName, newPace: 'slow' },
          confidence: 0.7,
        })
      }
    }

    return strategies
  }

  /**
   * 进化路径的策略构建：基于元分析的多维度策略选择。
   */
  private runEvolutionStrategyAdjustment(): StrategySuggestion[] {
    const now = Date.now()
    const patterns = learningProgressTracker.getDifficultyPatterns(now - EVOLUTION_DIFFICULTY_LOOKBACK_MS)
    if (patterns.length === 0) return []

    // 1. 分析困难分布
    const categoryFreq = new Map<string, number>()
    for (const p of patterns) {
      categoryFreq.set(p.category, (categoryFreq.get(p.category) || 0) + p.frequency)
    }

    // 2. 分析分类掌握度
    const items = learningVocabularyManager.getAllItems()
    const categoryMastery = new Map<string, number>()
    for (const item of items) {
      const prev = categoryMastery.get(item.category) || 0
      categoryMastery.set(item.category, prev + item.mastery)
    }
    for (const [cat, total] of categoryMastery) {
      const count = items.filter((i) => i.category === cat).length
      categoryMastery.set(cat, count > 0 ? total / count : 0)
    }

    const strategies: StrategySuggestion[] = []

    // 策略 1：关注高频困难分类的 focus_shift
    const highDifficultyCategories = Array.from(categoryFreq.entries())
      .filter(([, freq]) => freq >= EVOLUTION_DIFFICULTY_THRESHOLD)
      .sort(([, a], [, b]) => b - a)

    for (const [category, freq] of highDifficultyCategories.slice(0, 2)) {
      const avgMastery = categoryMastery.get(category) || 0
      strategies.push({
        type: 'focus_shift',
        description: `将学习重心转向 "${category}"（困难频次 ${freq}，当前掌握度 ${(avgMastery * 100).toFixed(0)}%）`,
        params: { targetCategory: category, difficultyFrequency: freq, currentMastery: avgMastery },
        confidence: Math.min(0.95, 0.5 + freq * 0.08),
      })
    }

    // 策略 2：掌握度最低的分类 → 难度调整
    const lowestMasteryCategories = Array.from(categoryMastery.entries())
      .filter(([, mastery]) => mastery < 0.3)
      .sort(([, a], [, b]) => a - b)

    for (const [category, mastery] of lowestMasteryCategories.slice(0, 1)) {
      strategies.push({
        type: 'difficulty_change',
        description: `降低 "${category}" 的学习难度（当前掌握度仅 ${(mastery * 100).toFixed(0)}%）`,
        params: { targetCategory: category, currentMastery: mastery, newDifficulty: 'easier' },
        confidence: 0.75,
      })
    }

    // 策略 3：整体进步停滞时 → pace_adjust
    const allMasteryAvg = items.length > 0
      ? items.reduce((s, i) => s + i.mastery, 0) / items.length
      : 0
    if (allMasteryAvg < 0.3 && patterns.length > 5) {
      strategies.push({
        type: 'pace_adjust',
        description: `整体掌握度过低 (${(allMasteryAvg * 100).toFixed(0)}%)，建议放慢节奏`,
        params: { overallMastery: allMasteryAvg, difficultyCount: patterns.length },
        confidence: 0.7,
      })
    }

    return strategies
  }

  // =============================================================================
  // 汇合点 4：进度评估
  // =============================================================================

  /**
   * 评估学习进度的双路径版本。
   *
   * 路径 A（原始）：LearningProgressTracker 的前后对比
   * 路径 B（进化）：多维度趋势分析 + 严格验证
   */
  evaluateProgress(snapshotId?: string): ProgressEvaluationOutput {
    if (!this.config.enabled) {
      const result = learningProgressTracker.evaluateAndDecide(snapshotId)
      return {
        verdict: result.verdict,
        action: result.action,
        confidence: 0.7,
        rationale: `原始路径评估: ${result.verdict}`,
      }
    }

    // ── 路径 A：原始路径 ──
    const originalResult = learningVocabularyManager.getProgress()
    const originalEval = learningProgressTracker.evaluateAndDecide(snapshotId)

    const originalOutput: HybridPathOutput<ProgressEvaluationOutput> = {
      path: 'original',
      output: {
        verdict: originalEval.verdict,
        action: originalEval.action,
        confidence: ORIGINAL_BASE_CONFIDENCE,
        rationale: `原始路径: 掌握度评估 ${originalResult.overallMastery}，准确率 ${originalResult.overallAccuracy}`,
      },
      confidence: ORIGINAL_BASE_CONFIDENCE,
    }

    // ── 路径 B：进化路径 ──
    const evolutionOutput: HybridPathOutput<ProgressEvaluationOutput> = {
      path: 'evolution',
      output: this.runEvolutionProgressEvaluation(snapshotId),
      confidence: EVOLUTION_BASE_CONFIDENCE + 0.1,
    }

    // ── 汇合：交叉验证 ──
    const result = this.arbitrator.arbitrate<ProgressEvaluationOutput>(
      'progress_evaluation',
      originalOutput,
      evolutionOutput,
    )

    this.recordConvergence('progress_evaluation', result)

    log('INFO', 'hybrid_progress_evaluated', {
      originalVerdict: originalEval.verdict,
      evolutionVerdict: evolutionOutput.output.verdict,
      finalVerdict: result.arbitratedOutput.verdict,
      divergenceScore: result.divergenceScore.toFixed(3),
      method: result.arbitrationMethod,
    })

    eventBus.emit('hybrid.progress.evaluated', {
      point: 'progress_evaluation',
      divergenceScore: result.divergenceScore,
      method: result.arbitrationMethod,
      verdict: result.arbitratedOutput.verdict,
      action: result.arbitratedOutput.action,
      timestamp: Date.now(),
    })

    return result.arbitratedOutput
  }

  /**
   * 进化路径的进度评估：多维度严格分析。
   */
  private runEvolutionProgressEvaluation(snapshotId?: string): ProgressEvaluationOutput {
    const items = learningVocabularyManager.getAllItems()
    const progress = learningVocabularyManager.getProgress()
    const patterns = learningProgressTracker.getDifficultyPatterns(
      Date.now() - EVOLUTION_DIFFICULTY_LOOKBACK_MS,
    )

    // 维度 1：掌握度变化趋势
    if (snapshotId) {
      const evalVerdict = learningProgressTracker.evaluateSnapshot(snapshotId)
      if (evalVerdict !== 'not_found') {
        // 进化路径在 evaluateSnapshot 基础上增加严格条件
        switch (evalVerdict) {
          case 'improved':
            // 验证改进是否扎实：检查困难模式是否同时减少
            if (patterns.length <= 5) {
              return {
                verdict: 'improved',
                action: 'keep',
                confidence: 0.8,
                rationale: `掌握度提升 + 困难模式可控 (${patterns.length} 个)`,
              }
            }
            // 掌握度提升但困难仍然多 → 保守判定
            return {
              verdict: 'unchanged',
              action: 'no_action',
              confidence: 0.65,
              rationale: `掌握度提升但仍有 ${patterns.length} 个困难模式，需继续观察`,
            }
          case 'worsened':
            return {
              verdict: 'worsened',
              action: 'rollback',
              confidence: 0.85,
              rationale: `掌握度下降，建议回滚`,
            }
          case 'unchanged':
            return {
              verdict: 'unchanged',
              action: 'no_action',
              confidence: 0.7,
              rationale: `掌握度无明显变化`,
            }
        }
      }
    }

    // 维度 2：整体健康度分析
    const allMasteryAvg = progress.overallMastery
    const allAccuracy = progress.overallAccuracy

    if (allMasteryAvg >= 0.8 && patterns.length <= 3) {
      return {
        verdict: 'improved',
        action: 'keep',
        confidence: 0.9,
        rationale: `掌握度 ${(allMasteryAvg * 100).toFixed(0)}%，准确率 ${(allAccuracy * 100).toFixed(0)}%，困难模式少`,
      }
    }

    if (allMasteryAvg >= 0.6 && allAccuracy >= 0.7) {
      return {
        verdict: 'improved',
        action: 'keep',
        confidence: 0.7,
        rationale: `掌握度 ${(allMasteryAvg * 100).toFixed(0)}%，准确率 ${(allAccuracy * 100).toFixed(0)}%`,
      }
    }

    if (patterns.length > 10 && allAccuracy < 0.4) {
      return {
        verdict: 'worsened',
        action: 'rollback',
        confidence: 0.75,
        rationale: `困难模式过多 (${patterns.length})，准确率低 ${(allAccuracy * 100).toFixed(0)}%`,
      }
    }

    return {
      verdict: 'unchanged',
      action: 'no_action',
      confidence: 0.6,
      rationale: `综合评估：掌握度 ${(allMasteryAvg * 100).toFixed(0)}%，准确率 ${(allAccuracy * 100).toFixed(0)}%，困难 ${patterns.length} 个`,
    }
  }

  // =============================================================================
  // 内部方法
  // =============================================================================

  /**
   * 记录一次汇合。
   */
  private recordConvergence(point: ConvergencePointName, result: ConvergenceResult<unknown>): void {
    this.convergenceCounts[point]++
    this.lastResults.set(point, result)
  }

  /**
   * 应用策略列表（原始路径格式 → LearningProgressTracker）。
   */
  private applyStrategies(strategies: StrategySuggestion[]): void {
    for (const s of strategies) {
      const change: LearningStrategyChange = {
        type: s.type,
        description: s.description,
        params: s.params,
      }
      learningProgressTracker.applyLearningStrategy(change)
    }
  }

  /**
   * 应用融合后的策略列表。
   * 按置信度排序后依次应用。
   */
  private applyFusedStrategies(strategies: StrategySuggestion[]): void {
    // 按置信度降序排列，高置信度策略优先应用
    const sorted = [...strategies].sort((a, b) => b.confidence - a.confidence)
    for (const s of sorted) {
      const change: LearningStrategyChange = {
        type: s.type,
        description: s.description,
        params: s.params,
      }
      const result = learningProgressTracker.applyLearningStrategy(change)
      if (result) {
        log('INFO', 'hybrid_strategy_applied', {
          type: s.type,
          confidence: s.confidence.toFixed(2),
          snapshotId: result.snapshotId,
        })
      }
    }
  }

  // =============================================================================
  // 工具方法
  // =============================================================================

  /**
   * 从文本推断分类（原始路径使用）。
   */
  private inferCategoryFromText(text: string): string {
    const lower = text.toLowerCase()
    if (/type.*mismatch|不匹配|类型错误/.test(lower)) return 'type_mismatch'
    if (/syntax|语法/.test(lower)) return 'syntax_error'
    if (/generic.*constraint|extends.*bound|约束/.test(lower)) return 'generic_bound'
    if (/conditional|条件.*逻辑/.test(lower)) return 'conditional_logic'
    if (/mapped|映射.*transform/.test(lower)) return 'mapped_transform'
    if (/infer|推断/.test(lower)) return 'inference_failure'
    if (/understand|理解|confus/.test(lower)) return 'concept_misunderstanding'
    return 'unknown'
  }

  /**
   * 进化路径的困难分类：结合描述 + 历史上下文。
   */
  private evolutionClassifyDifficulty(
    description: string,
    conceptName: string,
    patterns: LearningDifficulty[],
  ): string {
    const lower = description.toLowerCase()
    const lowerConcept = conceptName.toLowerCase()

    // 1. 基于概念名称的推断
    if (/conditional|extends\?|infer/.test(lowerConcept)) return 'conditional_logic'
    if (/mapped|keyof/.test(lowerConcept)) return 'mapped_transform'
    if (/generic|<t>|type parameter/.test(lowerConcept)) return 'generic_bound'
    if (/union|intersection/.test(lowerConcept)) return 'type_mismatch'
    if (/template|literal/.test(lowerConcept)) return 'concept_misunderstanding'

    // 2. 基于描述文本
    if (/type.*mismatch|类型不匹配/.test(lower)) return 'type_mismatch'
    if (/syntax|语法/.test(lower)) return 'syntax_error'
    if (/constraint|bound|约束/.test(lower)) return 'generic_bound'
    if (/conditional|条件.*逻辑/.test(lower)) return 'conditional_logic'
    if (/mapped|映射|transform/.test(lower)) return 'mapped_transform'
    if (/infer|推断/.test(lower)) return 'inference_failure'
    if (/understand|理解|confus/.test(lower)) return 'concept_misunderstanding'

    // 3. 参考历史模式中最常见的分类
    if (patterns.length > 0) {
      const categoryCount = new Map<string, number>()
      for (const p of patterns) {
        if (p.conceptName.toLowerCase() === lowerConcept) {
          categoryCount.set(p.category, (categoryCount.get(p.category) || 0) + p.frequency)
        }
      }
      if (categoryCount.size > 0) {
        const mostCommon = Array.from(categoryCount.entries()).sort(([, a], [, b]) => b - a)
        return mostCommon[0][0]
      }
    }

    return 'unknown'
  }

  // =============================================================================
  // 查询接口
  // =============================================================================

  /**
   * 获取指定汇合点的最近一次仲裁结果。
   */
  getLastResult(point: ConvergencePointName): ConvergenceResult<unknown> | undefined {
    return this.lastResults.get(point)
  }

  /**
   * 获取混合流水线运行指标。
   */
  getMetrics(): HybridPipelineMetrics {
    const total = Object.values(this.convergenceCounts).reduce((s, c) => s + c, 0)
    const arbMetrics = this.arbitrator.getMetrics()
    return {
      totalConvergences: total,
      perPointCount: { ...this.convergenceCounts },
      perMethodCount: { ...arbMetrics.perMethodCount },
      avgDivergence: arbMetrics.avgDivergence,
      lastRunAt: Date.now(),
    }
  }
}
