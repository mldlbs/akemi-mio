/**
 * ModelScheduler — 个性化语音模型自适应调度器
 *
 * ── 职责 ──
 *
 * 收集用户使用 PiperTTS 的时间模式、手动切换模型记录以及对话情感分析结果，
 * 通过规则 + 简单统计学习预测最佳模型，在 PiperOrchestrator 中实现自动模型切换。
 *
 * ── 学习算法 ──
 *
 * 1. 规则层（权重 20%）：
 *    - 时段映射：morning/afternoon → huayan（标准）, evening/late_night → ling_ling（柔和）
 *    - 星期映射：weekday → huayan（工作）, weekend → ling_ling（休闲）
 *    - 深夜时段置信度最高（0.8），午后最低（0.3）
 *
 * 2. 统计学习层（权重 80%）：
 *    - 将一周划分为 4(时段)×7(天) = 28 个槽位
 *    - 每个槽位统计各模型的使用次数，按反馈类型加权
 *    - 用户手动切换权重更高（×3 系数）
 *    - 正反馈（重听 COMPLETED_NATURALLY）权重 +1，负反馈（SKIP/打断）权重 -1
 *
 * 3. 混合预测：
 *    - 规则推荐 × ruleWeight + 学习推荐 × (1 − ruleWeight)
 *    - 当学习置信度不足时（样本 < minSamplesForLearning），纯规则预测
 *    - 混合置信度超过 threshold 时触发自动切换
 *
 * ── 用户锁定 ──
 *
 * 用户可通过 IPC 锁定某个模型，锁定后调度器不再自动切换。
 * 锁定可以通过 IPC 解锁恢复自动调度。
 *
 * ── 风险控制 ──
 *
 * - 冷却期：每次切换后 5 分钟内不再自动切换（switchCooldownMs）
 * - 温启动：切换后 1 分钟内首次合成的延迟不计入负面评价（warmUpPeriodMs）
 * - 置信度门槛：0.6 以下不切换
 * - 用户手动切换后，会抑制近期自动切换
 *
 * ── 集成点 ──
 *
 * - PiperOrchestrator.switchModel(): 在切换模型时通知
 * - TtsPiperBridge.buildPiperRequest(): 集成预测到模型选择链
 * - IPC: 提供给渲染进程的用户界面控制
 * - 持久化: JSON 文件存储学习数据
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { log } from '@akemi-mio/core/logger/Logger'
import { PIPER_MODEL_CATALOG, DEFAULT_PIPER_MODEL } from './PiperOrchestrator'
import type { DayPeriod } from './types'
import type {
  ModelUsageLogEntry,
  ModelSelectionSource,
  ModelSlotStat,
  SlotStats,
  ModelPrediction,
  ModelSchedulerConfig,
  ModelSchedulerPersistedData,
  ModelSchedulerState,
  TimeSlotKey,
  DayOfWeek,
} from './ModelSchedulerTypes'
import {
  DEFAULT_MODEL_SCHEDULER_CONFIG,
  DAY_PERIOD_MODEL_MAP,
  DAY_PERIOD_CONFIDENCE,
  DAY_OF_WEEK_MODEL_MAP,
  buildTimeSlotKey,
  getCurrentDayPeriod,
  getCurrentDayOfWeek,
  getCurrentSlotKey,
} from './ModelSchedulerTypes'

// ══════════════════════════════════════════
//  持久化版本
// ══════════════════════════════════════════

const PERSISTENCE_VERSION = 1

/** 默认持久化路径（实际路径在 initialize 时根据 WORKSPACE 设置） */
const DEFAULT_PERSISTENCE_RELATIVE_PATH = 'model_scheduler.json'
const DEFAULT_STORAGE_DIR = 'scheduler'

// ══════════════════════════════════════════
//  模型白名单（仅调度器支持的模型）
// ══════════════════════════════════════════

const VALID_SCHEDULER_MODELS = Object.keys(PIPER_MODEL_CATALOG)

// ══════════════════════════════════════════
//  工具常量
// ══════════════════════════════════════════

