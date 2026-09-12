/**
 * TtsScheduler — 混合 TTS 智能调度器
 *
 * ── 职责 ──
 *
 * 1. 在路由决策前分析文本情感强度和长度，辅助 TtsRouter 做出更精细的引擎选择
 * 2. 合成前查询 TtsCache，命中则直接返回缓存结果，避免重复合成
 * 3. 云端合成完成后将结果写入 TtsCache，后续相同文本+情感标签直接命中
 * 4. 提供统一接口供 Agent 调用，内部透明处理路由、缓存、情感分析
 *
 * ── 情感+长度感知路由 ──
 *
 *   决策逻辑（与 TtsRouter 配合，新增第 3 层）：
 *   - 情感强度低（score < minEmotionForCloud）且文本短（词数 < maxShortTextWords）
 *     → 直接使用本地 Piper（低情感日常短语无需云端表现力）
 *   - RTT > 100ms 且低情感短文本 → 本地 Piper（网络延迟高时避免云端更长等待）
 *   - 高情感文本 → 优先云端（云端更擅长表达丰富情感）
 *   - 其余情况 → 由 TtsRouter 基于质量/延迟权重决策
 *
 * ── 缓存集成 ──
 *
 *   synthesize() 调用流程：
 *   1. checkCache(text, emotionLabel) → 命中直接返回缓存音频路径
 *   2. 分析情感（可选） → 将 emotionStrength + textLength 传给 TtsRouter
 *   3. TtsRouter 决策引擎
 *   4. 调用 TtsService._synthesize() 或直接调用引擎
 *   5. 云端合成完成 → setCache(text, emotionLabel, audioFile)
 *
 * ── 统一接口 ──
 *
 *   Agent 通过 TtsSpeakTool → TtsService.speak() → TtsScheduler.synthesize() 调用，
 *   无需关心底层使用哪个引擎或是否命中缓存。
 *
 * ── 集成点 ──
 *
 *   - TtsRouter: 情感+长度数据注入路由决策
 *   - TtsCache: 缓存查询和写入
 *   - SentimentAnalyzer: 文本情感分析
 *   - TtsService: 实际的引擎合成调用
 *   - PhrasePregenService: 高频短语预生成
 *   - NetworkMonitor: RTT 周期性检测（已有 5s 缓存）
 */

import { join } from 'path'
import { tmpdir } from 'os'
import { log } from '@akemi-mio/core/logger/Logger'
import { ttsRouter } from './TtsRouter'
import { ttsCache } from './TtsCache'
import { sentimentAnalyzer } from './SentimentAnalyzer'
import { phrasePregenService, PHRASES } from './PhrasePregenService'
import type { EmotionTtsParams, TtsRoutingDecision } from './types'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** TS 词数估算：中英文混合文本统一按 1.5 字符/词估算 */
const AVG_CHARS_PER_WORD = 1.5

/** 调度器配置 */
export interface TtsSchedulerConfig {
  /** 是否启用情感分析辅助路由 */
  enableEmotionRouting: boolean
  /** 是否启用缓存 */
  enableCache: boolean
  /** 是否启用短语预生成缓存 */
  enablePhrasePregen: boolean
  /** 情感强度低于此值视为低情感（绝对值 0-1） */
  minEmotionStrength: number
  /** 文本少于此词数视为短文本 */
  minShortTextWords: number
  /** RTT 检测是否启用（NetworkMonitor 自带 5s 缓存） */
  enableRttMonitor: boolean
  /** 是否启用提前预热（预生成短语） */
  enableWarmup: boolean
  /** 日志详细程度 */
  verbose: boolean
}

/** 合成请求参数 */
export interface TtsSynthesizeRequest {
  /** 要合成的文本 */
  text: string
  /** 情感 TTS 参数（可选，来源：VoiceStyleMap/EmotionToneMap 等） */
  emotionParams?: EmotionTtsParams
  /** 显式情感强度（可选，覆盖自动分析结果） */
  emotionStrength?: number
  /** 显式文本长度（词数，可选，覆盖自动计算） */
  textLength?: number
  /** 强制使用指定引擎（可选，覆盖路由决策） */
  forceEngine?: 'cloud' | 'local'
}

/** 合成结果 */
export interface TtsSynthesizeResult {
  /** 音频文件路径 */
  audioFile: string
  /** 是否命中缓存 */
  fromCache: boolean
  /** 使用的引擎 */
  engine: 'cloud' | 'local'
  /** 路由决策原因 */
  decisionReason: string
  /** 情感强度（绝对值 0-1） */
  emotionStrength: number | undefined
  /** 文本长度（词数） */
  textLength: number | undefined
}

/** 调度器统计信息 */
export interface TtsSchedulerStats {
  totalRequests: number
  cacheHits: number
  cacheMisses: number
  cloudRequests: number
  piperRequests: number
  emotionRouted: number
  rttRouted: number
}

// ══════════════════════════════════════════
//  默认配置
// ══════════════════════════════════════════

