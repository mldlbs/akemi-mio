import { log, createRequestId } from '@akemi-mio/core/logger/Logger'
import { WhisperGpuEngine } from './WhisperGpuEngine'
import { WhisperEngine } from './WhisperEngine'
import { BaiduEngine } from './BaiduEngine'
import type { AsrConversationContext, VoiceEmotion, HotwordHit } from './types'
import type { MemoryEntry, InteractionRecord } from '@akemi-mio/intelligence-memory/types'
import { audioFeatureExtractor } from './AudioFeatureExtractor'
import { voiceEmotionClassifier } from './VoiceEmotionClassifier'
import {
  buildEntityDrivenHotwords,
  buildContextualPrompt,
  formatHotwordPrefix,
  isContextMeaningful,
  feedMemoryToEntityExtractor,
  getEntityExtractorStats,
} from './AsrContextBuilder'
import { asrHotwordManager } from './AsrHotwordManager'
import type { VocabEntry, DomainStats } from './AsrHotwordManager'
import { asrLogStore } from './AsrLogStore'
import type { LowConfidenceSegment } from './AsrLogStore'
import { AsrIdleDetector } from './AsrIdleDetector'
import { asrFeedbackAnalyzer } from './AsrFeedbackAnalyzer'
import { asrBehaviorPredictor } from './AsrBehaviorPredictor'
import { asrConfidenceScorer, DEFAULT_CONFIDENCE_THRESHOLD } from './AsrConfidenceScorer'
import { acousticEnvClassifier } from './AsrAcousticEnvironmentClassifier'
import { voiceBehaviorAdaptiveLearner } from './VoiceBehaviorAdaptiveLearner'
import { SpeechPluginRegistry } from './SpeechPluginRegistry'
import { WhisperGpuAsrPlugin, WhisperCpuAsrPlugin, BaiduAsrPlugin } from './adapters'
import { MultiPathDecoderManager, multiPathDecoderManager } from './multipath/MultiPathDecoderManager'
import { fusionEngine } from './multipath/FusionEngine'
import type { MultiPathFusionResult, DecoderHealth } from './multipath/types'

/** 检查识别结果是否有意义：有效字符占比过低则判定为乱码 */
function isGarbled(text: string): boolean {
  if (!text || text.length === 0) return true
  let valid = 0
  for (const ch of text) {
    const code = ch.charCodeAt(0)
    if (
      (code >= 0x20 && code <= 0x7e) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      valid++
    }
  }
  return valid / text.length < 0.6
}

const NOISE_PATTERNS = [
  /^\(.*\)$/, // 括号包裹的噪音幻觉，如 (字幕制作:贝尔)
  /^[\p{P}\p{S}\s]+$/u, // 纯标点符号
]

// Whisper 在静音/底噪下高频幻觉出的社交结束语
const WHISPER_HALLUCINATIONS = [
  /^谢谢大家$/,
  /^谢谢\s*$/,
  /^感谢\s*$/,
  /^感谢大家$/,
  /^再会\s*$/,
  /^再见\s*$/,
  /^谢谢观看\s*$/,
  /^感谢收听\s*$/,
  /^谢谢收看\s*$/,
  /^感谢观看\s*$/,
]

function isNoise(text: string): boolean {
  if (!text || !text.trim()) return true
  const trimmed = text.trim()
  if (trimmed.length <= 1) return true
  if (/^\?+$/.test(trimmed)) return true
  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(trimmed)) return true
  }
  for (const pattern of WHISPER_HALLUCINATIONS) {
    if (pattern.test(trimmed)) return true
  }
  return false
}

export class AsrService {
  private gpuEngine: WhisperGpuEngine
  private cpuEngine: WhisperEngine | null = null
  private cpuInitPromise: Promise<void> | null = null
  private baiduEngine: BaiduEngine
  private baiduApiKey?: string
  private baiduSecretKey?: string
  private _pendingRequests = 0
  /** 当前对话上下文（用于动态热词/提示词），null=使用静态配置 */
  private conversationContext: AsrConversationContext | null = null
  /** 最近一次识别的语音情感分析结果 */
  private _lastVoiceEmotion: VoiceEmotion | null = null
  /** 多路径解码融合管理器（可选，启用后替代顺序降级逻辑） */
  private multiPathManager: MultiPathDecoderManager = multiPathDecoderManager
  /** 多路径融合是否已初始化 */
  private multiPathInitialized = false
  /** 空闲检测器（自适应领域词表微调） */
  private idleDetector: AsrIdleDetector
  /** 空闲优化是否已初始化 */
  private idleOptimizationInitialized = false

  constructor(gpuEngine: WhisperGpuEngine, baiduEngine: BaiduEngine) {
    this.gpuEngine = gpuEngine
    this.baiduEngine = baiduEngine
    this.idleDetector = new AsrIdleDetector(30) // 默认 30 分钟空闲阈值
  }