/** 用户手动选择权重系数 */
const MANUAL_SELECTION_WEIGHT_MULTIPLIER = 3

/** 正反馈权重 */
const POSITIVE_FEEDBACK_WEIGHT = 1.0

/** 负反馈权重 */
const NEGATIVE_FEEDBACK_WEIGHT = -1.0

/** 中性/无反馈的基础权重 */
const NEUTRAL_WEIGHT = 0.1

// ══════════════════════════════════════════
//  类型：模型切换回调
// ══════════════════════════════════════════

/**
 * 模型切换回调 — 当调度器决定切换模型时调用。
 * 外部（如 TtsService）通过此回调执行实际的 PiperOrchestrator.switchModel()。
 */
export type ModelSwitchHandler = (model: string, source: string, reason: string) => { success: boolean; message: string }

// ══════════════════════════════════════════
//  ModelScheduler
// ══════════════════════════════════════════

export class ModelScheduler {
  /** 配置 */
  private config: ModelSchedulerConfig

  /** 使用日志 */
  private usageLogs: ModelUsageLogEntry[] = []

  /** 时段统计 */
  private slotStats: Record<TimeSlotKey, SlotStats> = {}

  /** 用户是否锁定了模型 */
  private locked = false

  /** 锁定的模型名 */
  private lockedModel: string | null = null

  /** 是否启用 */
  private enabled = true

  /** 总预测次数 */
  private totalPredictions = 0

  /** 被接受的预测次数 */
  private acceptedPredictions = 0

  /** 最近一次切换的时间戳 */
  private lastSwitchTimestamp = 0

  /** 当前缓存预测结果 */
  private cachedPrediction: ModelPrediction | null = null

  /** 缓存预测的槽位键 */
  private cachedPredictionSlotKey: string | null = null

  /** 外部模型切换回调（由 TtsService/AppRuntime 设置） */
  private onSwitchModel: ModelSwitchHandler | null = null

  /** 数据是否已加载 */
  private initialized = false

  /** 距上次用户手动切换的计数（最近 N 次合成内） */
  private recentManualSwitchCount = 0

  /** 合成本数（用于统计手动切换率） */
  private synthesisCount = 0

  // ── 构造 ──

  constructor(config?: Partial<ModelSchedulerConfig>) {
    this.config = { ...DEFAULT_MODEL_SCHEDULER_CONFIG, ...config }
    this.enabled = this.config.enabled
  }

  // ══════════════════════════════════════════
  //  初始化 & 持久化
  // ══════════════════════════════════════════

  /**
   * 初始化调度器，加载持久化数据。
   * @param storageDir 存储目录
   */
  initialize(storageDir?: string): void {
    if (this.initialized) return

    const dir = storageDir || DEFAULT_STORAGE_DIR
    this.config.persistencePath = dir
    this.loadFromDisk()
    this.initialized = true

    log('INFO', 'model_scheduler_initialized', {
      logCount: this.usageLogs.length,
      learnedSlots: Object.keys(this.slotStats).length,
      locked: this.locked,
      enabled: this.enabled,
      totalPredictions: this.totalPredictions,
    })
  }

  /**
   * 注册模型切换回调。
   * 外部设置此回调后，调度器可通过它实际执行模型切换。
   */
  setOnSwitchModel(handler: ModelSwitchHandler | null): void {
    this.onSwitchModel = handler
  }

  // ══════════════════════════════════════════
  //  数据采集
  // ══════════════════════════════════════════