export const DEFAULT_TTS_SCHEDULER_CONFIG: TtsSchedulerConfig = {
  enableEmotionRouting: true,
  enableCache: true,
  enablePhrasePregen: true,
  minEmotionStrength: 0.4,
  minShortTextWords: 10,
  enableRttMonitor: true,
  enableWarmup: true,
  verbose: false,
}

// ══════════════════════════════════════════
//  TtsScheduler
// ══════════════════════════════════════════

export class TtsScheduler {
  private config: TtsSchedulerConfig
  private initialized = false

  /** 统计数据 */
  private stats: TtsSchedulerStats = {
    totalRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    cloudRequests: 0,
    piperRequests: 0,
    emotionRouted: 0,
    rttRouted: 0,
  }

  /** 外部引擎合成回调 — 由 TtsService 注册，用于执行实际的引擎合成 */
  private engineSynthesizeFn: ((text: string, outputFile: string, useLocal: boolean) => Promise<void>) | null = null

  constructor(config?: Partial<TtsSchedulerConfig>) {
    this.config = { ...DEFAULT_TTS_SCHEDULER_CONFIG, ...config }
  }

  // ══════════════════════════════════════════
  //  初始化
  // ══════════════════════════════════════════

  /**
   * 初始化调度器。
   * 初始化 TtsCache、启动 PhrasePregenService。
   */
  async initialize(cacheDir?: string): Promise<void> {
    if (this.initialized) return

    // 初始化缓存
    if (this.config.enableCache) {
      ttsCache.initialize(cacheDir)
    }

    // 启动高频短语预生成
    if (this.config.enablePhrasePregen && this.config.enableWarmup) {
      // 不阻塞初始化
      phrasePregenService.initialize().catch((err) => {
        log('WARN', 'tts_scheduler_phrase_pregen_error', { error: String(err) })
      })
    }

    this.initialized = true
    log('INFO', 'tts_scheduler_initialized', {
      emotionRouting: this.config.enableEmotionRouting,
      cache: this.config.enableCache,
      phrasePregen: this.config.enablePhrasePregen,
      rttMonitor: this.config.enableRttMonitor,
    })
  }

  /**
   * 注册引擎合成回调。
   * 由 TtsService 在初始化时注册，指向其内部的 _synthesize() 方法。
   */
  setEngineSynthesizeFn(fn: (text: string, outputFile: string, useLocal: boolean) => Promise<void>): void {
    this.engineSynthesizeFn = fn
  }

  // ══════════════════════════════════════════
  //  核心合成 API
  // ══════════════════════════════════════════

  /**
   * 合成语音 — 统一入口。
   *
   * 内部自动处理：
   * 1. 缓存查询（命中则直接返回）
   * 2. 情感分析 + 文本长度估算
   * 3. 智能路由决策（TtsRouter + 情感/长度感知）
   * 4. 引擎实际合成
   * 5. 云端结果写入缓存
   *
   * @param request 合成请求
   * @returns 合成结果
   */
  async synthesize(request: TtsSynthesizeRequest): Promise<TtsSynthesizeResult> {
    this.stats.totalRequests++

    const cleanedText = request.text.trim()
    const emotionLabel = request.emotionParams?.label || '默认/日常'
    const emotionStrength = request.emotionStrength ?? this.analyzeEmotionStrength(cleanedText)
    const textLength = request.textLength ?? this.estimateWordCount(cleanedText)

    // ── 第 1 步：检查缓存 ──
    if (this.config.enableCache && !request.forceEngine) {
      const cachedFile = ttsCache.checkCache(cleanedText, emotionLabel)
      if (cachedFile) {
        this.stats.cacheHits++

        // 从缓存文件名推断引擎
        const engine = cachedFile.endsWith('.wav') ? 'local' : 'cloud'

        if (this.config.verbose) {
          log('DEBUG', 'tts_scheduler_cache_hit', {
            textSnippet: cleanedText.slice(0, 40),
            emotionLabel,
            engine,
            filePath: cachedFile,
          })
        }

        return {
          audioFile: cachedFile,
          fromCache: true,
          engine,
          decisionReason: 'cache_hit',
          emotionStrength,
          textLength,
        }
      }
      this.stats.cacheMisses++
    }

    // ── 第 2 步：情感长度感知路由（先同步判断，避免不必要的网络请求） ──
    const isLowEmotionShortText = this.isLowEmotionShortText(emotionStrength, textLength)

    // ── 第 3 步：决定使用哪个引擎 ──
    let useLocal: boolean
    let decision: TtsRoutingDecision
    let decisionReason: string

    if (request.forceEngine) {
      // 强制指定引擎
      useLocal = request.forceEngine === 'local'
      decisionReason = `force_${request.forceEngine}`
    } else {
      // 先做轻量同步决策
      decision = ttsRouter.decideSync({
        qualityWeight: undefined, // 使用默认
        latencyWeight: undefined,
        emotionStrength,
        textLength,
      })
      useLocal = decision.engine === 'local'
      decisionReason = decision.reason

      // 记录情感/长度相关的路由统计
      if (decisionReason.startsWith('low_emotion') || decisionReason.startsWith('sync_low_emotion')) {
        this.stats.emotionRouted++
      }
      if (decisionReason.includes('rtt_') && decisionReason.includes('exceeds_')) {
        this.stats.rttRouted++
      }
    }

    if (useLocal) {
      this.stats.piperRequests++
    } else {
      this.stats.cloudRequests++
    }

    if (this.config.verbose) {
      log('DEBUG', 'tts_scheduler_routing', {
        engine: useLocal ? 'local' : 'cloud',
        reason: decisionReason,
        emotionStrength,
        textLength,
        isLowEmotionShortText,
      })
    }

    // ── 第 4 步：执行合成（通过已注册的回调） ──
    if (!this.engineSynthesizeFn) {
      throw new Error('TtsScheduler: engineSynthesizeFn 未注册。请在初始化后调用 setEngineSynthesizeFn()')
    }

    const tempFile = this.getTempFile(useLocal)
    await this.engineSynthesizeFn(cleanedText, tempFile, useLocal)

    // ── 第 5 步：云端结果写入缓存 ──
    if (this.config.enableCache && !useLocal) {
      ttsCache.setCache(tempFile, cleanedText, emotionLabel, 'cloud')
    }

    return {
      audioFile: tempFile,
      fromCache: false,
      engine: useLocal ? 'local' : 'cloud',
      decisionReason,
      emotionStrength,
      textLength,
    }
  }