  private isCorrupted(text: string): boolean {
    return isGarbled(text)
  }

  private async initCpuFallback(): Promise<void> {
    if (this.cpuEngine) return
    if (this.cpuInitPromise) return this.cpuInitPromise
    this.cpuInitPromise = (async () => {
      const engine = new WhisperEngine()
      await engine.initialize('tiny')
      this.cpuEngine = engine
      log('INFO', 'cpu_asr_fallback_ready')
    })()
    return this.cpuInitPromise
  }

  setBaiduCredentials(apiKey: string, secretKey: string): void {
    this.baiduApiKey = apiKey
    this.baiduSecretKey = secretKey
  }

  /**
   * 设置当前对话上下文，用于动态热词和提示词。
   * ASR 在识别前将使用上下文中的主题标签和关键实体构建热词列表和 initial_prompt。
   * 传 null 清除上下文，恢复静态配置。
   *
   * @param context 从 Memory（SummaryMemory）提取的对话上下文
   */
  setConversationContext(context: AsrConversationContext | null): void {
    this.conversationContext = context

    // 从频率热词管理器获取高频词汇（行为驱动热词）
    const freqHotwords = asrHotwordManager.getHotwords()

    // ── 获取行为模式预测优化 ──
    let behaviorBoosts: string[] = []
    let behaviorPromptBoost = ''
    let behaviorHesitationMode: 'normal' | 'relaxed' | 'tolerant' = 'normal'
    try {
      const optimization = asrBehaviorPredictor.getAsrOptimization()
      behaviorBoosts = optimization.hotwordBoosts
      behaviorPromptBoost = optimization.promptBoost
      behaviorHesitationMode = optimization.hesitationMode
    } catch {
      // 行为预测器不可用时优雅降级
    }

    if (context && isContextMeaningful(context)) {
      // 构建实体驱动热词（合并记忆中的命名实体 + 上下文）
      let hotwords = buildEntityDrivenHotwords(context)

      // 合并频率热词：频率热词优先级最高（因为来自用户实际输入），放最前面
      if (freqHotwords.length > 0) {
        const existing = new Set(hotwords)
        const newHotwords = freqHotwords.filter((w) => !existing.has(w))
        hotwords = [...newHotwords, ...hotwords]
      }

      // 合并行为预测热词
      if (behaviorBoosts.length > 0) {
        const existing = new Set(hotwords)
        const newBoosts = behaviorBoosts.filter((w) => !existing.has(w))
        if (newBoosts.length > 0) {
          hotwords = [...hotwords, ...newBoosts]
        }
      }

      let dynamicPrompt = buildContextualPrompt(context)

      // 追加行为预测的 prompt 增强
      if (behaviorPromptBoost) {
        dynamicPrompt = `${dynamicPrompt} ${behaviorPromptBoost}`
      }

      // 注入到 GPU 引擎
      this.gpuEngine.setHotwords(hotwords)
      this.gpuEngine.setInitialPrompt(dynamicPrompt)

      // 注入到 CPU 引擎（如果已初始化）
      if (this.cpuEngine) {
        const hotwordPrefix = formatHotwordPrefix(hotwords)
        this.cpuEngine.setInitialPrompt(`${dynamicPrompt} ${hotwordPrefix}`)
      }

      log('INFO', 'asr_context_set', {
        topics: context.topics.slice(0, 5),
        entities: context.keyEntities.slice(0, 5),
        hotword_count: hotwords.length,
        freq_hotwords: freqHotwords.length,
        behavior_boosts: behaviorBoosts.length,
        hesitation_mode: behaviorHesitationMode,
        has_user_text: !!context.recentUserText,
      })
    } else if (freqHotwords.length > 0 || behaviorBoosts.length > 0) {
      // 没有 Memory 上下文但有频率热词/行为预测热词
      let mergedHotwords = [...freqHotwords]
      if (behaviorBoosts.length > 0) {
        const existing = new Set(mergedHotwords)
        const newBoosts = behaviorBoosts.filter((w) => !existing.has(w))
        mergedHotwords = [...mergedHotwords, ...newBoosts]
      }

      this.gpuEngine.setHotwords(mergedHotwords)
      if (this.cpuEngine) {
        let promptBase = formatHotwordPrefix(mergedHotwords)
        if (behaviorPromptBoost) {
          promptBase = `${behaviorPromptBoost} ${promptBase}`
        }
        this.cpuEngine.setInitialPrompt(promptBase)
      }
      log('INFO', 'asr_context_freq_only', {
        hotword_count: mergedHotwords.length,
        behavior_boosts: behaviorBoosts.length,
        hesitation_mode: behaviorHesitationMode,
      })
    } else {
      // 清除动态覆盖，恢复静态配置
      this.gpuEngine.resetContextOverrides()
      if (this.cpuEngine) {
        this.cpuEngine.resetInitialPrompt()
      }
      if (context) {
        log('INFO', 'asr_context_empty', { note: 'no meaningful context, using static config' })
      }
    }
  }

