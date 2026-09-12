/**
 * VoiceBehaviorAdaptiveLearner — 语音行为自适应学习引擎
 *
 * 将 ASR 实时语音识别与用户行为模式结合，实现基于用户说话习惯的自动优化。
 *
 * ── 核心能力 ──
 * 1. 增量式贝叶斯在线学习（Beta-Binomial）
 *    对每个被纠正的词汇维护 Beta(α, β) 后验分布，增量更新。
 *    概率值 = β/(α+β) 表示该词需要被纠正的概率，
 *    超过阈值后自动加入热词或提高权重。
 *
 * 2. 交互计数器（每 100 次触发）
 *    记录用户交互次数，每 100 次自动触发一次批量优化，
 *    通过 AsrFeedbackAnalyzer + AsrEvolutionManager 执行。
 *
 * 3. 口音特征追踪
 *    统计平均音高、音高范围、语速、能量等声学特征，
 *    构建用户声学画像，用于 ASR 参数微调。
 *
 * 4. 回滚保障
 *    每次批量优化前记录评估快照，在下一轮评估时对比纠错率，
 *    若恶化则自动回滚（委托 AsrEvolutionManager）。
 *
 * ── 数据流 ──
 * AsrService.transcribe()
 *     ↓
 * learner.recordInteraction(text, confidence, voiceEmotion)
 *     ↓
 * 累积交互计数 → 每 100 次触发 analyzeAndOptimize()
 *     ↓
 * AsrService.feedback(original, corrected)
 *     ↓
 * learner.recordCorrection(original, corrected)
 *     ↓
 * 贝叶斯更新对应词汇的 Beta 后验 → 高概率词加入热词
 *
 * ── 设计原则 ──
 * 1. 轻量级 — 所有操作同步完成，不阻塞主路径
 * 2. 增量式 — 不依赖完整数据集，每条数据到达时即时更新
 * 3. 安全优先 — 变更可回滚，过拟合保护
 * 4. 无副作用 — 不修改外部状态，仅提供建议和触发
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { asrFeedbackAnalyzer } from './AsrFeedbackAnalyzer'
import { asrHotwordManager } from './AsrHotwordManager'
import type { VoiceEmotion } from './types'

// ══════════════════════════════════════════
//  常量
// ══════════════════════════════════════════

/** 触发批量优化的交互间隔 */
const OPTIMIZATION_INTERVAL = 100

/** 贝叶斯先验参数（均匀先验 Beta(1,1)） */
const BETA_PRIOR_ALPHA = 1
const BETA_PRIOR_BETA = 1

/** 贝叶斯后验概率阈值 — 超过此值则视为"需要优化的词" */
const BAYESIAN_PROB_THRESHOLD = 0.3

/** 贝叶斯概率高阈值 — 超过此值直接作为热词注入 */
const BAYESIAN_HIGH_PROB_THRESHOLD = 0.55

/** 口音特征滑动窗口大小 */
const ACCENT_WINDOW_SIZE = 50

/** 最小交互次数后才允许触发优化 */
const MIN_INTERACTIONS_FOR_OPTIMIZE = 50

/** 两次优化之间的最小间隔（毫秒）— 防止高频触发 */
const MIN_OPTIMIZE_INTERVAL_MS = 5 * 60 * 1000

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/**
 * 单个词汇的贝叶斯后验状态。
 * Beta 分布是 Bernoulli 试验的共轭先验。
 */
export interface WordBayesianState {
  /** 词汇 */
  word: string
  /** 正确识别的次数（alpha - 1） */
  successCount: number
  /** 需要纠正的次数（beta - 1） */
  failureCount: number
  /** 后验概率 P(需要纠正) = β/(α+β) */
  correctionProbability: number
  /** 最后更新时间 */
  lastUpdated: number
}

/** 口音特征画像 */
export interface AccentProfile {
  /** 平均音高 (Hz) */
  avgPitch: number
  /** 音高标准差 */
  pitchStd: number
  /** 音高范围 (max - min) */
  pitchRange: number
  /** 平均语速（有效帧/秒） */
  avgSpeechRate: number
  /** 平均能量 (0–1) */
  avgEnergy: number
  /** 平均静音比 */
  avgSilenceRatio: number
  /** 样本数 */
  sampleCount: number
  /** 音高偏度（正 = 偏高音，负 = 偏低音） */
  pitchSkew: number
}

