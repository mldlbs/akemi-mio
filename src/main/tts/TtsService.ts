import { execFile } from 'child_process'
import { promises as fsp, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { log } from '../logger/Logger'
import { TtsStateCallback, EmotionTtsParams, type TtsUserPreference, type ContextVoiceConfig } from './types'
import type { UserBehaviorTtsNeed } from '../behavior/UserBehaviorTtsContract'
import { USE_LOCAL_TTS } from '../config'
import { findFfplay } from '../utils/ffmpeg'
import { ttsRouter } from './TtsRouter'
import { ttsPiperBridge } from './TtsPiperBridge'
import { implicitFeedbackTracker } from './ImplicitFeedbackTracker'
import { ttsExperimentHook } from './TtsExperimentHook'
import { ttsConfigManager } from './TtsConfigManager'
import { SpeechPluginRegistry, PiperTtsPlugin, EdgeTtsPlugin } from '../speech'

/** 默认 TTS 情感参数（无情感分析时使用） */
const DEFAULT_EMOTION_PARAMS: EmotionTtsParams = {
  voice: 'zh-CN-XiaoxiaoNeural',
  rate: '+10%',
  pitch: '+8Hz',
  label: '默认/日常',
}

function getTempFile(): string {
  return join(tmpdir(), `akemi-mio-${Date.now()}.mp3`)
}

export function compileRegexes() {
  const surrogate = /[\uD800-\uDFFF]/g
  const heading = /^#{1,6}\s*/gm
  const bold = /\*{1,2}/g
  const codeFence = /```[\s\S]*?```/g
  const inlineCode = /`([^`]+)`/g
  const imgLink = /!\[([^\]]*)\]\([^)]+\)/g
  const textLink = /\[([^\]]*)\]\([^)]+\)/g
  const parenAction = /[（(][^）)]*[）)]/g
  const listMarker = /^[\s]*[-*+]\s+/gm
  const numberedList = /^\s*\d+[.、]\s+/gm
  const tablePipe = /[|│]/g
  const blockquote = /^>\s+/gm
  const separator = /^[-*_]{3,}\s*$/gm
  const emoji = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu
  const trailingTilde = /[～~]+$/
  const tilde = /[～~]/g
  const ellipsis = /…{2,}/g
  const dash = /—{2,}/g
  const whitespace = /\s{2,}/g
  return {
    surrogate,
    heading,
    bold,
    codeFence,
    inlineCode,
    imgLink,
    textLink,
    parenAction,
    listMarker,
    numberedList,
    tablePipe,
    blockquote,
    separator,
    emoji,
    trailingTilde,
    tilde,
    ellipsis,
    dash,
    whitespace,
  }
}
const RE = compileRegexes()

export function cleanTTS(text: string): string {
  const before = text
  // 剥离流式响应中可能出现的畸形 UTF-16 代理对
  text = text.replace(RE.surrogate, '')
  // 多音字修正
  const polyphoneFixed = text
    .replace(/还行/g, '还型')
    .replace(/行吧/g, '型吧')
    .replace(/行了/g, '型了')
    .replace(/行吗/g, '型吗')
    .replace(/行不/g, '型不')
    .replace(/行啊/g, '型啊')
    .replace(/行啦/g, '型啦')
  const cleaned = polyphoneFixed
    .replace(RE.heading, '')
    .replace(RE.bold, '')
    .replace(RE.codeFence, '')
    .replace(RE.inlineCode, '$1')
    .replace(RE.imgLink, '$1')
    .replace(RE.textLink, '$1')
    .replace(RE.parenAction, '')
    .replace(RE.listMarker, '')
    .replace(RE.numberedList, '')
    .replace(RE.tablePipe, '')
    .replace(RE.blockquote, '')
    .replace(RE.separator, '')
    .replace(RE.emoji, '')
    .replace(RE.trailingTilde, '')
    .replace(RE.tilde, '')
    .replace(RE.ellipsis, '…')
    .replace(RE.dash, '—')
    .replace(RE.whitespace, ' ')
    .trim()
  const removed = before.length - cleaned.length
  if (removed > 0) {
    log('INFO', 'tts_clean', { chars_removed: removed, before: before.length, after: cleaned.length, input_snippet: before.slice(0, 60) })
  }
  if (before.length > 0 && cleaned.length === 0) {
    log('WARN', 'tts_clean_all_filtered', { input: before.slice(0, 100) })
    // 内容全被过滤（纯 emoji/颜文字），回退一个简短语气词避免静音
    return '嗯'
  }
  return cleaned
}

export class TtsService {
  private onStateUpdate: TtsStateCallback
  private onAudioReady: ((filePath: string) => void) | null = null
  private currentProcess: { kill: () => void } | null = null
  private playbackStopRequested = false
  private ttsQueue: string[] = []
  private isProcessing = false
  private sentenceBuf = ''
  private batchTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  /** 当前情感 TTS 参数（由外部通过 setEmotion 更新） */
  private emotionParams: EmotionTtsParams = { ...DEFAULT_EMOTION_PARAMS }
  /** 情感自适应是否启用（用户可关闭） */
  private emotionEnabled = true
  /** TTS 引擎用户偏好 */
  private enginePreference: TtsUserPreference = 'auto'
  /** 当前质量权重 0-1 */
  private qualityWeight = 0.6
  /** 当前延迟权重 0-1 */
  private latencyWeight = 0.4

  /** ── Memory × TTS 深度融合：合成记录回调 ── */
  /** TTS 合成完成后的回调（由 MemoryTtsBridge 注册，用于记录合成历史到 Memory） */
  private onSynthesisComplete: ((record: {
    timestamp: number
    textSnippet: string
    textLength: number
    durationMs: number
    params: EmotionTtsParams
    engine: string
    success: boolean
    label: string
  }) => void) | null = null

  // ── 重听与循环播放 ──

  /** 最近一次播报的原始文本（用于重听 replay） */
  private lastSpokenText = ''
  /** 最近一次播报的清理后文本（用于重听 replay） */
  private lastSpokenCleanText = ''
  /** 循环播放模式是否启用 */
  private loopMode = false
  /** 循环播放间隔（毫秒） */
  private loopIntervalMs = 3000
  /** 循环播放定时器 */
  private loopTimer: ReturnType<typeof setTimeout> | null = null
  /** 循环播放次数计数器 */
  private loopCount = 0
  /** 循环播放最大次数（0 = 无限） */
  private loopMaxCount = 3

  constructor(onStateUpdate: TtsStateCallback, onAudioReady?: (filePath: string) => void) {
    this.onStateUpdate = onStateUpdate
    this.onAudioReady = onAudioReady ?? null
    // 初始化 TTS 配置管理器（确保目录和默认配置就绪）
    ttsConfigManager.initialize()
  }

  setAudioSink(cb: (filePath: string) => void): void {
    this.onAudioReady = cb
  }

  /**
   * 注册 Memory × TTS 深度融合的合成完成回调。
   * 由 MemoryTtsBridge 在 AppRuntime 初始化时注册。
   * 每次合成完成后，回调被调用，将合成事件数据传递给桥接器，
   * 由桥接器决定是否需要记录到记忆系统。
   */
  setOnSynthesisComplete(cb: (record: {
    timestamp: number
    textSnippet: string
    textLength: number
    durationMs: number
    params: EmotionTtsParams
    engine: string
    success: boolean
    label: string
  }) => void): void {
    this.onSynthesisComplete = cb
  }

  /** 更新情感 TTS 参数（由情感分析器驱动） */
  setEmotion(params: EmotionTtsParams): void {
    this.emotionParams = { ...params }
    log('INFO', 'tts_emotion_update', { voice: params.voice, rate: params.rate, pitch: params.pitch, label: params.label })
  }

  /** 启用/禁用情感自适应语音 */
  setEmotionEnabled(enabled: boolean): void {
    this.emotionEnabled = enabled
    log('INFO', 'tts_emotion_enabled', { enabled })
  }

  /** 获取当前情感参数（供调试/UI 展示） */
  getEmotionParams(): EmotionTtsParams {
    return { ...this.emotionParams }
  }

  /** 情感自适应是否启用 */
  isEmotionEnabled(): boolean {
    return this.emotionEnabled
  }

  // ══════════════════════════════════════════
  //  UserBehaviorTtsContract — 消费者驱动的行为自适应
  // ══════════════════════════════════════════

  /** 当前活跃的 UserBehaviorTtsNeed */
  private activeBehaviorNeed: UserBehaviorTtsNeed | null = null

  /**
   * 应用 UserBehavior 的 TTS 消费者需求。
   *
   * 这是 TTS 对 UserBehavior 的合同响应入口：
   * UserBehavior 各子系统通过 buildTtsNeed() 声明对 TTS 的需求，
   * TtsService 在此方法中负责"如何满足"这些需求。
   *
   * 与 setEmotion()（内容驱动的语音风格）互补：
   * - setEmotion(): 基于 LLM 回复内容选择语音风格（VoiceStyle/情感）
   * - applyBehaviorNeed(): 基于用户行为状态选择输出模式（输出量/延迟/音量）
   *
   * @param need 来自 UserBehavior 的聚合需求
   * @param contentParams 内容驱动的语音参数（可选，来自 setEmotion 的最新值）
   */
  applyBehaviorNeed(need: UserBehaviorTtsNeed, contentParams?: EmotionTtsParams): void {
    this.activeBehaviorNeed = { ...need }

    // ── 暂停 TTS ──
    if (need.pauseTts) {
      this.stop()
      log('INFO', 'tts_behavior_paused', { reason: need.reason })
      return
    }

    // ── 根据 outputMode 调整 emotionParams ──
    const baseParams = contentParams ?? this.emotionParams
    const adjustedParams = this.translateNeedToParams(need, baseParams)
    this.emotionParams = adjustedParams

    // ── 根据 priority 调整路由权重 ──
    this.translateNeedToRouting(need)

    // ── 根据 outputMode 调整情境音量 ──
    if (this.contextVoiceConfig) {
      this.contextVoiceConfig = {
        ...this.contextVoiceConfig,
        volume: need.volumeSuggestion,
      }
    }

    log('INFO', 'tts_behavior_need_applied', {
      mode: need.outputMode,
      priority: need.priority,
      pause: need.pauseTts,
      rate: adjustedParams.rate,
      pitch: adjustedParams.pitch,
      label: adjustedParams.label,
      reason: need.reason,
      sources: need.sources.join(','),
    })
  }

  /** 获取当前活跃的行为需求 */
  getActiveBehaviorNeed(): UserBehaviorTtsNeed | null {
    return this.activeBehaviorNeed ? { ...this.activeBehaviorNeed } : null
  }

  /**
   * 将 UserBehaviorTtsNeed 翻译为具体的 voice/rate/pitch 参数。
   *
   * 这是合同的"满足"部分：TTS 根据行为需求自主决定如何调整参数。
   */
  private translateNeedToParams(need: UserBehaviorTtsNeed, base: EmotionTtsParams): EmotionTtsParams {
    const params = { ...base }

    // ── outputMode → rate/pitch 基线 ──
    switch (need.outputMode) {
      case 'silent':
        // 已被 pauseTts 处理，这里仅标记
        params.label = `${params.label}·静默`
        break
      case 'minimal':
        // 精简模式：语速微快，语调中性，避免拖沓
        params.rate = this.adjustRate(params.rate, +5)
        params.pitch = this.adjustPitch(params.pitch, 0)
        params.label = `${params.label}·精简`
        break
      case 'efficient':
        // 高效模式：语速稍快，语调清晰
        params.rate = this.adjustRate(params.rate, +8)
        params.pitch = this.adjustPitch(params.pitch, +3)
        params.label = `${params.label}·高效`
        break
      case 'gentle':
        // 轻柔模式：语速慢，音调低，音量小
        params.rate = this.adjustRate(params.rate, -6)
        params.pitch = this.adjustPitch(params.pitch, -4)
        params.label = `${params.label}·轻柔`
        break
      case 'expressive':
        // 表现力模式：保持基础参数不做压制
        params.label = `${params.label}·表现`
        break
      case 'normal':
      default:
        // 标准模式：不额外调整
        break
    }

    // ── rateSuggestion/pitchSuggestion 微调（被上层叠加） ──
    if (need.rateSuggestion !== 0) {
      params.rate = this.adjustRate(params.rate, need.rateSuggestion)
    }
    if (need.pitchSuggestion !== 0) {
      params.pitch = this.adjustPitch(params.pitch, need.pitchSuggestion)
    }

    return params
  }

  /**
   * 将 UserBehaviorTtsNeed 翻译为路由权重。
   */
  private translateNeedToRouting(need: UserBehaviorTtsNeed): void {
    switch (need.priority) {
      case 'latency':
        // 低延迟优先：本地引擎优先，质量权重降低
        this.qualityWeight = 0.3
        this.latencyWeight = 0.7
        break
      case 'quality':
        // 高质量优先：云端引擎优先
        this.qualityWeight = 0.8
        this.latencyWeight = 0.2
        break
      case 'balanced':
      default:
        // 平衡模式：恢复默认
        this.qualityWeight = 0.6
        this.latencyWeight = 0.4
        break
    }
  }

  /** 在基础语速上叠加调整值 */
  private adjustRate(current: string, delta: number): string {
    const base = parseInt(current.replace(/[^0-9-]/g, '')) || 10
    const clamped = Math.max(-50, Math.min(50, base + delta))
    return `${clamped >= 0 ? '+' : ''}${clamped}%`
  }

  /** 在基础音调上叠加调整值 */
  private adjustPitch(current: string, delta: number): string {
    const base = parseInt(current.replace(/[^0-9-]/g, '')) || 8
    const clamped = Math.max(-20, Math.min(20, base + delta))
    return `${clamped >= 0 ? '+' : ''}${clamped}Hz`
  }

  // ══════════════════════════════════════════
  //  情境自适应语音（UserContext）
  // ══════════════════════════════════════════

  /** 当前情境语音配置 */
  private contextVoiceConfig: ContextVoiceConfig | null = null

  /** 情境自适应是否启用 */
  private contextEnabled = true

  /** 设置情境语音配置（由 UserContextClassifier 驱动） */
  setContextVoiceConfig(config: ContextVoiceConfig | null): void {
    this.contextVoiceConfig = config ? { ...config } : null
    if (config) {
      log('INFO', 'tts_context_update', {
        context: config.label,
        voice: config.voice,
        rate: config.rate,
        pitch: config.pitch,
        piperModel: config.piperModel,
      })
    }
  }

  /** 获取当前情境语音配置 */
  getContextVoiceConfig(): ContextVoiceConfig | null {
    return this.contextVoiceConfig ? { ...this.contextVoiceConfig } : null
  }

  /** 启用/禁用情境自适应语音 */
  setContextEnabled(enabled: boolean): void {
    this.contextEnabled = enabled
    if (!enabled) {
      this.contextVoiceConfig = null
    }
    log('INFO', 'tts_context_enabled', { enabled })
  }

  isContextEnabled(): boolean {
    return this.contextEnabled
  }

  /** 设置 TTS 引擎偏好（auto/cloud/local） */
  setEnginePreference(pref: TtsUserPreference): void {
    this.enginePreference = pref
    ttsRouter.setUserPreference(pref)
    log('INFO', 'tts_engine_preference', { preference: pref })
  }

  /** 获取当前引擎偏好 */
  getEnginePreference(): TtsUserPreference {
    return this.enginePreference
  }

  /** 设置质量/延迟权重（供外部根据场景调整） */
  setRoutingWeights(qualityWeight: number, latencyWeight: number): void {
    this.qualityWeight = Math.max(0, Math.min(1, qualityWeight))
    this.latencyWeight = Math.max(0, Math.min(1, latencyWeight))
  }

  /** 获取当前路由权重 */
  getRoutingWeights(): { qualityWeight: number; latencyWeight: number } {
    return { qualityWeight: this.qualityWeight, latencyWeight: this.latencyWeight }
  }

  /** 获取最近的路由决策（供调试/UI） */
  getLastRoutingDecision() {
    return ttsRouter.getLastDecision()
  }

  // ══════════════════════════════════════════
  //  隐式反馈驱动的语音自适应
  // ══════════════════════════════════════════

  /**
   * 记录用户对 TTS 输出的隐式反馈动作。
   * 由渲染进程（重听/停止按钮）或 ChatExecutor（继续对话/修改指令检测）调用。
   */
  recordImplicitFeedback(action: 'REPLAY' | 'SKIP' | 'INTERRUPT_SPEECH' | 'CONTINUE_CONVERSATION' | 'MODIFY_REQUEST' | 'COMPLETED_NATURALLY'): void {
    if (action === 'REPLAY') {
      implicitFeedbackTracker.recordSimpleAction('REPLAY')
    } else if (action === 'SKIP') {
      implicitFeedbackTracker.recordSimpleAction('SKIP')
    } else {
      implicitFeedbackTracker.recordUserAction(action)
    }
    log('INFO', 'tts_implicit_feedback', { action })
  }

  /** 获取隐式反馈推荐参数 */
  getImplicitFeedbackRecommendation() {
    return implicitFeedbackTracker.getRecommendation()
  }

  /** 获取隐式反馈跟踪器状态 */
  getImplicitFeedbackStatus() {
    return implicitFeedbackTracker.getStatus()
  }

  addChunk(chunk: string): void {
    try {
      this.sentenceBuf += chunk
      const parts = this.sentenceBuf.split(/(?<=[。！？\n])/)
      if (parts.length > 1) {
        this.sentenceBuf = parts.pop() || ''
        for (const p of parts) {
          const clean = cleanTTS(p.trim())
          if (clean && clean.length >= 15) this.ttsQueue.push(clean)
        }
        if (this.batchTimer) clearTimeout(this.batchTimer)
        this.batchTimer = setTimeout(() => {
          this.batchTimer = null
          if (this.ttsQueue.length > 0) this.processQueue()
        }, 500)
      }
    } catch (err) {
      log('WARN', 'tts_add_chunk_error', { error: String(err) })
    }
  }

  flushBuffer(): void {
    this.stopped = false
    if (this.batchTimer) {
      clearTimeout(this.batchTimer)
      this.batchTimer = null
    }
    if (!this.sentenceBuf.trim() && this.ttsQueue.length === 0) return
    if (this.sentenceBuf.trim()) {
      const clean = cleanTTS(this.sentenceBuf.trim())
      this.sentenceBuf = ''
      if (clean && clean.length >= 15) this.ttsQueue.push(clean)
    }
    if (this.ttsQueue.length > 0) this.processQueue()
  }

  stop(): void {
    this.stopped = true
    this.playbackStopRequested = true
    if (this.currentProcess) {
      this.currentProcess.kill()
      this.currentProcess = null
    }
    if (this.batchTimer) {
      clearTimeout(this.batchTimer)
      this.batchTimer = null
    }
    this.ttsQueue = []
    this.sentenceBuf = ''
    this.isProcessing = false
    this.clearLoopTimer()
    this.onStateUpdate({ ttsPlaying: false })
  }

  async speak(text: string): Promise<void> {
    // 循环播放模式下，每播报一轮重置计数器
    if (this.loopMode) {
      this.loopCount = 0
    }

    this.onStateUpdate({ ttsPlaying: true })
    try {
      await this.speakInternal(text)
      // 播报完成后自动调度循环（如果启用了循环模式）
      this.scheduleNextLoop()
    } catch (err) {
      log('ERROR', 'tts_speak_error', { error: String(err) })
    } finally {
      this.onStateUpdate({ ttsPlaying: false })
    }
  }

  // ══════════════════════════════════════════
  //  重听（Replay）与循环播放（Loop）
  // ══════════════════════════════════════════

  /**
   * 重听最后一次播报的内容。
   * 如果没有已播报内容，返回 false。
   */
  async replay(): Promise<boolean> {
    if (!this.lastSpokenCleanText) {
      log('WARN', 'tts_replay_no_text')
      return false
    }

    log('INFO', 'tts_replay', {
      text_len: this.lastSpokenCleanText.length,
      snippet: this.lastSpokenCleanText.slice(0, 50),
    })
    this.recordImplicitFeedback('REPLAY')
    await this.speak(this.lastSpokenText)
    return true
  }

  /**
   * 获取上次播报的文本（供 UI 显示重听按钮状态）。
   */
  getLastSpokenText(): string {
    return this.lastSpokenText
  }

  /**
   * 是否有可重听的内容。
   */
  hasReplayContent(): boolean {
    return this.lastSpokenCleanText.length > 0
  }

  /**
   * 启用/禁用循环播放模式。
   *
   * 循环模式会在每次 speak() 完成后，间隔 loopIntervalMs 毫秒后自动重播。
   * 适合学习类内容（如 TypeScript 知识点的反复收听）。
   *
   * @param enabled - 是否启用循环
   * @param intervalMs - 循环间隔（毫秒，默认 3000）
   * @param maxCount - 最大循环次数（0 = 无限，默认 3）
   */
  setLoopMode(enabled: boolean, intervalMs = 3000, maxCount = 3): void {
    this.loopMode = enabled
    this.loopIntervalMs = Math.max(1000, Math.min(30000, intervalMs))
    this.loopMaxCount = maxCount
    this.loopCount = 0

    if (!enabled) {
      this.clearLoopTimer()
    }

    log('INFO', 'tts_loop_mode', {
      enabled,
      intervalMs: this.loopIntervalMs,
      maxCount: this.loopMaxCount,
    })
  }

  /** 循环播放是否启用 */
  isLoopMode(): boolean {
    return this.loopMode
  }

  /**
   * 播报完成后自动触发循环（由 processQueue 或 speakInternal 在播放结束后调用）。
   */
  private scheduleNextLoop(): void {
    if (!this.loopMode) return
    if (this.loopMaxCount > 0 && this.loopCount >= this.loopMaxCount) {
      log('INFO', 'tts_loop_reached_max', { count: this.loopCount })
      this.setLoopMode(false)
      return
    }

    this.clearLoopTimer()
    this.loopTimer = setTimeout(() => {
      this.loopCount++
      log('INFO', 'tts_loop_tick', {
        count: this.loopCount,
        max: this.loopMaxCount,
      })
      if (this.lastSpokenCleanText) {
        this.speak(this.lastSpokenText)
      }
    }, this.loopIntervalMs)
  }

  /** 清除循环定时器 */
  private clearLoopTimer(): void {
    if (this.loopTimer) {
      clearTimeout(this.loopTimer)
      this.loopTimer = null
    }
  }

  private async speakInternal(text: string): Promise<void> {
    const clean = cleanTTS(text)
    if (!clean || clean.length < 15) return

    // 记录最后播报文本（用于重听 replay）
    this.lastSpokenText = text
    this.lastSpokenCleanText = clean

    const tempFile = getTempFile()
    const t0 = Date.now()

    // ── [自进化语音微调] 参数随机化实验注入 ──
    const baseParams = this.emotionEnabled ? this.emotionParams : DEFAULT_EMOTION_PARAMS
    const { params: experimentParams, variant, baselineParams, experimentGroupId } = ttsExperimentHook.applyRandomization(baseParams)
    const originalParams = this.emotionParams
    if (variant === 'experimental') {
      this.emotionParams = experimentParams
    }

    try {
      const lastDecision = ttsRouter.getLastDecision()
      log('INFO', 'tts_synthesize', {
        char_count: clean.length,
        engine: lastDecision?.engine ?? (USE_LOCAL_TTS ? 'piper' : 'edge-tts'),
        preference: this.enginePreference,
        tts_variant: variant,
        experiment_group: experimentGroupId,
      })
      await this._synthesize(clean, tempFile)
      const synthDurationMs = Date.now() - t0
      log('PERF', 'tts_synthesis_done', { duration_ms: synthDurationMs, chars: clean.length })

      // ── [Memory × TTS 深度融合] 记录合成完成事件到桥接器 ──
      // 桥接器负责决定是否写入 Memory（采样记录），TtsService 不直接依赖 Memory
      if (this.onSynthesisComplete) {
        const lastDecision = ttsRouter.getLastDecision()
        const engine = lastDecision?.engine ?? (USE_LOCAL_TTS ? 'piper' : 'edge-tts')
        const synthParams = this.emotionEnabled ? this.emotionParams : DEFAULT_EMOTION_PARAMS
        this.onSynthesisComplete({
          timestamp: Date.now(),
          textSnippet: clean.slice(0, 80),
          textLength: clean.length,
          durationMs: synthDurationMs,
          params: synthParams,
          engine,
          success: true,
          label: synthParams.label,
        })
      }

      // ── [隐式反馈] 记录本次 TTS 输出参数 ──
      const effectiveParams = this.emotionEnabled ? this.emotionParams : DEFAULT_EMOTION_PARAMS
      const outputId = implicitFeedbackTracker.onTtsOutput(effectiveParams, clean)

      // ── [自进化语音微调] 记录实验信息 ──
      ttsExperimentHook.recordExperiment(
        outputId,
        variant,
        effectiveParams,
        variant === 'experimental' ? baselineParams : undefined,
        experimentGroupId,
      )

      // 仅通过 onAudioReady 发送到渲染进程播放（Web Audio API），
      // 不再额外调用 _playAudio，避免双路播放造成回声/叠音
      if (this.onAudioReady) {
        this.onAudioReady(tempFile)
      }

      // TTS 播放完成后标记自然结束（onAudioReady 的播放是异步的，
      // 实际完成由渲染进程的 AudioContext.onended 触发）
      // 此处通过一个延迟标记"预计完成"时间，作为自然结束的备份判断
      const estimatedDurationMs = Math.max(clean.length * 80, 2000) // 约 80ms/字
      setTimeout(() => {
        implicitFeedbackTracker.onTtsCompleted()
      }, estimatedDurationMs)
    } catch (err) {
      // ── [Memory × TTS 深度融合] 记录合成失败事件 ──
      if (this.onSynthesisComplete) {
        const lastDecision = ttsRouter.getLastDecision()
        const engine = lastDecision?.engine ?? (USE_LOCAL_TTS ? 'piper' : 'edge-tts')
        const synthParams = this.emotionEnabled ? this.emotionParams : DEFAULT_EMOTION_PARAMS
        this.onSynthesisComplete({
          timestamp: Date.now(),
          textSnippet: clean.slice(0, 80),
          textLength: clean.length,
          durationMs: Date.now() - t0,
          params: synthParams,
          engine,
          success: false,
          label: synthParams.label,
        })
      }
      this._logError(err)
    } finally {
      // 恢复原始参数（如果是实验变体）
      if (variant === 'experimental') {
        this.emotionParams = originalParams
      }
      try {
        fsp.unlink(tempFile).catch(() => {})
      } catch {}
    }
  }

  /**
   * 将 TTS 当前状态同步到 TtsPiperBridge，使 PiperOrchestrator 感知。
   * 在每次本地合成前调用。
   */
  private syncTtsStateToBridge(): void {
    ttsPiperBridge.syncTtsState({
      emotionParams: this.emotionEnabled ? this.emotionParams : DEFAULT_EMOTION_PARAMS,
      behaviorNeed: this.activeBehaviorNeed,
      contextVoiceConfig: this.contextVoiceConfig,
      implicitRecommendation: implicitFeedbackTracker.getRecommendation(),
    })
  }

  private async _synthesize(text: string, outputFile: string, attempt = 1): Promise<void> {
    const maxAttempts = 2

    // ── Piper 性能反馈注入路由决策 ──
    // 将 TtsPiperBridge 采集的 Piper 最新性能数据推送给 TtsRouter，
    // 使路由器在 cloud/local 决策时能感知本地引擎的实时表现。
    // 这是在每次合成前执行的轻量级同步操作。
    const piperFeedback = ttsPiperBridge.getPiperFeedback()
    ttsRouter.setPiperPerformance({
      recentLatencyMs: piperFeedback.recentLatencyMs,
      anyModelFailed: piperFeedback.anyModelFailed,
      queueDepth: piperFeedback.queueDepth,
    })

    // ── 路由决策：使用 TtsRouter 动态选择引擎 ──
    // USE_LOCAL_TTS 环境变量作为硬覆盖（向后兼容），优先级高于路由器
    let useLocal: boolean
    if (process.env.USE_LOCAL_TTS === 'true') {
      useLocal = true
    } else if (process.env.USE_LOCAL_TTS === 'false') {
      useLocal = false
    } else {
      // 动态路由：使用缓存的网络状态同步决策（避免每次句子都检测网络）
      const decision = ttsRouter.decideSync({
        qualityWeight: this.qualityWeight,
        latencyWeight: this.latencyWeight,
      })
      useLocal = decision.engine === 'local'
    }

    try {
      if (useLocal) {
        // — TTS × PiperTTS 深度融合：通过 TtsPiperBridge 调用 PiperOrchestrator —
        // 替代原有的直接 execFile('python', [PIPER_SCRIPT, outputFile]) 调用，
        // 享受 PiperOrchestrator 的模型管理、队列调度、自动回退等能力。
        // 同时通过 syncTtsStateToBridge 将 TTS 侧的全局状态（情感参数、行为需求、
        // 情境语音配置、隐式反馈推荐）同步到桥接器，使 Piper 的模型选择和参数
        // 调整能感知 TTS 上下文。

        this.syncTtsStateToBridge()

        const effectiveParams = this.emotionEnabled ? this.emotionParams : DEFAULT_EMOTION_PARAMS
        const result = await ttsPiperBridge.synthesizeWithPiper(text, effectiveParams)

        if (!result.success) {
          throw new Error(result.error || `piper bridge exit with error`)
        }

        // PiperOrchestrator 在自己的 temp 文件中生成音频，
        // 将结果复制到 speakInternal 期望的 outputFile 位置
        if (result.audioFile) {
          await fsp.copyFile(result.audioFile, outputFile)
        } else {
          throw new Error('piper bridge returned no audio file')
        }
        return
      }
      const params = this.emotionEnabled ? this.emotionParams : DEFAULT_EMOTION_PARAMS
      const edgeTts = execFile(
        'edge-tts',
        ['--voice', params.voice, '--text', text, '--write-media', outputFile, '--rate', params.rate, '--pitch', params.pitch],
        { timeout: 30000, windowsHide: true },
      )
      this.currentProcess = { kill: () => edgeTts.kill() }
      await new Promise<void>((resolve, reject) => {
        edgeTts.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`edge-tts exit ${code}`))))
        edgeTts.on('error', reject)
      }).finally(() => {
        if (this.currentProcess?.kill === edgeTts.kill) {
          this.currentProcess = null
        }
      })
    } catch (err) {
      if (attempt < maxAttempts) {
        log('WARN', 'tts_synthesis_retry', { attempt, error: String(err).slice(0, 100), text_len: text.length })
        return this._synthesize(text, outputFile, attempt + 1)
      }
      throw err
    }
  }

  private _playAudio(filePath: string): Promise<void> {
    const ffplay = findFfplay()
    log('INFO', 'tts_playback_start', { player: ffplay })
    const playT0 = Date.now()
    const ffplayTimeout = setTimeout(() => {
      if (this.currentProcess) {
        this.currentProcess.kill()
        this.currentProcess = null
      }
    }, 30000)
    return new Promise<void>((resolve, reject) => {
      this.playbackStopRequested = false
      const proc = execFile(ffplay, ['-nodisp', '-autoexit', filePath], { windowsHide: true }, (err) => {
        clearTimeout(ffplayTimeout)
        if (this.playbackStopRequested) {
          log('INFO', 'tts_playback_stopped', { duration_ms: Date.now() - playT0 })
          resolve()
          return
        }
        if (err && (err.code === 1 || err.code === null)) {
          resolve()
          return
        }
        if (err) reject(err)
        else resolve()
      })
      this.currentProcess = {
        kill: () => {
          clearTimeout(ffplayTimeout)
          proc.kill()
        },
      }
    }).then(() => log('PERF', 'tts_playback_done', { duration_ms: Date.now() - playT0 }))
  }

  private _logError(err: unknown): void {
    const errMsg = String(err)
    if (errMsg.includes('ffplay') || errMsg.includes('Exit code')) {
      const code = err instanceof Error && 'code' in err ? (err as any).code : null
      log('ERROR', 'tts_playback_failed', { error_type: 'ffplay_exit', exit_code: code, message: errMsg.slice(0, 200) })
    } else if (errMsg.includes('edge-tts') || errMsg.includes('ETIMEOUT') || errMsg.includes('timed out')) {
      log('ERROR', 'tts_synthesis_failed', { error_type: 'synthesis_timeout', message: errMsg.slice(0, 200) })
    } else {
      log('ERROR', 'tts_failed', { error_type: 'unknown', message: errMsg.slice(0, 200) })
    }
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.ttsQueue.length === 0 || this.stopped) return
    this.isProcessing = true
    this.onStateUpdate({ ttsPlaying: true })

    try {
      do {
        while (this.ttsQueue.length > 0) {
          const batch: string[] = []
          while (this.ttsQueue.length > 0) batch.push(this.ttsQueue.shift()!)
          await this.speakInternal(batch.join(''))
        }
      } while (this.ttsQueue.length > 0)
    } catch (err) {
      log('ERROR', 'tts_process_queue', { error: String(err) })
    } finally {
      this.isProcessing = false
      this.onStateUpdate({ ttsPlaying: false })
    }
  }

  /**
   * 将内部 TTS 引擎注册为 SpeechPluginRegistry 中的 TtsPlugin。
   *
   * 调用此方法后，外部代码可通过 SpeechPluginRegistry 发现本服务的 TTS 引擎。
   * 不会影响现有的 _synthesize 逻辑。
   *
   * 应在 TtsService 初始化完成后调用。
   */
  registerPlugins(): void {
    const registry = SpeechPluginRegistry.getInstance()

    // Piper 本地引擎
    const piperPlugin = new PiperTtsPlugin()
    registry.registerTts(piperPlugin)

    // Edge TTS 云端引擎
    const edgePlugin = new EdgeTtsPlugin()
    registry.registerTts(edgePlugin)

    log('INFO', 'tts_plugins_registered', {
      piper: true,
      edge_tts: true,
    })
  }
}
