/**
 * AsrBehaviorPredictor — ASR 行为模式预测引擎
 *
 * 通过分析用户的语音输入习惯（口癖、犹豫模式、高频领域词、识别失败模式），
 * 动态优化 ASR 转写参数，实现个性化语音识别增强。
 *
 * ── 核心能力 ──
 * 1. 犹豫/填充词检测与容忍度建模
 *    识别常见填充词（嗯、啊、呃、那个、就是、这个、然后），
 *    统计其在用户语音中的出现频率，动态调整 ASR 的置信度阈值，
 *    避免犹豫词导致的错误断句或误识别。
 *
 * 2. 领域词行为分析与预测
 *    追踪用户高频出现的领域术语，结合 AsrLogStore 中的低置信度片段
 *    和纠正记录，自动识别"识别不好但常用"的词汇，生成热词提升建议。
 *
 * 3. 识别失败模式学习与词汇扩充
 *    分析 AsrLogStore 中的低置信度识别结果，提取需要优先学习的词汇，
 *    自动扩充到热词管理器和 initial_prompt 中。
 *
 * ── 数据流 ──
 * AsrService.transcribe() 完成后
 *         ↓
 * AsrBehaviorPredictor.recordTranscription(text, confidence, voiceFeatures)
 *         ↓
 * 内部滑动窗口统计 → 分析填充词比例、领域词分布、失败模式
 *         ↓
 * AsrBehaviorPredictor.getPrediction()  →  优化建议
 *         ↓
 * AsrService.setConversationContext() 时应用优化
 *
 * ── 设计原则 ──
 * 1. 轻量级 — 所有计算同步完成，不阻塞 ASR 主路径
 * 2. 渐进式 — 样本不足时返回保守（无调整）预测
 * 3. 容错 — 依赖的 AsrLogStore 不可用时优雅降级
 * 4. 无副作用 — 不修改外部状态，仅提供预测建议
 */

import { log } from '../logger/Logger'
import { asrLogStore } from './AsrLogStore'
import { asrHotwordManager } from './AsrHotwordManager'
import type { VoiceEmotion } from './types'

// ══════════════════════════════════════════
//  常量
// ══════════════════════════════════════════

/** 填充词/犹豫词列表（按频率排序，常用在前） */
const FILLER_WORDS = new Set([
  '嗯', '啊', '呃', '哦', '喔',
  '那个', '这个', '那个那个', '这个这个',
  '就是', '就是说', '然后', '反正', '就是说呢',
  '对吧', '是吧', '好吧', '好了', '好了吧',
  '其实', '实际上', '基本上', '基本上来说',
  '感觉', '我觉得', '我认为', '我以为',
  '你知道', '你懂得', '怎么说', '怎么说呢',
  '所以', '所以说', '然后呢', '接下来',
  '嗯嗯', '嗯哼', '啊哈',
])

/** 最小有效样本数（少于该值返回保守预测） */
const MIN_SAMPLES = 3

/** 最大保留的转录记录数 */
const MAX_RECORDS = 100

/** 高犹豫比例阈值（超过此值视为"高犹豫"用户） */
const HIGH_HESITATION_RATIO = 0.15

/** 中等犹豫比例阈值 */
const MED_HESITATION_RATIO = 0.08

/** 高犹豫模式下 ASR 置信度阈值下调比例 */
const HESITATION_CONFIDENCE_ADJUST = -0.08

/** 中犹豫模式下 ASR 置信度阈值下调比例 */
const MED_HESITATION_CONFIDENCE_ADJUST = -0.03

/** 低置信度阈值（低于此值视为需要学习的词汇） */
const LOW_CONF_THRESHOLD = 0.6

/** 单次分析最多处理的低置信度片段数 */
const MAX_LOW_CONF_ANALYSIS = 50

/** 需要学习的新词的最低出现频次 */
const MIN_NEW_WORD_FREQUENCY = 2

/** 沉默比例高阈值（说话中间停顿多） */
const HIGH_SILENCE_RATIO = 0.45

/** 沉默比例中等阈值 */
const MED_SILENCE_RATIO = 0.30

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 单次转录记录 */
export interface TranscriptionRecord {
  /** 转录文本 */
  text: string
  /** ASR 置信度 (0–1) */
  confidence: number
  /** 语音情感特征（如有） */
  voiceFeatures?: {
    /** 平均能量 */
    energy: number
    /** 沉默比例 */
    silenceRatio: number
    /** 语速 */
    speechRate: number
  }
  /** 时间戳 */
  timestamp: number
  /** 检测到的填充词列表 */
  fillerWords: string[]
  /** 填充词在文本中的占比 */
  fillerRatio: number
}

