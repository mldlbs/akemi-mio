import { log, createRequestId } from '../logger/Logger'
import { WhisperGpuEngine } from './WhisperGpuEngine'
import { WhisperEngine } from './WhisperEngine'
import { BaiduEngine } from './BaiduEngine'
import type { AsrConversationContext, VoiceEmotion } from './types'
import { audioFeatureExtractor } from '../audio/AudioFeatureExtractor'
import { voiceEmotionClassifier } from './VoiceEmotionClassifier'
import {
  buildContextualHotwords,
  buildContextualPrompt,
  formatHotwordPrefix,
  isContextMeaningful,
} from './AsrContextBuilder'
import { asrHotwordManager } from './AsrHotwordManager'
import type { VocabEntry, DomainStats } from './AsrHotwordManager'
import { asrLogStore } from './AsrLogStore'
import type { LowConfidenceSegment } from './AsrLogStore'
import { asrConfidenceScorer, DEFAULT_CONFIDENCE_THRESHOLD } from './AsrConfidenceScorer'
import { acousticEnvClassifier } from './AsrAcousticEnvironmentClassifier'
import { SpeechPluginRegistry, WhisperGpuAsrPlugin, WhisperCpuAsrPlugin, BaiduAsrPlugin } from '../speech'

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

  constructor(gpuEngine: WhisperGpuEngine, baiduEngine: BaiduEngine) {
    this.gpuEngine = gpuEngine
    this.baiduEngine = baiduEngine
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

    if (context && isContextMeaningful(context)) {
      // 构建动态热词和提示词
      let hotwords = buildContextualHotwords(context)

      // 合并频率热词：频率热词优先级最高（因为来自用户实际输入），放最前面
      if (freqHotwords.length > 0) {
        const existing = new Set(hotwords)
        const newHotwords = freqHotwords.filter((w) => !existing.has(w))
        hotwords = [...newHotwords, ...hotwords]
      }

      const dynamicPrompt = buildContextualPrompt(context)

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
        has_user_text: !!context.recentUserText,
      })
    } else if (freqHotwords.length > 0) {
      // 没有 Memory 上下文但有频率热词，仅应用频率热词
      this.gpuEngine.setHotwords(freqHotwords)
      if (this.cpuEngine) {
        const hotwordPrefix = formatHotwordPrefix(freqHotwords)
        this.cpuEngine.setInitialPrompt(hotwordPrefix)
      }
      log('INFO', 'asr_context_freq_only', {
        freq_hotwords: freqHotwords.length,
        sample: freqHotwords.slice(0, 5),
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
    const matchingSegment = lowConfSegments.find(
      (s) => s.requestId === requestId || s.text === originalText,
    )
    if (matchingSegment) {
      asrLogStore.markLowConfSegmentCorrected(matchingSegment.id)
    }

    // 将修正后的文本喂入热词管理器，让系统学习正确词汇
    this.feedUserTextToHotwords(correctedText)

    log('INFO', 'asr_user_feedback', {
      request_id: requestId,
      original: originalText.slice(0, 50),
      corrected: correctedText.slice(0, 50),
    })
  }

  async transcribe(audioBuffer: ArrayBuffer, requestId?: string): Promise<{ text: string; request_id: string; error?: string; voiceEmotion?: VoiceEmotion }> {
    const rid = requestId || createRequestId()
    this._pendingRequests++

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

      let audioFeatures: import('../audio/types').AudioFeatures | undefined
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
                return { text: cpuResult.text, request_id: rid, voiceEmotion }
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
            return { text: '', request_id: rid, voiceEmotion }
          }

          const gpuConfidence = asrConfidenceScorer.score(result.text, audioFeatures)
          this.recordRecognition('whisper_gpu', result.text, rid, audioDurationSec, result.duration || 0, {
            environment,
            confidence: gpuConfidence,
          })
          this.recordLowConfidenceIfNeeded(result.text, 'whisper_gpu', rid, audioDurationSec, gpuConfidence)
          return { text: result.text, request_id: rid, voiceEmotion }
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
          return { text, request_id: rid, voiceEmotion }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          log('ERROR', 'asr_all_failed', { request_id: rid, error: msg })
          return { text: '', request_id: rid, error: msg, voiceEmotion }
        }
      }

      return { text: '', request_id: rid, error: 'no ASR engine available', voiceEmotion }
    } finally {
      decrement()
    }
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