/** 自适应学习状态快照 */
export interface AdaptiveLearnerState {
  /** 当前交互计数 */
  interactionCount: number
  /** 上次优化触发时的计数 */
  lastOptimizationAt: number
  /** 贝叶斯状态词数 */
  bayesianWordCount: number
  /** 口音画像样本数 */
  accentSampleCount: number
  /** 上次优化时间戳 */
  lastOptimizeTimestamp: number
  /** 累计纠正次数 */
  totalCorrections: number
  /** 累计识别次数 */
  totalRecognitions: number
}

/** 批量优化结果摘要 */
export interface AdaptiveOptimizationResult {
  /** 是否触发了优化 */
  triggered: boolean
  /** 交互计数 */
  interactionCount: number
  /** 已生成的补丁数 */
  patchesGenerated: number
  /** 进化管理器快照 ID */
  snapshotId?: string
  /** 贝叶斯建议的热词 */
  bayesianHotwords: string[]
  /** 跳过原因 */
  skipReason?: string
}

// ══════════════════════════════════════════
//  VoiceBehaviorAdaptiveLearner
// ══════════════════════════════════════════

export class VoiceBehaviorAdaptiveLearner {
  // ── 交互计数 ──
  private _interactionCount = 0
  private _lastOptimizationAt = 0
  private _lastOptimizeTimestamp = 0
  private _totalCorrections = 0
  private _totalRecognitions = 0

  // ── 增量贝叶斯词表 ──
  private bayesianVocab = new Map<string, WordBayesianState>()

  // ── 口音特征 ──
  private pitchValues: number[] = []
  private speechRateValues: number[] = []
  private energyValues: number[] = []
  private silenceRatioValues: number[] = []

  // ── 选项 ──
  private readonly optimizeInterval: number
  private readonly minInteractionsForOptimize: number
  private readonly minOptimizeIntervalMs: number

  constructor(options?: { optimizeInterval?: number; minInteractionsForOptimize?: number; minOptimizeIntervalMs?: number }) {
    this.optimizeInterval = options?.optimizeInterval ?? OPTIMIZATION_INTERVAL
    this.minInteractionsForOptimize = options?.minInteractionsForOptimize ?? MIN_INTERACTIONS_FOR_OPTIMIZE
    this.minOptimizeIntervalMs = options?.minOptimizeIntervalMs ?? MIN_OPTIMIZE_INTERVAL_MS
  }

  // ══════════════════════════════════════════
  //  公共接口
  // ══════════════════════════════════════════

  /**
   * 记录一次 ASR 交互（识别完成时调用）。
   *
   * 功能：
   * 1. 递增交互计数
   * 2. 更新口音特征画像（如有语音情感特征）
   * 3. 将文本中的词汇更新贝叶斯正确率（成功计数 +1）
   * 4. 达到间隔阈值时触发批量优化
   *
   * @param text        ASR 识别的文本
   * @param confidence   ASR 置信度 (0–1)
   * @param voiceEmotion 语音情感/声学特征（可选）
   * @returns 如果触发了优化则返回优化结果
   */
  recordInteraction(text: string, confidence: number, voiceEmotion?: VoiceEmotion): AdaptiveOptimizationResult | null {
    this._interactionCount++
    this._totalRecognitions++

    // 更新口音特征
    if (voiceEmotion) {
      this.updateAccentProfile(voiceEmotion)
    }

    // 对高置信度识别的词汇，更新贝叶斯成功计数
    if (text && text.trim().length > 0 && confidence >= 0.6) {
      const words = this.extractWords(text)
      for (const word of words) {
        this.updateBayesianSuccess(word)
      }
    }

    // 检查是否需要触发批量优化
    if (this.shouldTriggerOptimization()) {
      return this.triggerOptimization()
    }

    return null
  }