/** 犹豫模式分析结果 */
export interface HesitationProfile {
  /** 总体填充词比例（填充词字符/总字符） */
  overallFillerRatio: number
  /** 是否属于"高犹豫"用户 */
  isHighHesitation: boolean
  /** 高频填充词 TOP 5 */
  topFillers: Array<{ word: string; count: number }>
  /** 建议的置信度调整值 */
  recommendedConfidenceAdjust: number
  /** 用于分析的样本数 */
  sampleCount: number
}

/** 领域词热度条目 */
export interface DomainTermHeat {
  /** 词汇 */
  term: string
  /** 出现次数 */
  frequency: number
  /** 是否在低置信度片段中出现过（需要优先优化） */
  isLowConfidence: boolean
  /** 来自纠正记录的出现次数 */
  correctionCount: number
  /** 综合热度评分 (0–1) */
  heatScore: number
}

/** 识别失败模式 */
export interface RecognitionFailurePattern {
  /** 低置信度原文 */
  original: string
  /** 出现次数 */
  frequency: number
  /** 是否已被纠正 */
  wasCorrected: boolean
  /** 纠正后的正确文本（如有） */
  corrected?: string
}

/** 完整的行为预测输出 */
export interface AsrBehaviorPrediction {
  /** 犹豫模式画像 */
  hesitation: HesitationProfile
  /** 需要提升的领域热词列表（用于注入 AsrHotwordManager） */
  boostedTerms: string[]
  /** 需加入 initial_prompt 的领域提示片段 */
  promptBoosts: string[]
  /** 置信度全局调整值（基于用户整体语音特征） */
  globalConfidenceAdjust: number
  /** 识别的失败模式摘要 */
  failurePatterns: RecognitionFailurePattern[]
  /** 预测生成时间 */
  timestamp: number
  /** 预测是否有效（样本足够） */
  isValid: boolean
}

/** 默认保守预测（样本不足时的回退值） */
const CONSERVATIVE_PREDICTION: AsrBehaviorPrediction = {
  hesitation: {
    overallFillerRatio: 0,
    isHighHesitation: false,
    topFillers: [],
    recommendedConfidenceAdjust: 0,
    sampleCount: 0,
  },
  boostedTerms: [],
  promptBoosts: [],
  globalConfidenceAdjust: 0,
  failurePatterns: [],
  timestamp: 0,
  isValid: false,
}

// ══════════════════════════════════════════
//  AsrBehaviorPredictor
// ══════════════════════════════════════════

export class AsrBehaviorPredictor {
  /** 滑动窗口中的转录记录 */
  private records: TranscriptionRecord[] = []

  /** 最大记录数 */
  private readonly maxRecords: number

  /** 填充词检测缓存（避免每段文本重复计算） */
  private fillerCache = new Map<string, { words: string[]; ratio: number }>()

  /** 上次生成预测的时间 */
  private lastPredictionTime = 0

  /** 缓存的预测结果 */
  private cachedPrediction: AsrBehaviorPrediction | null = null

  /** 预测缓存 TTL (ms) — 每 30 秒最多重新计算一次 */
  private readonly predictionTtlMs = 30_000

  constructor(maxRecords = MAX_RECORDS) {
    this.maxRecords = maxRecords
  }

  // ══════════════════════════════════════════
  //  公共接口
  // ══════════════════════════════════════════

  /**
   * 记录一次 ASR 转录结果。
   * 应在 AsrService.transcribe() 成功后调用。
   *
   * @param text      ASR 识别的文本
   * @param confidence ASR 置信度 (0–1)
   * @param voiceEmotion 语音情感分析结果（可选）
   */
  recordTranscription(
    text: string,
    confidence: number,
    voiceEmotion?: VoiceEmotion,
  ): void {
    if (!text || text.trim().length === 0) return

    const trimmed = text.trim()
    const { words: fillerWords, ratio: fillerRatio } = this.detectFillers(trimmed)

    const record: TranscriptionRecord = {
      text: trimmed,
      confidence,
      voiceFeatures: voiceEmotion
        ? {
            energy: voiceEmotion.features.energy,
            silenceRatio: voiceEmotion.features.silenceRatio,
            speechRate: voiceEmotion.features.speechRate,
          }
        : undefined,
      timestamp: Date.now(),
      fillerWords,
      fillerRatio,
    }

    this.records.push(record)

    // 裁剪超过上限的旧记录
    while (this.records.length > this.maxRecords) {
      this.records.shift()
    }

    // 使缓存失效
    this.cachedPrediction = null

    log('DEBUG', 'asr_behavior_recorded', {
      text: trimmed.slice(0, 30),
      confidence: confidence.toFixed(2),
      fillerRatio: fillerRatio.toFixed(3),
      fillerWords: fillerWords.length > 0 ? fillerWords.slice(0, 3) : [],
      totalRecords: this.records.length,
    })
  }