  /**
   * 检查缓存是否命中（轻量同步查询）。
   * Agent 调用前可用此方法快速判断。
   */
  checkCache(text: string, emotionLabel?: string): string | null {
    if (!this.config.enableCache) return null
    return ttsCache.checkCache(text, emotionLabel || '默认/日常')
  }

  /**
   * 判断给定文本是否是高频短语（在预生成列表中）。
   */
  isHighFrequencyPhrase(text: string): boolean {
    return PHRASES.some((p) => p.text === text)
  }

  // ══════════════════════════════════════════
  //  统计 & 管理
  // ══════════════════════════════════════════

  /** 获取统计信息 */
  getStats(): TtsSchedulerStats {
    return { ...this.stats }
  }

  /** 重置统计信息 */
  resetStats(): void {
    this.stats = {
      totalRequests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cloudRequests: 0,
      piperRequests: 0,
      emotionRouted: 0,
      rttRouted: 0,
    }
  }

  /** 获取配置 */
  getConfig(): TtsSchedulerConfig {
    return { ...this.config }
  }

  /** 更新配置 */
  updateConfig(partial: Partial<TtsSchedulerConfig>): void {
    this.config = { ...this.config, ...partial }

    // 同步更新底层组件的配置
    ttsCache.setEnabled(this.config.enableCache)
    phrasePregenService.setEnabled(this.config.enablePhrasePregen)

    log('INFO', 'tts_scheduler_config_updated', { ...this.config })
  }

  /** 强制刷新短语预生成 */
  async refreshPhrases(piperModel?: string): Promise<void> {
    await phrasePregenService.refresh(piperModel)
  }

  // ══════════════════════════════════════════
  //  内部方法
  // ══════════════════════════════════════════

  /**
   * 分析文本情感强度（绝对值）。
   * 使用 SentimentAnalyzer 获取 sentiment score 的绝对值。
   * score 0-1 的绝对值作为情感强度。
   */
  private analyzeEmotionStrength(text: string): number | undefined {
    if (!this.config.enableEmotionRouting) return undefined

    try {
      const result = sentimentAnalyzer.analyze(text)
      // score 的绝对值作为情感强度
      return Math.abs(result.score)
    } catch {
      // 情感分析失败不阻塞路由
      return undefined
    }
  }

  /**
   * 估算文本词数。
   * 中英文混合文本统一按 AVG_CHARS_PER_WORD 字符/词估算。
   */
  private estimateWordCount(text: string): number {
    if (!text || text.length === 0) return 0
    return Math.round(text.length / AVG_CHARS_PER_WORD)
  }

  /**
   * 判断是否低情感短文本。
   * emotionStrength 已知且 < minEmotionStrength 且 textLength < minShortTextWords。
   */
  private isLowEmotionShortText(emotionStrength: number | undefined, textLength: number): boolean {
    if (emotionStrength === undefined) return false
    return emotionStrength < this.config.minEmotionStrength && textLength < this.config.minShortTextWords
  }

  /**
   * 获取临时文件路径。
   * Piper 输出 .wav，云端输出 .mp3。
   */
  private getTempFile(useLocal: boolean): string {
    const ext = useLocal ? '.wav' : '.mp3'
    return join(tmpdir(), `akemi-mio-tts-${Date.now()}${ext}`)
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例 */
export const ttsScheduler = new TtsScheduler()