  /**
   * 记录一次用户纠正（AsrService.feedback() 时调用）。
   *
   * 功能：
   * 1. 递增纠正计数
   * 2. 对纠正词汇更新贝叶斯失败计数（需要纠正）
   * 3. 对高概率词汇立即注入热词
   *
   * @param original    ASR 识别原文
   * @param corrected   用户修正后的文本
   */
  recordCorrection(original: string, corrected: string): void {
    this._totalCorrections++

    // 从修正文本提取词汇，标记为"需要纠正"
    const correctedWords = this.extractWords(corrected)
    for (const word of correctedWords) {
      this.updateBayesianFailure(word)
    }

    // 检查是否有词汇概率超过高阈值 → 立即注入热词
    const highProbWords: string[] = []
    for (const word of correctedWords) {
      const state = this.bayesianVocab.get(word)
      if (state && state.correctionProbability >= BAYESIAN_HIGH_PROB_THRESHOLD) {
        highProbWords.push(word)
      }
    }

    if (highProbWords.length > 0) {
      // 通过 feedUserText 将高概率词汇注入热词管理器（双倍权重）
      for (const word of highProbWords) {
        asrHotwordManager.feedUserText(word)
        asrHotwordManager.feedUserText(word) // 重复一次提高权重
      }
      log('INFO', 'asr_bayesian_high_prob_auto_add', {
        words: highProbWords.slice(0, 5),
        count: highProbWords.length,
      })
    }

    log('DEBUG', 'asr_adaptive_learner_correction', {
      original: original.slice(0, 30),
      corrected: corrected.slice(0, 30),
      bayesianVocabSize: this.bayesianVocab.size,
      totalCorrections: this._totalCorrections,
    })
  }

  /**
   * 记录口音特征（在每轮交互中可选的补充调用）。
   * 当有 VoiceEmotion 数据时，由 recordInteraction 自动调用，
   * 外部通常不需要手动调用此方法。
   */
  recordAccentFeatures(voiceEmotion: VoiceEmotion): void {
    this.updateAccentProfile(voiceEmotion)
  }

  /**
   * 获取当前口音特征画像。
   */
  getAccentProfile(): AccentProfile {
    const n = this.pitchValues.length
    if (n === 0) {
      return {
        avgPitch: 0,
        pitchStd: 0,
        pitchRange: 0,
        avgSpeechRate: 0,
        avgEnergy: 0,
        avgSilenceRatio: 0,
        sampleCount: 0,
        pitchSkew: 0,
      }
    }

    const avgPitch = this.average(this.pitchValues)
    const avgSpeechRate = this.average(this.speechRateValues)
    const avgEnergy = this.average(this.energyValues)
    const avgSilenceRatio = this.average(this.silenceRatioValues)
    const pitchStd = this.standardDeviation(this.pitchValues, avgPitch)

    // 偏度计算
    const pitchSkew = n >= 3 ? this.pitchValues.reduce((sum, v) => sum + Math.pow((v - avgPitch) / Math.max(pitchStd, 0.001), 3), 0) / n : 0

    return {
      avgPitch: Math.round(avgPitch * 10) / 10,
      pitchStd: Math.round(pitchStd * 10) / 10,
      pitchRange: n >= 2 ? Math.round((Math.max(...this.pitchValues) - Math.min(...this.pitchValues)) * 10) / 10 : 0,
      avgSpeechRate: Math.round(avgSpeechRate * 100) / 100,
      avgEnergy: Math.round(avgEnergy * 100) / 100,
      avgSilenceRatio: Math.round(avgSilenceRatio * 100) / 100,
      sampleCount: n,
      pitchSkew: Math.round(pitchSkew * 100) / 100,
    }
  }

  /**
   * 获取贝叶斯词汇状态列表（按纠正概率降序）。
   */
  getBayesianVocab(): WordBayesianState[] {
    return Array.from(this.bayesianVocab.values()).sort((a, b) => b.correctionProbability - a.correctionProbability)
  }

  /**
   * 获取贝叶斯建议的热词（纠正概率超过阈值的词汇）。
   */
  getBayesianHotwords(): string[] {
    return this.getBayesianVocab()
      .filter((s) => s.correctionProbability >= BAYESIAN_PROB_THRESHOLD)
      .map((s) => s.word)
  }

  /**
   * 获取当前学习状态快照。
   */
  getState(): AdaptiveLearnerState {
    return {
      interactionCount: this._interactionCount,
      lastOptimizationAt: this._lastOptimizationAt,
      bayesianWordCount: this.bayesianVocab.size,
      accentSampleCount: this.pitchValues.length,
      lastOptimizeTimestamp: this._lastOptimizeTimestamp,
      totalCorrections: this._totalCorrections,
      totalRecognitions: this._totalRecognitions,
    }
  }