  /**
   * 获取当前行为预测。
   * 结果在 TTL 内缓存，避免频繁重复计算。
   *
   * @param forceRefresh 强制刷新（忽略缓存）
   */
  getPrediction(forceRefresh = false): AsrBehaviorPrediction {
    const now = Date.now()

    // 缓存命中
    if (
      !forceRefresh &&
      this.cachedPrediction &&
      now - this.lastPredictionTime < this.predictionTtlMs
    ) {
      return this.cachedPrediction
    }

    // 样本不足 → 保守预测
    if (this.records.length < MIN_SAMPLES) {
      this.cachedPrediction = CONSERVATIVE_PREDICTION
      this.lastPredictionTime = now
      return this.cachedPrediction
    }

    // 构建预测
    const hesitation = this.analyzeHesitation()
    const boostedTerms = this.analyzeDomainTermHeat()
    const failurePatterns = this.analyzeFailurePatterns()
    const promptBoosts = this.buildPromptBoosts(hesitation, boostedTerms)
    const globalConfidenceAdjust = this.calcGlobalConfidenceAdjust(hesitation)

    const prediction: AsrBehaviorPrediction = {
      hesitation,
      boostedTerms,
      promptBoosts,
      globalConfidenceAdjust,
      failurePatterns,
      timestamp: now,
      isValid: true,
    }

    this.cachedPrediction = prediction
    this.lastPredictionTime = now

    log('INFO', 'asr_behavior_prediction', {
      fillerRatio: hesitation.overallFillerRatio.toFixed(3),
      isHighHesitation: hesitation.isHighHesitation,
      boostedTerms: boostedTerms.length,
      confidenceAdjust: globalConfidenceAdjust.toFixed(3),
      failurePatterns: failurePatterns.length,
      sampleCount: this.records.length,
    })

    return prediction
  }

  /**
   * 获取当前预测的犹豫模式画像（便捷方法）。
   */
  getHesitationProfile(): HesitationProfile {
    return this.getPrediction().hesitation
  }

  /**
   * 获取当前推荐的 ASR 优化设置。
   * 调用方可直接使用这些值调整 ASR 参数。
   */
  getAsrOptimization(): {
    /** 热词提升列表（应添加到 AsrHotwordManager） */
    hotwordBoosts: string[]
    /** initial_prompt 增强片段 */
    promptBoost: string
    /** ASR 置信度调整值 */
    confidenceAdjust: number
    /** 犹豫容忍模式 */
    hesitationMode: 'normal' | 'relaxed' | 'tolerant'
  } {
    const pred = this.getPrediction()
    if (!pred.isValid) {
      return {
        hotwordBoosts: [],
        promptBoost: '',
        confidenceAdjust: 0,
        hesitationMode: 'normal',
      }
    }

    // 根据犹豫比例选择模式
    let hesitationMode: 'normal' | 'relaxed' | 'tolerant'
    if (pred.hesitation.overallFillerRatio > HIGH_HESITATION_RATIO) {
      hesitationMode = 'tolerant'
    } else if (pred.hesitation.overallFillerRatio > MED_HESITATION_RATIO) {
      hesitationMode = 'relaxed'
    } else {
      hesitationMode = 'normal'
    }

    return {
      hotwordBoosts: pred.boostedTerms,
      promptBoost: pred.promptBoosts.join(' '),
      confidenceAdjust: pred.globalConfidenceAdjust,
      hesitationMode,
    }
  }

  /**
   * 重置所有记录（用于测试/调试）。
   */
  reset(): void {
    this.records = []
    this.fillerCache.clear()
    this.cachedPrediction = null
    this.lastPredictionTime = 0
    log('INFO', 'asr_behavior_predictor_reset')
  }