  /**
   * 记录一次模型使用。
   * 在每次 PiperTTS 合成时调用，记录使用的模型和时间信息。
   */
  recordModelUsage(model: string, source: ModelSelectionSource, requestId?: string): void {
    if (!this.enabled) return

    // 验证模型名
    if (!VALID_SCHEDULER_MODELS.includes(model)) {
      // 不在调度器白名单中的模型（如 edge-tts voice），不记录
      return
    }

    const now = Date.now()
    const dayPeriod = getCurrentDayPeriod()
    const dayOfWeek = getCurrentDayOfWeek()
    const slotKey = getCurrentSlotKey()

    const entry: ModelUsageLogEntry = {
      timestamp: now,
      model,
      dayOfWeek,
      hour: new Date().getHours(),
      dayPeriod,
      slotKey,
      source,
      feedbackScore: 0,
      requestId,
    }

    this.usageLogs.push(entry)

    // 限制日志大小
    if (this.usageLogs.length > this.config.maxLogEntries) {
      this.usageLogs = this.usageLogs.slice(-this.config.maxLogEntries)
    }

    // 更新时段统计
    this.updateSlotStats(slotKey, model, source === 'manual' ? MANUAL_SELECTION_WEIGHT_MULTIPLIER : NEUTRAL_WEIGHT)

    // 更新手动切换计数
    this.synthesisCount++
    if (source === 'manual') {
      this.recentManualSwitchCount++
    } else {
      // 衰减手动切换计数（每 20 次合成衰减 1）
      if (this.synthesisCount % 20 === 0 && this.recentManualSwitchCount > 0) {
        this.recentManualSwitchCount--
      }
    }

    // 清除预测缓存（槽位变化时）
    this.cachedPrediction = null
    this.cachedPredictionSlotKey = null

    this.persist()
  }

  /**
   * 记录隐式反馈（与某次 TTS 输出的关联）。
   * 由 ImplicitFeedbackTracker 或 TtsPiperBridge 调用。
   */
  recordFeedback(requestId: string, positive: boolean): void {
    // 查找最近的匹配日志（按 requestId 或按时间就近）
    const entry = this.usageLogs.find((e) => e.requestId === requestId)
    if (!entry) {
      // 没有精确匹配，尝试找最近一次同时间段的记录
      const slotKey = getCurrentSlotKey()
      const recentEntry = [...this.usageLogs].reverse().find((e) => e.slotKey === slotKey && e.feedbackScore === 0)
      if (recentEntry) {
        recentEntry.feedbackScore += positive ? POSITIVE_FEEDBACK_WEIGHT : NEGATIVE_FEEDBACK_WEIGHT
        // 更新时段统计的加权分数
        this.adjustSlotStats(slotKey, recentEntry.model, positive ? POSITIVE_FEEDBACK_WEIGHT : NEGATIVE_FEEDBACK_WEIGHT)
      }
      return
    }

    const delta = positive ? POSITIVE_FEEDBACK_WEIGHT : NEGATIVE_FEEDBACK_WEIGHT
    entry.feedbackScore += delta
    this.adjustSlotStats(entry.slotKey, entry.model, delta)
  }

  // ══════════════════════════════════════════
  //  预测引擎
  // ══════════════════════════════════════════