  /**
   * 获取当前纠错率（纠正数/识别总数）。
   */
  getCorrectionRate(): number {
    return this._totalRecognitions > 0 ? this._totalCorrections / this._totalRecognitions : 0
  }

  /**
   * 手动触发一次批量优化（可用于调试/测试）。
   */
  triggerOptimization(): AdaptiveOptimizationResult {
    return this.runOptimization()
  }

  /**
   * 重置所有学习状态（用于测试/调试）。
   */
  reset(): void {
    this._interactionCount = 0
    this._lastOptimizationAt = 0
    this._lastOptimizeTimestamp = 0
    this._totalCorrections = 0
    this._totalRecognitions = 0
    this.bayesianVocab.clear()
    this.pitchValues = []
    this.speechRateValues = []
    this.energyValues = []
    this.silenceRatioValues = []
    log('INFO', 'asr_adaptive_learner_reset')
  }

  // ══════════════════════════════════════════
  //  内部：增量贝叶斯更新
  // ══════════════════════════════════════════

  /**
   * 更新一个词汇的贝叶斯成功计数（正确识别）。
   * Beta(α, β) → Beta(α+1, β)
   */
  private updateBayesianSuccess(word: string): void {
    const existing = this.bayesianVocab.get(word)
    if (existing) {
      existing.successCount++
      existing.correctionProbability = this.computeBetaProbability(existing.successCount, existing.failureCount)
      existing.lastUpdated = Date.now()
    }
    // 不存在的词不做插入（只有被纠正过的词才会进入贝叶斯词表）
  }

  /**
   * 更新一个词汇的贝叶斯失败计数（需要纠正）。
   * Beta(α, β) → Beta(α, β+1)
   */
  private updateBayesianFailure(word: string): void {
    const existing = this.bayesianVocab.get(word)
    if (existing) {
      existing.failureCount++
      existing.correctionProbability = this.computeBetaProbability(existing.successCount, existing.failureCount)
      existing.lastUpdated = Date.now()
    } else {
      // 新词：Beta(1 + 0, 1 + 1) = Beta(1, 2)
      const correctionProb = this.computeBetaProbability(0, 1)
      this.bayesianVocab.set(word, {
        word,
        successCount: 0,
        failureCount: 1,
        correctionProbability: correctionProb,
        lastUpdated: Date.now(),
      })
    }
  }

  /**
   * 计算 Beta 后验概率 P(纠正) = β/(α+β)。
   * 使用 Beta(α₀ + success, β₀ + failure) 后验分布的均值。
   */
  private computeBetaProbability(successCount: number, failureCount: number): number {
    const alpha = BETA_PRIOR_ALPHA + successCount
    const beta = BETA_PRIOR_BETA + failureCount
    // 使用后验均值 E[P] = β / (α + β)
    return Math.round((beta / (alpha + beta)) * 10000) / 10000
  }

  // ══════════════════════════════════════════
  //  内部：口音特征更新
  // ══════════════════════════════════════════

  /**
   * 从 VoiceEmotion 数据更新口音特征滑动窗口。
   */
  private updateAccentProfile(ve: VoiceEmotion): void {
    this.pitchValues.push(ve.features.pitchHz)
    this.speechRateValues.push(ve.features.speechRate)
    this.energyValues.push(ve.features.energy)
    this.silenceRatioValues.push(ve.features.silenceRatio)

    // 裁剪到窗口大小
    if (this.pitchValues.length > ACCENT_WINDOW_SIZE) {
      this.pitchValues.shift()
      this.speechRateValues.shift()
      this.energyValues.shift()
      this.silenceRatioValues.shift()
    }
  }

  // ══════════════════════════════════════════
  //  内部：优化触发与执行
  // ══════════════════════════════════════════

  /**
   * 判断是否应该触发批量优化。
   * 条件：交互计数达到间隔 + 超过最小交互阈值 + 超过最小时间间隔
   */
  private shouldTriggerOptimization(): boolean {
    const interactionsSinceLast = this._interactionCount - this._lastOptimizationAt
    if (interactionsSinceLast < this.optimizeInterval) return false
    if (this._interactionCount < this.minInteractionsForOptimize) return false
    if (Date.now() - this._lastOptimizeTimestamp < this.minOptimizeIntervalMs) return false
    return true
  }