  /**
   * 初始化热词管理器的长时词表（从持久化存储加载），
   * 然后在 ASR 引擎上应用已学习的词汇。
   * 在应用启动时调用。
   */
  initVocabulary(): void {
    asrHotwordManager.loadPersistedVocabulary()
    this.refreshContext()
    log('INFO', 'asr_vocab_initialized', {
      long_term_count: asrHotwordManager.getLongTermVocabSize(),
      hotwords: asrHotwordManager.getHotwords().slice(0, 5),
    })
  }

  /**
   * 强制刷新 ASR 上下文（结合 Memory 上下文 + 频率热词 + 长时词表）。
   * 可在定时器或用户手动触发时调用。
   */
  refreshContext(): void {
    // 重新获取热词后重新 setConversationContext
    const currentCtx = this.conversationContext
    if (currentCtx) {
      this.setConversationContext(currentCtx)
    } else {
      // 没有 Memory 上下文时，仅推送频率热词
      const freqHotwords = asrHotwordManager.getHotwords()
      if (freqHotwords.length > 0) {
        this.gpuEngine.setHotwords(freqHotwords)
        if (this.cpuEngine) {
          const hotwordPrefix = formatHotwordPrefix(freqHotwords)
          this.cpuEngine.setInitialPrompt(hotwordPrefix)
        }
        log('INFO', 'asr_context_refreshed', {
          hotword_count: freqHotwords.length,
          source: 'vocab_only',
        })
      }
    }
  }

  /**
   * 获取长时词表词汇列表（供 UI 使用）。
   */
  getLearnedVocabulary(): VocabEntry[] {
    return asrHotwordManager.exportVocabulary()
  }

  /**
   * 获取词汇领域分布统计（供 UI 使用）。
   */
  getVocabularyDomainStats(): DomainStats[] {
    return asrHotwordManager.getDomainBreakdown()
  }

  /**
   * 删除指定已学习词汇。
   */
  deleteLearnedWord(word: string): boolean {
    return asrHotwordManager.deleteWord(word)
  }

  /**
   * 清空所有已学习词汇。
   */
  clearAllLearnedVocabulary(): void {
    asrHotwordManager.clearAllVocabulary()
  }

  /** 获取当前对话上下文（用于调试） */
  getConversationContext(): AsrConversationContext | null {
    return this.conversationContext
  }

  /**
   * 向热词管理器喂入用户文本（用于行为驱动的热词提取）。
   * 应在每次获取到用户文本（ASR识别结果或手动输入）后调用。
   */
  feedUserTextToHotwords(text: string): void {
    asrHotwordManager.feedUserText(text)
  }

  /**
   * 将 Memory 中的记忆条目和交互记录馈入实体提取器，
   * 提取命名实体（人名、项目名、地名）并注入 ASR 热词系统。
   *
   * 在 MemoryService 初始化或定期刷新时调用。
   * 这是"记忆唤醒语音热词"功能的入口点。
   *
   * @param entries 记忆条目列表
   * @param interactions 交互记录列表（可选）
   */
  feedMemoryEntries(entries: MemoryEntry[], interactions?: InteractionRecord[]): void {
    feedMemoryToEntityExtractor(entries, interactions)
    log('INFO', 'asr_entity_extractor_fed', {
      entries_count: entries.length,
      has_interactions: !!interactions,
    })
  }

  /** 启用/禁用行为驱动热词增强 */
  toggleHotwordManager(enabled: boolean): void {
    asrHotwordManager.setEnabled(enabled)
  }

  /** 获取热词管理器状态 */
  getHotwordManagerState(): { enabled: boolean; entryCount: number; hotwords: string[]; totalInputs: number } {
    const state = asrHotwordManager.getState()
    return {
      enabled: state.enabled,
      entryCount: state.entries.length,
      hotwords: asrHotwordManager.getHotwords(),
      totalInputs: state.totalInputs,
    }
  }

  /**
   * 检测文本中是否包含当前 ASR 热词。
   * 用于在 ASR 识别完成后，检查是否有记忆相关的热词被命中。
   * 这是"记忆唤醒语音热词"功能的关键检测点。
   *
   * @param text ASR 识别文本
   * @returns 命中的热词列表
   */
  detectHotwordHits(text: string): HotwordHit[] {
    if (!text || text.trim().length === 0) return []

    const hits: HotwordHit[] = []
    const hotwords = asrHotwordManager.getHotwords()
    const lowerText = text.toLowerCase()

    for (const hw of hotwords) {
      const lowerHw = hw.toLowerCase()
      // 简单包含匹配（中文热词常用）
      const count = (lowerText.match(new RegExp(this.escapeRegex(lowerHw), 'gi')) || []).length
      if (count > 0) {
        hits.push({ hotword: hw, count })
      }
    }

    return hits
  }