  /**
   * 获取当前时段的模型预测。
   * 结果缓存到槽位改变前，避免重复计算。
   */
  getPrediction(): ModelPrediction {
    const slotKey = getCurrentSlotKey()

    // 缓存命中
    if (this.cachedPrediction && this.cachedPredictionSlotKey === slotKey) {
      return this.cachedPrediction
    }

    const dayPeriod = getCurrentDayPeriod()
    const dayOfWeek = getCurrentDayOfWeek()

    // ── 规则层 ──
    const ruleBasedModel = this.getRuleBasedRecommendation(dayPeriod, dayOfWeek)
    const ruleConfidence = DAY_PERIOD_CONFIDENCE[dayPeriod]

    // ── 学习层 ──
    const learnedResult = this.getLearnedRecommendation(slotKey)
    const hasSufficientData = (this.slotStats[slotKey]?.totalUsage ?? 0) >= this.config.minSamplesForLearning

    // ── 混合决策 ──
    let recommendedModel: string
    let confidence: number
    let reason: string

    if (!hasSufficientData || !learnedResult) {
      // 数据不足 → 纯规则
      recommendedModel = ruleBasedModel
      confidence = ruleConfidence
      reason = `规则预测: ${dayPeriod}时段 ${this.describeDayOfWeek(dayOfWeek)} → ${this.getModelDisplayName(ruleBasedModel)}`
    } else {
      // 混合预测
      const ruleWeight = this.config.ruleWeight
      const learnedWeight = 1 - ruleWeight

      // 如果学习推荐和规则推荐一致，置信度提升
      if (learnedResult.model === ruleBasedModel) {
        recommendedModel = ruleBasedModel
        confidence = Math.min(0.95, Math.max(ruleConfidence, learnedResult.confidence) + 0.15)
        reason = `规则+学习一致: ${dayPeriod} ${this.describeDayOfWeek(dayOfWeek)} → ${this.getModelDisplayName(recommendedModel)} (信度${(confidence * 100).toFixed(0)}%)`
      } else {
        // 不一致：按权重混合
        const blendedConfidence = ruleConfidence * ruleWeight + learnedResult.confidence * learnedWeight
        if (blendedConfidence >= this.config.autoSwitchConfidenceThreshold && learnedResult.confidence > ruleConfidence) {
          // 学习置信度更高且超阈值 → 用学习推荐
          recommendedModel = learnedResult.model
          confidence = blendedConfidence
          reason = `学习优先: 历史数据显示${this.describeDayOfWeek(dayOfWeek)}${dayPeriod}偏好${this.getModelDisplayName(learnedResult.model)} (信度${(confidence * 100).toFixed(0)}%)`
        } else {
          // 规则优先
          recommendedModel = ruleBasedModel
          confidence = ruleConfidence * ruleWeight + (learnedResult?.confidence ?? 0) * learnedWeight
          reason = `规则优先: ${dayPeriod}时段 ${this.getModelDisplayName(ruleBasedModel)} (信度${(confidence * 100).toFixed(0)}%)`
        }
      }
    }

    const prediction: ModelPrediction = {
      recommendedModel,
      confidence: Math.round(confidence * 100) / 100,
      ruleBasedRecommendation: ruleBasedModel,
      learnedRecommendation: learnedResult?.model ?? null,
      slotKey,
      dayPeriod,
      dayOfWeek,
      reason,
    }

    this.cachedPrediction = prediction
    this.cachedPredictionSlotKey = slotKey

    return prediction
  }

  /**
   * 尝试自动切换模型。
   * 内部调用 getPrediction() + 检查锁定/冷却/置信度条件。
   *
   * @returns 是否执行了切换，以及切换详情
   */
  tryAutoSwitch(): { switched: boolean; from?: string; to?: string; reason: string } {
    if (!this.enabled) {
      return { switched: false, reason: '调度器未启用' }
    }

    if (this.locked) {
      return { switched: false, reason: `用户锁定模型: ${this.lockedModel || '(未知)'}` }
    }

    // 冷却检查
    const now = Date.now()
    const cooldownRemaining = this.lastSwitchTimestamp + this.config.switchCooldownMs - now
    if (cooldownRemaining > 0) {
      return { switched: false, reason: `冷却中 (剩余 ${Math.round(cooldownRemaining / 1000)}s)` }
    }

    const prediction = this.getPrediction()

    if (prediction.confidence < this.config.autoSwitchConfidenceThreshold) {
      return {
        switched: false,
        reason: `置信度不足: ${(prediction.confidence * 100).toFixed(0)}% < ${(this.config.autoSwitchConfidenceThreshold * 100).toFixed(0)}%`,
      }
    }

    // 用户近期频繁手动切换 → 抑制自动切换
    if (this.recentManualSwitchCount >= 3 && this.synthesisCount >= 10) {
      const manualRate = this.recentManualSwitchCount / this.synthesisCount
      if (manualRate > 0.15) {
        return { switched: false, reason: `用户近期频繁手动切换 (${this.recentManualSwitchCount}/${this.synthesisCount})，抑制自动切换` }
      }
    }

    // 执行切换
    if (this.onSwitchModel) {
      const result = this.onSwitchModel(prediction.recommendedModel, 'scheduler', prediction.reason)
      if (result.success) {
        this.totalPredictions++
        this.lastSwitchTimestamp = now
        this.persist()

        log('INFO', 'model_scheduler_auto_switched', {
          from: result.message.includes('已切换') ? prediction.recommendedModel : '(未知)',
          to: prediction.recommendedModel,
          confidence: prediction.confidence,
          reason: prediction.reason,
          slotKey: prediction.slotKey,
        })

        return {
          switched: true,
          to: prediction.recommendedModel,
          reason: prediction.reason,
        }
      } else {
        return { switched: false, reason: `切换失败: ${result.message}` }
      }
    }

    return { switched: false, reason: '未注册切换回调' }
  }