  /**
   * 获取当前统计信息。
   */
  getStats(): {
    totalRecords: number
    fillerCacheSize: number
    lastPrediction: number
    hasValidPrediction: boolean
  } {
    return {
      totalRecords: this.records.length,
      fillerCacheSize: this.fillerCache.size,
      lastPrediction: this.lastPredictionTime,
      hasValidPrediction: this.cachedPrediction?.isValid ?? false,
    }
  }

  // ══════════════════════════════════════════
  //  内部：填充词检测
  // ══════════════════════════════════════════

  /**
   * 从文本中检测填充词/犹豫词。
   * 结果会被缓存以避免重复计算。
   */
  private detectFillers(text: string): { words: string[]; ratio: number } {
    // 缓存查找
    const cached = this.fillerCache.get(text)
    if (cached) return cached

    const found: string[] = []
    const lower = text.toLowerCase()

    // 从长到短匹配（避免短词先匹配阻断长词）
    const sortedFillers = Array.from(FILLER_WORDS).sort(
      (a, b) => b.length - a.length,
    )

    let remaining = lower
    for (const filler of sortedFillers) {
      let idx = remaining.indexOf(filler)
      while (idx !== -1) {
        found.push(filler)
        remaining = remaining.slice(0, idx) + remaining.slice(idx + filler.length)
        idx = remaining.indexOf(filler)
      }
    }

    // 计算填充词字符占比
    const fillerCharCount = found.reduce((sum, w) => sum + w.length, 0)
    const ratio = text.length > 0 ? fillerCharCount / text.length : 0

    const result = { words: found, ratio }
    this.fillerCache.set(text, result)

    // 控制缓存大小
    if (this.fillerCache.size > 200) {
      const firstKey = this.fillerCache.keys().next().value
      if (firstKey) this.fillerCache.delete(firstKey)
    }

    return result
  }

  // ══════════════════════════════════════════
  //  内部：犹豫模式分析
  // ══════════════════════════════════════════