  /** 转义正则特殊字符 */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  get useBaidu(): boolean {
    return !!(this.baiduApiKey && this.baiduSecretKey)
  }

  get pendingRequests(): number {
    return this._pendingRequests
  }

  /** 获取最近一次识别的语音情感分析结果（供 ChatExecutor 使用） */
  getLastVoiceEmotion(): VoiceEmotion | null {
    return this._lastVoiceEmotion
  }

  /**
   * 记录当前 ASR 识别日志到 AsrLogStore。
   * 不阻塞主流程。
   */
  private recordRecognition(
    engine: 'whisper_gpu' | 'whisper_cpu' | 'baidu',
    rawText: string,
    requestId: string,
    audioDurationSec: number,
    inferenceMs: number,
    options?: { environment?: string; confidence?: number },
  ): void {
    try {
      asrLogStore.recordRecognition({
        id: `rec_${requestId}`,
        timestamp: Date.now(),
        engine,
        rawText,
        requestId,
        audioDurationSec,
        inferenceMs,
        hasHotwordHit: false,
        environment: options?.environment,
        confidence: options?.confidence,
      })
    } catch {
      // 日志记录不阻塞主流程
    }
  }

  /**
   * 如果识别文本的置信度低于阈值，记录到低置信度片段存储。
   * 供后续 Evolution 分析提取未登录词。
   */
  private recordLowConfidenceIfNeeded(
    text: string,
    engine: 'whisper_gpu' | 'whisper_cpu' | 'baidu',
    requestId: string,
    audioDurationSec: number,
    confidence: number,
  ): void {
    if (confidence >= DEFAULT_CONFIDENCE_THRESHOLD) return
    if (!text || text.trim().length === 0) return

    try {
      const segment: LowConfidenceSegment = {
        id: `lowconf_${requestId}`,
        timestamp: Date.now(),
        engine,
        text: text.trim(),
        confidence,
        threshold: DEFAULT_CONFIDENCE_THRESHOLD,
        requestId,
        audioDurationSec,
        wasCorrected: false,
      }
      asrLogStore.recordLowConfidenceSegment(segment)
      log('INFO', 'asr_low_confidence_segment', {
        request_id: requestId,
        text: text.slice(0, 40),
        confidence: Math.round(confidence * 100),
        threshold: DEFAULT_CONFIDENCE_THRESHOLD,
      })
    } catch {
      // 不阻塞主流程
    }
  }

  /**
   * 用户反馈：报告 ASR 识别错误并提供正确文本。
   * 调用后自动更新热词管理器，使后续识别更准确。
   *
   * @param requestId 原始识别的 request_id
   * @param originalText ASR 识别出的原文
   * @param correctedText 用户修正后的正确文本
   */
  feedback(requestId: string, originalText: string, correctedText: string): void {
    // 记录纠正到日志存储
    asrLogStore.recordUserFix(`rec_${requestId}`, originalText, correctedText)

    // 标记关联的低置信度片段为已纠正
    const lowConfSegments = asrLogStore.getLowConfidenceSegmentsSince(0)
    const matchingSegment = lowConfSegments.find((s) => s.requestId === requestId || s.text === originalText)
    if (matchingSegment) {
      asrLogStore.markLowConfSegmentCorrected(matchingSegment.id)
    }

    // 将修正后的文本喂入热词管理器，让系统学习正确词汇
    this.feedUserTextToHotwords(correctedText)

    // ── 自适应学习：记录用户纠正 ──
    voiceBehaviorAdaptiveLearner.recordCorrection(originalText, correctedText)

    // 用户反馈也视为语音活动，重置空闲计时
    this.idleDetector.recordActivity()

    log('INFO', 'asr_user_feedback', {
      request_id: requestId,
      original: originalText.slice(0, 50),
      corrected: correctedText.slice(0, 50),
    })
  }

  // ══════════════════════════════════════════
  //  多路径解码融合集成
  // ══════════════════════════════════════════