  // ══════════════════════════════════════════
  //  用户锁定
  // ══════════════════════════════════════════

  /** 锁定到指定模型（用户干预锁定） */
  lockModel(model: string): { success: boolean; message: string } {
    if (!VALID_SCHEDULER_MODELS.includes(model)) {
      return { success: false, message: `无效模型: ${model}` }
    }

    this.locked = true
    this.lockedModel = model
    this.persist()

    log('INFO', 'model_scheduler_locked', { model })
    return { success: true, message: `已锁定模型: ${model}` }
  }

  /** 解锁（恢复自动调度） */
  unlock(): void {
    this.locked = false
    this.lockedModel = null
    this.persist()
    log('INFO', 'model_scheduler_unlocked')
  }

  /** 是否锁定 */
  isLocked(): boolean {
    return this.locked
  }

  /** 获取锁定的模型 */
  getLockedModel(): string | null {
    return this.lockedModel
  }

  // ══════════════════════════════════════════
  //  启用/禁用
  // ══════════════════════════════════════════

  /** 启用/禁用自动调度 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (enabled) {
      this.cachedPrediction = null
    }
    this.persist()
    log('INFO', 'model_scheduler_enabled', { enabled })
  }

  /** 是否启用 */
  isEnabled(): boolean {
    return this.enabled
  }

  // ══════════════════════════════════════════
  //  状态查询
  // ══════════════════════════════════════════

  /** 获取运行时状态快照 */
  getState(currentModel: string): ModelSchedulerState {
    const prediction = this.getPrediction()
    const now = Date.now()
    const msSinceLastSwitch = this.lastSwitchTimestamp > 0 ? now - this.lastSwitchTimestamp : -1

    return {
      enabled: this.enabled,
      locked: this.locked,
      lockedModel: this.lockedModel,
      currentPrediction: prediction,
      currentModel,
      logCount: this.usageLogs.length,
      learnedSlots: Object.keys(this.slotStats).length,
      totalPredictions: this.totalPredictions,
      acceptanceRate: this.totalPredictions > 0 ? Math.round((this.acceptedPredictions / this.totalPredictions) * 100) / 100 : 0,
      msSinceLastSwitch,
      inCooldown: msSinceLastSwitch >= 0 && msSinceLastSwitch < this.config.switchCooldownMs,
    }
  }

  /** 获取使用日志（供 UI/调试） */
  getUsageLogs(limit?: number): ModelUsageLogEntry[] {
    const logs = [...this.usageLogs].reverse()
    return limit ? logs.slice(0, limit) : logs
  }

  /** 获取时段统计 */
  getSlotStats(): Record<TimeSlotKey, SlotStats> {
    return { ...this.slotStats }
  }

  /** 获取配置 */
  getConfig(): ModelSchedulerConfig {
    return { ...this.config }
  }

  /** 更新配置 */
  updateConfig(partial: Partial<ModelSchedulerConfig>): void {
    this.config = { ...this.config, ...partial }
    this.persist()
    log('INFO', 'model_scheduler_config_updated', { ...this.config })
  }

  // ══════════════════════════════════════════
  //  数据管理
  // ══════════════════════════════════════════

  /** 重置所有数据 */
  reset(): void {
    this.usageLogs = []
    this.slotStats = {}
    this.totalPredictions = 0
    this.acceptedPredictions = 0
    this.lastSwitchTimestamp = 0
    this.cachedPrediction = null
    this.cachedPredictionSlotKey = null
    this.recentManualSwitchCount = 0
    this.synthesisCount = 0
    this.persist()
    log('INFO', 'model_scheduler_reset')
  }