  /**
   * 分析用户的犹豫/填充词使用模式。
   */
  private analyzeHesitation(): HesitationProfile {
    if (this.records.length < MIN_SAMPLES) {
      return {
        overallFillerRatio: 0,
        isHighHesitation: false,
        topFillers: [],
        recommendedConfidenceAdjust: 0,
        sampleCount: this.records.length,
      }
    }

    // 统计每个填充词的频率
    const fillerFreq = new Map<string, number>()
    let totalFillerChars = 0
    let totalChars = 0

    for (const rec of this.records) {
      totalChars += rec.text.length
      totalFillerChars += Math.round(rec.text.length * rec.fillerRatio)
      for (const fw of rec.fillerWords) {
        fillerFreq.set(fw, (fillerFreq.get(fw) || 0) + 1)
      }
    }

    const overallRatio = totalChars > 0 ? totalFillerChars / totalChars : 0

    // TOP 5 填充词
    const topFillers = Array.from(fillerFreq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word, count]) => ({ word, count }))

    // 判断犹豫程度并推荐置信度调整
    let recommendedAdjust = 0
    let isHighHesitation = false

    if (overallRatio > HIGH_HESITATION_RATIO) {
      recommendedAdjust = HESITATION_CONFIDENCE_ADJUST
      isHighHesitation = true
    } else if (overallRatio > MED_HESITATION_RATIO) {
      recommendedAdjust = MED_HESITATION_CONFIDENCE_ADJUST
    }

    return {
      overallFillerRatio: overallRatio,
      isHighHesitation,
      topFillers,
      recommendedConfidenceAdjust: recommendedAdjust,
      sampleCount: this.records.length,
    }
  }

  // ══════════════════════════════════════════
  //  内部：领域词热度分析
  // ══════════════════════════════════════════

  /**
   * 分析用户高频领域词汇，结合低置信度片段和纠正记录，
   * 生成需要提升识别的热词列表。
   *
   * 数据源：
   * 1. AsrHotwordManager 中的高频词（长时词表）
   * 2. AsrLogStore 中的低置信度片段（识别失败但用户可能常用的词）
   * 3. AsrLogStore 中的纠正记录（用户修正过的词）
   */
  private analyzeDomainTermHeat(): string[] {
    const boostedSet = new Set<string>()

    // 1. 从 AsrHotwordManager 长时词表提取 TOP 高频词
    const existingVocab = asrHotwordManager.exportVocabulary()
    for (const entry of existingVocab) {
      if (entry.count >= MIN_NEW_WORD_FREQUENCY && entry.word.length >= 2) {
        boostedSet.add(entry.word)
      }
    }

    // 2. 从 AsrLogStore 分析低置信度片段
    try {
      const lowConfSegments = asrLogStore.getUncorrectedLowConfidenceSegments(
        Date.now() - 24 * 60 * 60 * 1000, // 最近 24 小时
      )
      const segmentWordFreq = new Map<string, number>()

      for (const seg of lowConfSegments.slice(0, MAX_LOW_CONF_ANALYSIS)) {
        const words = this.extractPotentialTerms(seg.text)
        for (const w of words) {
          segmentWordFreq.set(w, (segmentWordFreq.get(w) || 0) + 1)
        }
      }

      // 频次 >= MIN_NEW_WORD_FREQUENCY 的词汇加入提升列表
      for (const [word, freq] of segmentWordFreq) {
        if (freq >= MIN_NEW_WORD_FREQUENCY && word.length >= 2) {
          boostedSet.add(word)
        }
      }
    } catch {
      // AsrLogStore 不可用时优雅降级
    }

    // 3. 从纠正记录提取高频修正词
    try {
      const corrections = asrLogStore.getRecentCorrections(100)
      const correctionWordFreq = new Map<string, number>()

      for (const corr of corrections) {
        const words = this.extractPotentialTerms(corr.corrected)
        for (const w of words) {
          correctionWordFreq.set(w, (correctionWordFreq.get(w) || 0) + 1)
        }
      }

      for (const [word, freq] of correctionWordFreq) {
        if (freq >= MIN_NEW_WORD_FREQUENCY && word.length >= 2) {
          boostedSet.add(word)
        }
      }
    } catch {
      // 优雅降级
    }

    // 按优先级排序：长词 > 短词（长词更具区分度）
    return Array.from(boostedSet).sort((a, b) => {
      // 长度优先
      if (b.length !== a.length) return b.length - a.length
      return a.localeCompare(b)
    })
  }

  /**
   * 从文本中提取潜在的有意义术语（非填充词、非停用词、有意义的 n-gram）。
   * 用于从低置信度片段和纠正记录中挖掘需要学习的词汇。
   */
  private extractPotentialTerms(text: string): string[] {
    if (!text || text.length === 0) return []

    const terms: string[] = []

    // 英文/混合词提取（连续的字母数字，>= 3 字符）
    const engWords = text.match(/[a-zA-Z][a-zA-Z0-9_\-]{2,}/g)
    if (engWords) {
      for (const w of engWords) {
        if (!FILLER_WORDS.has(w.toLowerCase())) {
          terms.push(w.toLowerCase())
        }
      }
    }

    // 中文连续字符段提取（>= 3 字符且有实际意义）
    const cjkRuns = text.match(/[一-鿿]{3,}/g)
    if (cjkRuns) {
      for (const run of cjkRuns) {
        // 跳过纯填充词
        const chars = [...run]
        const meaningfulChars = chars.filter((ch) => !FILLER_WORDS.has(ch))
        if (meaningfulChars.length >= 2) {
          terms.push(run)
        }
        // 额外提取 bigram（双字词，可能是专业术语）
        for (let i = 0; i < run.length - 1; i++) {
          const bigram = run.slice(i, i + 2)
          if (!FILLER_WORDS.has(bigram)) {
            terms.push(bigram)
          }
        }
      }
    }

    // 去重
    return Array.from(new Set(terms))
  }

  // ══════════════════════════════════════════
  //  内部：识别失败模式分析
  // ══════════════════════════════════════════

  /**
   * 从 AsrLogStore 中分析识别失败模式。
   */
  private analyzeFailurePatterns(): RecognitionFailurePattern[] {
    try {
      const segments = asrLogStore.getUncorrectedLowConfidenceSegments(
        Date.now() - 48 * 60 * 60 * 1000, // 最近 48 小时
      )

      // 按文本分组统计
      const patternMap = new Map<string, { frequency: number; wasCorrected: boolean }>()
      for (const seg of segments) {
        if (seg.confidence < LOW_CONF_THRESHOLD) {
          const existing = patternMap.get(seg.text)
          if (existing) {
            existing.frequency++
          } else {
            patternMap.set(seg.text, {
              frequency: 1,
              wasCorrected: seg.wasCorrected,
            })
          }
        }
      }

      // 转换为 RecognitionFailurePattern
      const patterns: RecognitionFailurePattern[] = []
      for (const [original, { frequency, wasCorrected }] of patternMap) {
        // 尝试从纠正记录找到修正文本
        let corrected: string | undefined
        if (wasCorrected) {
          try {
            const corrections = asrLogStore.getRecentCorrections(50)
            const match = corrections.find(
              (c) => c.original === original || c.original.includes(original),
            )
            corrected = match?.corrected
          } catch {
            // 优雅降级
          }
        }

        patterns.push({ original, frequency, wasCorrected, corrected })
      }

      // 按频次降序排列
      return patterns.sort((a, b) => b.frequency - a.frequency)
    } catch {
      return []
    }
  }

  // ══════════════════════════════════════════
  //  内部：Prompt 增强构建
  // ══════════════════════════════════════════

  /**
   * 根据犹豫模式和领域热度构建 initial_prompt 增强片段。
   *
   * 策略：
   * - 高犹豫用户 → 注入宽容提示词（鼓励 ASR 处理自然停顿）
   * - 领域热词 → 注入相关领域词汇
   */
  private buildPromptBoosts(
    hesitation: HesitationProfile,
    boostedTerms: string[],
  ): string[] {
    const boosts: string[] = []

    // 犹豫模式提示
    if (hesitation.overallFillerRatio > MED_HESITATION_RATIO) {
      boosts.push('允许说话者使用嗯、啊、那个、就是等填充词自然地组织语言。')
    }

    // 高犹豫用户的额外提示
    if (hesitation.isHighHesitation) {
      boosts.push('用户习惯用填充词引导句子，请识别主语后的实际内容。')
    }

    // 领域热词提示（TOP 15）
    if (boostedTerms.length > 0) {
      const topTerms = boostedTerms.slice(0, 15)
      boosts.push(`关键词: ${topTerms.join(', ')}。`)
    }

    return boosts
  }

  // ══════════════════════════════════════════
  //  内部：全局置信度调整计算
  // ══════════════════════════════════════════

  /**
   * 基于用户整体语音特征计算置信度全局调整值。
   *
   * 影响因素：
   * - 犹豫比例：犹豫越多 → 置信度要求降低（避免漏识别）
   * - 沉默比例：停顿多 → 置信度略微降低
   * - 语速：说话快 → 置信度略微降低（发音可能含混）
   */
  private calcGlobalConfidenceAdjust(
    hesitation: HesitationProfile,
  ): number {
    let adjust = 0

    // 犹豫比例调整
    adjust += hesitation.recommendedConfidenceAdjust

    // 沉默比例调整（如果记录中有 voiceFeatures）
    if (this.records.length >= MIN_SAMPLES) {
      const recordsWithFeatures = this.records.filter(
        (r) => r.voiceFeatures,
      )
      if (recordsWithFeatures.length >= 2) {
        const avgSilenceRatio =
          recordsWithFeatures.reduce(
            (sum, r) => sum + (r.voiceFeatures?.silenceRatio ?? 0),
            0,
          ) / recordsWithFeatures.length

        if (avgSilenceRatio > HIGH_SILENCE_RATIO) {
          adjust -= 0.05 // 停顿多，适当降低置信度要求
        } else if (avgSilenceRatio > MED_SILENCE_RATIO) {
          adjust -= 0.02
        }

        // 语速分析：平均语速
        const avgSpeechRate =
          recordsWithFeatures.reduce(
            (sum, r) => sum + (r.voiceFeatures?.speechRate ?? 0),
            0,
          ) / recordsWithFeatures.length

        // 如果用户说得特别快（语速 > 5），降低置信度要求
        if (avgSpeechRate > 5.0) {
          adjust -= 0.03
        }
      }
    }

    // 钳位在 [-0.15, 0] 范围（不做正向调整，防止过度自信）
    return Math.max(-0.15, Math.min(0, adjust))
  }

  // ══════════════════════════════════════════
  //  内部：工具方法
  // ══════════════════════════════════════════

  /**
   * 根据填充词比例获取人类可读的描述。
   */
  getHesitationDescription(): string {
    const profile = this.getHesitationProfile()
    if (profile.sampleCount < MIN_SAMPLES) {
      return '正在学习用户的语音习惯...'
    }
    if (profile.isHighHesitation) {
      return `你习惯使用填充词（如「${profile.topFillers[0]?.word ?? '那个'}」），已优化 ASR 对犹豫的容忍度`
    }
    if (profile.overallFillerRatio > MED_HESITATION_RATIO) {
      return '检测到适中的填充词使用，已轻微调整 ASR 参数'
    }
    return '语音习惯平稳，ASR 参数保持默认'
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例，供 AsrService 和 IPC handler 共享 */
export const asrBehaviorPredictor = new AsrBehaviorPredictor()