  /**
   * 初始化多路径解码融合系统。
   *
   * 将现有的 GPU、CPU（如果已初始化）和 Baidu 引擎注册为多路径解码器，
   * 启动心跳监控，注册错误回调。
   *
   * 调用此方法后，transcribe() 的 useMultiPath 选项才能生效。
   * 应在 ASR 引擎全部就绪后调用一次。
   *
   * @param options 可选的融合配置（覆盖默认值）
   */
  initializeMultiPath(options?: { config?: Partial<import('./multipath/types').MultiPathFusionConfig>; enabled?: boolean }): void {
    if (this.multiPathInitialized) return

    if (options?.config) {
      this.multiPathManager.updateConfig(options.config)
    }

    // 注册 GPU 引擎
    if (this.gpuEngine.getStatus().loaded) {
      this.multiPathManager.registerWhisperGpu(this.gpuEngine, {
        name: 'whisper_gpu',
        modelSize: 'small',
        timeoutMs: 15000,
        initialWeight: 1.2, // GPU 引擎质量高，权重略高
        confidenceBias: 0,
      })
    }

    // 注册 CPU 引擎（如果已初始化）
    if (this.cpuEngine && this.cpuEngine.getStatus().loaded) {
      this.multiPathManager.registerWhisperCpu(this.cpuEngine, {
        name: 'whisper_cpu',
        modelSize: 'tiny',
        timeoutMs: 25000,
        initialWeight: 0.8,
        confidenceBias: -0.05, // tiny 模型倾向于高估置信度，略微下调
      })
    }

    // 注册 Baidu 引擎（如果有凭证）
    if (this.baiduApiKey && this.baiduSecretKey) {
      this.multiPathManager.registerBaidu(this.baiduEngine, this.baiduApiKey, this.baiduSecretKey, {
        name: 'baidu',
        timeoutMs: 20000,
        initialWeight: 0.7,
        confidenceBias: 0.05,
      })
    }

    // 注册错误回调（记录日志）
    this.multiPathManager.onError((msg) => {
      log('WARN', 'asr_multipath_error_event', {
        type: msg.type,
        decoder: msg.decoderName,
        message: msg.message.slice(0, 120),
      })
    })

    this.multiPathInitialized = true

    // 如果配置为启用，启动心跳
    if (options?.enabled !== false) {
      this.multiPathManager.setEnabled(true)
    }

    log('INFO', 'asr_multipath_initialized', {
      decoder_count: this.multiPathManager.getDecoderNames().length,
      enabled: this.multiPathManager.getConfig().enabled,
      active_count: this.multiPathManager.getActiveDecoders().length,
    })
  }

  /**
   * 启用或禁用多路径融合。
   * 切换后，transcribe() 的 useMultiPath 行为随之变化。
   */
  setMultiPathEnabled(enabled: boolean): void {
    if (!this.multiPathInitialized && enabled) {
      this.initializeMultiPath({ enabled })
      return
    }
    this.multiPathManager.setEnabled(enabled)
    log('INFO', 'asr_multipath_enabled', { enabled })
  }

  /**
   * 检查多路径融合是否就绪。
   */
  isMultiPathReady(): boolean {
    return this.multiPathInitialized && this.multiPathManager.isReady()
  }

  /**
   * 获取多路径管理器（供外部高级操作）。
   */
  getMultiPathManager(): MultiPathDecoderManager {
    return this.multiPathManager
  }

  /**
   * 获取多路径解码器的健康状态（供调试/UI 展示）。
   */
  getMultiPathHealth(): DecoderHealth[] {
    return this.multiPathManager.getAllHealth()
  }

  /**
   * 获取多路径融合的权重表（供调试/UI 展示）。
   */
  getMultiPathWeights(): Array<{ name: string; baseWeight: number; dynamicWeight: number; accuracy: number }> {
    return fusionEngine.getWeightTable()
  }