  /** 标记一次预测被接受（用户未手动改回或给出了正反馈） */
  recordAcceptance(): void {
    this.acceptedPredictions++
    this.persist()
  }

  // ══════════════════════════════════════════
  //  模型切换回调（外部调用）
  // ══════════════════════════════════════════

  /**
   * 通知调度器模型已被外部切换。
   * 由 PiperOrchestrator 在每次 switchModel() 成功时调用。
   * 调度器据此更新锁定状态缓存。
   */
  notifyModelSwitched(model: string, source: string): void {
    // 记录使用
    this.recordModelUsage(model, source as ModelSelectionSource)

    // 如果是最新预测的模型 → 预测被接受
    if (this.cachedPrediction && this.cachedPrediction.recommendedModel === model) {
      this.acceptedPredictions++
    }

    log('DEBUG', 'model_scheduler_notified_switch', { model, source })
  }

  // ══════════════════════════════════════════
  //  私有：规则层
  // ══════════════════════════════════════════

  /**
   * 基于规则获取推荐模型。
   * 综合时段和星期映射，时段权重高于星期。
   */
  private getRuleBasedRecommendation(dayPeriod: DayPeriod, dayOfWeek: DayOfWeek): string {
    const dayPeriodModel = DAY_PERIOD_MODEL_MAP[dayPeriod]
    const dayOfWeekModel = DAY_OF_WEEK_MODEL_MAP[dayOfWeek]

    // 如果二者一致，直接返回
    if (dayPeriodModel === dayOfWeekModel) {
      return dayPeriodModel
    }

    // 不一致时优先时段（权重更高）
    // 但深夜时段强制使用柔和模型
    if (dayPeriod === 'late_night') {
      return dayPeriodModel
    }

    // 平日白天的时段和星期冲突较小，用时段推荐
    return dayPeriodModel
  }

  // ══════════════════════════════════════════
  //  私有：统计学习层
  // ══════════════════════════════════════════

  /**
   * 基于历史统计获取推荐模型。
   * 分析指定槽位的模型使用数据，选择加权分数最高的模型。
   */
  private getLearnedRecommendation(slotKey: TimeSlotKey): { model: string; confidence: number } | null {
    const stats = this.slotStats[slotKey]
    if (!stats || stats.totalUsage < this.config.minSamplesForLearning) {
      return null
    }

    let bestModel: string | null = null
    let bestScore = -Infinity
    let totalScore = 0

    for (const [model, modelStat] of Object.entries(stats.modelStats)) {
      if (!VALID_SCHEDULER_MODELS.includes(model)) continue
      totalScore += Math.max(0, modelStat.weightedScore)
      if (modelStat.weightedScore > bestScore) {
        bestScore = modelStat.weightedScore
        bestModel = model
      }
    }

    if (!bestModel || bestScore <= 0) return null

    // 置信度：基于该模型在总评分中的占比 + 样本量因子
    const scoreRatio = totalScore > 0 ? Math.max(0, bestScore / totalScore) : 0
    const sampleFactor = Math.min(1, stats.totalUsage / 50) // 50次样本达到饱和
    const confidence = Math.min(0.9, scoreRatio * 0.7 + sampleFactor * 0.3)

    return {
      model: bestModel,
      confidence: Math.round(confidence * 100) / 100,
    }
  }

  // ══════════════════════════════════════════
  //  私有：统计更新
  // ══════════════════════════════════════════

  /**
   * 更新槽位统计。
   */
  private updateSlotStats(slotKey: TimeSlotKey, model: string, weight: number): void {
    if (!this.slotStats[slotKey]) {
      this.slotStats[slotKey] = {
        modelStats: {},
        totalUsage: 0,
        lastUpdated: Date.now(),
      }
    }

    const stats = this.slotStats[slotKey]
    if (!stats.modelStats[model]) {
      stats.modelStats[model] = {
        count: 0,
        weightedScore: 0,
        manualSelections: 0,
      }
    }

    const modelStat = stats.modelStats[model]
    modelStat.count++
    modelStat.weightedScore += weight
    if (weight >= MANUAL_SELECTION_WEIGHT_MULTIPLIER) {
      modelStat.manualSelections++
    }
    stats.totalUsage++
    stats.lastUpdated = Date.now()
  }