  /**
   * 执行批量优化。
   *
   * 流程：
   * 1. 获取贝叶斯建议的高概率热词
   * 2. 将这些高概率词种子到热词管理器
   * 3. 委托 AsrFeedbackAnalyzer 进行批量分析和优化
   * 4. 记录快照，为后续回滚提供基线
   * 5. 更新优化标记
   */
  private runOptimization(): AdaptiveOptimizationResult {
    const result: AdaptiveOptimizationResult = {
      triggered: true,
      interactionCount: this._interactionCount,
      patchesGenerated: 0,
      bayesianHotwords: [],
    }

    // 1. 获取贝叶斯建议的高概率热词
    const bayesianHotwords = this.getBayesianHotwords()
    result.bayesianHotwords = bayesianHotwords

    // 2. 将高概率词汇种子到热词管理器
    if (bayesianHotwords.length > 0) {
      for (const word of bayesianHotwords) {
        // 将贝叶斯建议的热词以较高频次注入
        const state = this.bayesianVocab.get(word)
        const repeatCount = state && state.correctionProbability >= BAYESIAN_HIGH_PROB_THRESHOLD ? 3 : 1
        for (let i = 0; i < repeatCount; i++) {
          asrHotwordManager.feedUserText(word)
        }
      }
      log('INFO', 'asr_bayesian_hotwords_seeded', {
        count: bayesianHotwords.length,
        sample: bayesianHotwords.slice(0, 5),
      })
    }

    // 3. 委托 AsrFeedbackAnalyzer 进行批量分析优化
    const feedbackResult = asrFeedbackAnalyzer.analyzeAndOptimize()
    result.patchesGenerated = feedbackResult.patchesGenerated
    result.snapshotId = feedbackResult.snapshotId

    if (feedbackResult.changesApplied) {
      log('INFO', 'asr_adaptive_optimization_completed', {
        interactionCount: this._interactionCount,
        patchesGenerated: feedbackResult.patchesGenerated,
        bayesianHotwords: bayesianHotwords.length,
        snapshotId: feedbackResult.snapshotId,
        topCorrected: feedbackResult.topCorrected.slice(0, 3),
        accentSamples: this.pitchValues.length,
        correctionRate: this.getCorrectionRate().toFixed(4),
      })
    } else {
      log('INFO', 'asr_adaptive_optimization_skipped', {
        reason: feedbackResult.skipReason || 'no feedback analyzer changes',
        interactionCount: this._interactionCount,
        bayesianHotwords: bayesianHotwords.length,
      })
    }

    // 4. 更新优化标记
    this._lastOptimizationAt = this._interactionCount
    this._lastOptimizeTimestamp = Date.now()

    return result
  }

  // ══════════════════════════════════════════
  //  内部：词汇提取
  // ══════════════════════════════════════════

  /**
   * 从文本中提取有意义的词汇（用于贝叶斯统计）。
   * 与 AsrHotwordManager tokenize 类似但更简单，仅提取核心词汇。
   */
  private extractWords(text: string): string[] {
    if (!text || text.trim().length === 0) return []

    const words = new Set<string>()
    const trimmed = text.trim()

    // 英文/数字词汇（>= 3 字符）
    const engWords = trimmed.match(/[a-zA-Z][a-zA-Z0-9_]{2,}/g)
    if (engWords) {
      for (const w of engWords) {
        words.add(w.toLowerCase())
      }
    }

    // 中文连续字符（>= 2 字符）
    const cjkRuns = trimmed.match(/[一-鿿]{2,}/g)
    if (cjkRuns) {
      for (const run of cjkRuns) {
        // 对中文使用 bigram 窗口
        for (let i = 0; i <= run.length - 2; i++) {
          const bigram = run.slice(i, i + 2)
          words.add(bigram)
        }
        // 对 >= 3 字符的片段也整体加入
        if (run.length >= 3) {
          words.add(run)
        }
      }
    }

    return Array.from(words)
  }

  // ══════════════════════════════════════════
  //  内部：统计工具
  // ══════════════════════════════════════════

  private average(values: number[]): number {
    return values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : 0
  }

  private standardDeviation(values: number[], mean: number): number {
    if (values.length < 2) return 0
    const squaredDiffs = values.map((v) => (v - mean) ** 2)
    return Math.sqrt(squaredDiffs.reduce((sum, v) => sum + v, 0) / values.length)
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例，供 AsrService 使用 */
export const voiceBehaviorAdaptiveLearner = new VoiceBehaviorAdaptiveLearner()