  async transcribe(
    audioBuffer: ArrayBuffer,
    requestId?: string,
    options?: { useMultiPath?: boolean },
  ): Promise<{
    text: string
    request_id: string
    error?: string
    voiceEmotion?: VoiceEmotion
    hotwordHits?: HotwordHit[]
    hasHotwordHit?: boolean
  }> {
    const rid = requestId || createRequestId()
    this._pendingRequests++
    // 通知空闲检测器有语音活动（重置空闲计时）
    this.idleDetector.recordActivity()

    // 使用 try/finally 确保计数器在任何路径下都会递减，防止泄漏
    const decrement = () => {
      this._pendingRequests = Math.max(0, this._pendingRequests - 1)
    }

    try {
      if (this._pendingRequests > 1) {
        log('WARN', 'queue_status', {
          request_id: rid,
          pending_requests: this._pendingRequests,
          warning: 'concurrent ASR requests detected',
        })
      }

      // ── 统一转 Float32 并提取声学特征 / 语音情感 / 环境分类 ──
      const samples = new Int16Array(audioBuffer)
      const float32 = new Float32Array(samples.length)
      for (let i = 0; i < samples.length; i++) float32[i] = samples[i] / 32768

      let audioFeatures: import('./types').AudioFeatures | undefined
      let voiceEmotion: VoiceEmotion | undefined
      let environment: string | undefined
      const audioDurationSec = parseFloat((samples.length / 16000).toFixed(1))

      try {
        if (float32.length >= 512) {
          audioFeatures = audioFeatureExtractor.extractFromFloat32(float32)

          // 语音情感分析
          voiceEmotion = voiceEmotionClassifier.classify(audioFeatures)
          this._lastVoiceEmotion = voiceEmotion

          // 声学环境分类
          const envResult = acousticEnvClassifier.classify(audioFeatures)
          environment = envResult.environment

          log('DEBUG', 'asr_voice_emotion', {
            label: voiceEmotion.label,
            confidence: voiceEmotion.confidence,
            energy: voiceEmotion.features.energy,
            pitchHz: voiceEmotion.features.pitchHz,
            environment,
          })
        }
      } catch (ee) {
        // 特征分析失败不应阻塞 ASR
        log('WARN', 'asr_feature_analysis_failed', { error: String(ee) })
      }

      // ── 多路径解码融合路径（启用时替代顺序降级逻辑） ──
      if (options?.useMultiPath && this.isMultiPathReady()) {
        try {
          const fusionResult = await this.multiPathManager.transcribe(float32, rid)

          // 日志记录
          log('INFO', 'transcription', {
            request_id: rid,
            text: fusionResult.text,
            audio_len_s: audioDurationSec,
            engine: `multipath(${fusionResult.primaryEngine})`,
            confidence: Math.round(fusionResult.confidence * 100),
            fusion_method: fusionResult.fusionMethod,
            active_decoders: fusionResult.activeDecoderCount,
            degraded: fusionResult.degraded,
          })

          // 记录每个解码器的识别日志
          for (const dr of fusionResult.decoderResults) {
            if (dr.success) {
              this.recordRecognition(dr.name as 'whisper_gpu' | 'whisper_cpu' | 'baidu', dr.text, rid, audioDurationSec, dr.latencyMs, {
                environment,
                confidence: dr.confidence,
              })
              this.recordLowConfidenceIfNeeded(
                dr.text,
                dr.name as 'whisper_gpu' | 'whisper_cpu' | 'baidu',
                rid,
                audioDurationSec,
                dr.confidence,
              )
            }
          }

          // 降级情况下记录日志
          if (fusionResult.degraded) {
            const failed = fusionResult.decoderResults.filter((r) => !r.success).map((r) => `${r.name}:${r.error?.slice(0, 60)}`)
            log('WARN', 'asr_multipath_degraded', {
              request_id: rid,
              failed_decoders: failed.join('; '),
              active: fusionResult.activeDecoderCount,
              total: fusionResult.totalDecoderCount,
            })
          }

          // ── 行为预测记录 ──
          asrBehaviorPredictor.recordTranscription(fusionResult.text, fusionResult.confidence, voiceEmotion)
          // ── 自适应学习记录 ──
          voiceBehaviorAdaptiveLearner.recordInteraction(fusionResult.text, fusionResult.confidence, voiceEmotion)

          // 多路径模式下检测热词命中（基于文本匹配当前热词列表）
          const fusionHotwordHits = this.detectHotwordHits(fusionResult.text)
          if (fusionHotwordHits.length > 0) {
            log('INFO', 'asr_multipath_hotword_hit', {
              request_id: rid,
              hits: fusionHotwordHits.map((h: { hotword: string; count: number }) => `${h.hotword}(${h.count})`),
            })
          }

          return {
            text: fusionResult.text,
            request_id: rid,
            voiceEmotion,
            hotwordHits: fusionHotwordHits,
            hasHotwordHit: fusionHotwordHits.length > 0,
          }
        } catch (mpErr) {
          const msg = mpErr instanceof Error ? mpErr.message : String(mpErr)
          log('WARN', 'asr_multipath_failed_fallback_sequential', { request_id: rid, error: msg })
          // 多路径失败，降级到顺序执行
        }
      }

      // 1. GPU Whisper（Vulkan 加速，RTX 3060）
      if (this.gpuEngine.getStatus().loaded) {
        try {
          const result = await this.gpuEngine.transcribe(float32, 15000)

          // GPU 输出编码损坏时降级到 CPU whisper 重新识别
          if (this.isCorrupted(result.text)) {
            log('WARN', 'gpu_asr_utf8_corrupted', {
              request_id: rid,
              text: result.text,
              ratio: (result.text.match(/�/g) || []).length / result.text.length,
            })
            try {
              await this.initCpuFallback()
              if (this.cpuEngine) {
                const cpuResult = await this.cpuEngine.transcribe(float32, 20000, rid)
                const cpuConfidence = asrConfidenceScorer.score(cpuResult.text, audioFeatures)
                this.recordRecognition('whisper_cpu', cpuResult.text, rid, audioDurationSec, cpuResult.duration, {
                  environment,
                  confidence: cpuConfidence,
                })
                this.recordLowConfidenceIfNeeded(cpuResult.text, 'whisper_cpu', rid, audioDurationSec, cpuConfidence)

                // ── 行为预测记录 ──
                asrBehaviorPredictor.recordTranscription(cpuResult.text, cpuConfidence, voiceEmotion)
                // ── 自适应学习记录 ──
                voiceBehaviorAdaptiveLearner.recordInteraction(cpuResult.text, cpuConfidence, voiceEmotion)

                const cpuHits = cpuResult.hits || []
                return { text: cpuResult.text, request_id: rid, voiceEmotion, hotwordHits: cpuHits, hasHotwordHit: cpuHits.length > 0 }
              }
            } catch (cpuErr) {
              log('WARN', 'cpu_asr_fallback_failed', {
                request_id: rid,
                error: String(cpuErr),
              })
            }
          }

          if (isNoise(result.text)) {
            log('INFO', 'asr_noise_filtered', { request_id: rid, text: result.text })
            // ── 自适应学习记录（无意义文本，标记低置信度） ──
            voiceBehaviorAdaptiveLearner.recordInteraction('', 0, voiceEmotion)
            return { text: '', request_id: rid, voiceEmotion, hotwordHits: [], hasHotwordHit: false }
          }

          const gpuConfidence = asrConfidenceScorer.score(result.text, audioFeatures)
          this.recordRecognition('whisper_gpu', result.text, rid, audioDurationSec, result.duration || 0, {
            environment,
            confidence: gpuConfidence,
          })
          this.recordLowConfidenceIfNeeded(result.text, 'whisper_gpu', rid, audioDurationSec, gpuConfidence)

          // ── 行为预测记录 ──
          asrBehaviorPredictor.recordTranscription(result.text, gpuConfidence, voiceEmotion)
          // ── 自适应学习记录 ──
          voiceBehaviorAdaptiveLearner.recordInteraction(result.text, gpuConfidence, voiceEmotion)

          // 提取热词命中信息
          const gpuHits = result.hits || []
          if (gpuHits.length > 0) {
            log('INFO', 'asr_hotword_hit_detected', {
              request_id: rid,
              hits: gpuHits.map((h: { hotword: string; count: number }) => `${h.hotword}(${h.count})`),
              total_count: gpuHits.reduce((s: number, h: { count: number }) => s + h.count, 0),
            })
          }

          return { text: result.text, request_id: rid, voiceEmotion, hotwordHits: gpuHits, hasHotwordHit: gpuHits.length > 0 }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          log('WARN', 'gpu_asr_fallback_to_baidu', { request_id: rid, error: msg })
        }
      }

      // 2. 后备：百度 ASR（云端）
      if (this.useBaidu) {
        try {
          const t0 = Date.now()
          const text = await Promise.race([
            this.baiduEngine.transcribe(Buffer.from(audioBuffer), this.baiduApiKey!, this.baiduSecretKey!),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('baidu asr timeout')), 20000)),
          ])
          const baiduConfidence = asrConfidenceScorer.score(text, audioFeatures)
          log('INFO', 'transcription', {
            request_id: rid,
            text,
            audio_len_s: audioDurationSec,
            asr_inference_ms: Date.now() - t0,
            engine: 'baidu',
            confidence: Math.round(baiduConfidence * 100),
          })
          this.recordRecognition('baidu', text, rid, audioDurationSec, Date.now() - t0, {
            environment,
            confidence: baiduConfidence,
          })
          this.recordLowConfidenceIfNeeded(text, 'baidu', rid, audioDurationSec, baiduConfidence)

          // ── 行为预测记录 ──
          asrBehaviorPredictor.recordTranscription(text, baiduConfidence, voiceEmotion)
          // ── 自适应学习记录 ──
          voiceBehaviorAdaptiveLearner.recordInteraction(text, baiduConfidence, voiceEmotion)

          // 百度路径检测热词命中
          const baiduHotwordHits = this.detectHotwordHits(text)
          if (baiduHotwordHits.length > 0) {
            log('INFO', 'asr_baidu_hotword_hit', {
              request_id: rid,
              hits: baiduHotwordHits.map((h: { hotword: string; count: number }) => `${h.hotword}(${h.count})`),
            })
          }

          return { text, request_id: rid, voiceEmotion, hotwordHits: baiduHotwordHits, hasHotwordHit: baiduHotwordHits.length > 0 }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          log('ERROR', 'asr_all_failed', { request_id: rid, error: msg })
          voiceBehaviorAdaptiveLearner.recordInteraction('', 0, voiceEmotion)
          return { text: '', request_id: rid, error: msg, voiceEmotion }
        }
      }

      voiceBehaviorAdaptiveLearner.recordInteraction('', 0, voiceEmotion)
      return { text: '', request_id: rid, error: 'no ASR engine available', voiceEmotion }
    } finally {
      decrement()
    }
  }

  // ══════════════════════════════════════════
  //  空闲优化集成（自适应领域词表微调）
  // ══════════════════════════════════════════

  /**
   * 初始化空闲优化系统。
   *
   * 1. 创建并启动 AsrIdleDetector（默认 30 分钟空闲阈值）
   * 2. 注册空闲回调 → 触发 AsrFeedbackAnalyzer 批量分析
   * 3. 监控语音活动（transcribe/feedback）自动重置空闲计时
   *
   * 应在 ASR 引擎就绪后调用一次。
   *
   * @param idleMinutes 空闲阈值（分钟），默认 30
   */
  initIdleOptimization(idleMinutes = 30): void {
    if (this.idleOptimizationInitialized) return
    this.idleOptimizationInitialized = true

    // 设置空闲阈值
    this.idleDetector.setIdleThreshold(idleMinutes)

    // 注册空闲回调：触发批量优化
    this.idleDetector.onIdle(() => {
      const result = asrFeedbackAnalyzer.analyzeAndOptimize()
      if (result.changesApplied) {
        log('INFO', 'asr_idle_optimization_completed', {
          totalAnalyzed: result.totalAnalyzed,
          patchesApplied: result.patchesApplied,
          snapshotId: result.snapshotId,
          topCorrected: result.topCorrected.slice(0, 3),
        })
      } else {
        log('INFO', 'asr_idle_optimization_skipped', {
          reason: result.skipReason || 'no changes',
          totalAnalyzed: result.totalAnalyzed,
        })
      }
    })

    // 启动空闲检测器
    this.idleDetector.start()

    log('INFO', 'asr_idle_optimization_init', {
      idleMinutes,
      thresholdMs: this.idleDetector.idleThreshold,
    })
  }

  /**
   * 停止空闲优化系统。
   * 在应用关闭时调用。
   */
  stopIdleOptimization(): void {
    if (!this.idleOptimizationInitialized) return
    this.idleDetector.stop()
    this.idleOptimizationInitialized = false
    log('INFO', 'asr_idle_optimization_stopped')
  }

  /**
   * 获取空闲检测器状态（供调试/UI）。
   */
  getIdleDetectorState(): {
    isRunning: boolean
    isIdle: boolean
    idleDurationMs: number
    thresholdMs: number
    lastAnalyze: { lastAnalyzeAt: number; cacheSize: number }
  } {
    return {
      isRunning: this.idleDetector.isRunning,
      isIdle: this.idleDetector.isIdle,
      idleDurationMs: this.idleDetector.getIdleDuration(),
      thresholdMs: this.idleDetector.idleThreshold,
      lastAnalyze: asrFeedbackAnalyzer.getStats(),
    }
  }

  /**
   * 手动触发一次空闲优化分析（供调试/测试）。
   */
  triggerIdleOptimization(): ReturnType<typeof asrFeedbackAnalyzer.analyzeAndOptimize> {
    return asrFeedbackAnalyzer.analyzeAndOptimize()
  }

  /**
   * 将内部引擎注册为 SpeechPluginRegistry 中的 AsrPlugin。
   *
   * 调用此方法后，外部代码可通过 SpeechPluginRegistry 发现本服务的 ASR 引擎。
   * 不会影响现有的 transcribe 逻辑。
   *
   * 应在 AsrService 初始化完成后（引擎就绪后）调用。
   */
  registerPlugins(): void {
    const registry = SpeechPluginRegistry.getInstance()

    // GPU Whisper 引擎
    const gpuPlugin = new WhisperGpuAsrPlugin(this.gpuEngine)
    registry.registerAsr(gpuPlugin)

    // CPU Whisper 引擎（如果已初始化）
    if (this.cpuEngine) {
      const cpuPlugin = new WhisperCpuAsrPlugin()
      // 将现有引擎实例注入适配器，避免重新初始化
      ;(cpuPlugin as any).engine = this.cpuEngine
      registry.registerAsr(cpuPlugin)
    }

    // 百度引擎
    const baiduPlugin = new BaiduAsrPlugin(this.baiduEngine)
    if (this.baiduApiKey && this.baiduSecretKey) {
      baiduPlugin.setCredentials(this.baiduApiKey, this.baiduSecretKey)
    }
    registry.registerAsr(baiduPlugin)

    log('INFO', 'asr_plugins_registered', {
      gpu: true,
      cpu: !!this.cpuEngine,
      baidu: !!this.baiduApiKey,
    })
  }
}