  /**
   * 调整槽位统计的加权分数（用于反馈回调）。
   */
  private adjustSlotStats(slotKey: TimeSlotKey, model: string, delta: number): void {
    const stats = this.slotStats[slotKey]?.modelStats[model]
    if (stats) {
      stats.weightedScore = Math.max(-10, stats.weightedScore + delta)
    }
  }

  // ══════════════════════════════════════════
  //  私有：持久化
  // ══════════════════════════════════════════

  /**
   * 从磁盘加载持久化数据。
   */
  private loadFromDisk(): void {
    try {
      const persistenceFile = this.getPersistenceFilePath()
      if (!existsSync(persistenceFile)) return

      const raw = readFileSync(persistenceFile, 'utf-8')
      const data = JSON.parse(raw) as ModelSchedulerPersistedData

      if (data.version !== PERSISTENCE_VERSION) {
        log('WARN', 'model_scheduler_persistence_version_mismatch', {
          expected: PERSISTENCE_VERSION,
          actual: data.version,
        })
      }

      this.usageLogs = data.usageLogs || []
      this.slotStats = data.slotStats || {}
      this.locked = data.locked || false
      this.lockedModel = data.lockedModel || null
      this.enabled = data.enabled ?? true
      this.totalPredictions = data.totalPredictions || 0
      this.acceptedPredictions = data.acceptedPredictions || 0
      this.lastSwitchTimestamp = data.lastSwitchTimestamp || 0

      log('INFO', 'model_scheduler_data_loaded', {
        logCount: this.usageLogs.length,
        slotCount: Object.keys(this.slotStats).length,
      })
    } catch (err: any) {
      log('WARN', 'model_scheduler_load_error', { error: err.message })
      // 加载失败使用默认空数据
    }
  }

  /**
   * 持久化到磁盘。
   */
  private persist(): void {
    try {
      const data: ModelSchedulerPersistedData = {
        version: PERSISTENCE_VERSION,
        usageLogs: this.usageLogs,
        slotStats: this.slotStats,
        locked: this.locked,
        lockedModel: this.lockedModel,
        enabled: this.enabled,
        learnedSlots: Object.keys(this.slotStats).length,
        totalPredictions: this.totalPredictions,
        acceptedPredictions: this.acceptedPredictions,
        lastSwitchTimestamp: this.lastSwitchTimestamp,
        lastUpdated: Date.now(),
      }

      const filePath = this.getPersistenceFilePath()
      const dir = dirname(filePath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
    } catch (err: any) {
      log('ERROR', 'model_scheduler_persist_error', { error: err.message })
    }
  }

  /**
   * 获取持久化文件路径。
   */
  private getPersistenceFilePath(): string {
    const dir = this.config.persistencePath || DEFAULT_STORAGE_DIR
    return `${dir}/${DEFAULT_PERSISTENCE_RELATIVE_PATH}`
  }

  // ══════════════════════════════════════════
  //  私有：工具
  // ══════════════════════════════════════════

  /** 获取模型显示名 */
  private getModelDisplayName(model: string): string {
    return PIPER_MODEL_CATALOG[model]?.displayName || model
  }

  /** 获取星期中文描述 */
  private describeDayOfWeek(dayOfWeek: DayOfWeek): string {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    return names[dayOfWeek] || ''
  }

  /** 检查调度器是否已初始化 */
  isInitialized(): boolean {
    return this.initialized
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/**
 * 全局单例，供 TtsService、TtsPiperBridge、IPC handlers 共享。
 * 需在 AppRuntime 启动时调用 initialize()。
 */
export const modelScheduler = new ModelScheduler()
