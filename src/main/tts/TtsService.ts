import { execFile } from 'child_process'
import { promises as fsp, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { log } from '../logger/Logger'
import { TtsStateCallback, EmotionTtsParams, type TtsUserPreference } from './types'
import { PIPER_SCRIPT, USE_LOCAL_TTS } from '../config'
import { findFfplay } from '../utils/ffmpeg'
import { ttsRouter } from './TtsRouter'
import { implicitFeedbackTracker } from './ImplicitFeedbackTracker'

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

  constructor(onStateUpdate: TtsStateCallback, onAudioReady?: (filePath: string) => void) {
    this.onStateUpdate = onStateUpdate
    this.onAudioReady = onAudioReady ?? null
  }

  setAudioSink(cb: (filePath: string) => void): void {
    this.onAudioReady = cb
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
    this.onStateUpdate({ ttsPlaying: false })
  }

  async speak(text: string): Promise<void> {
    this.onStateUpdate({ ttsPlaying: true })
    try {
      await this.speakInternal(text)
    } catch (err) {
      log('ERROR', 'tts_speak_error', { error: String(err) })
    } finally {
      this.onStateUpdate({ ttsPlaying: false })
    }
  }

  private async speakInternal(text: string): Promise<void> {
    const clean = cleanTTS(text)
    if (!clean || clean.length < 15) return
    const tempFile = getTempFile()
    const t0 = Date.now()
    try {
      const lastDecision = ttsRouter.getLastDecision()
      log('INFO', 'tts_synthesize', { char_count: clean.length, engine: lastDecision?.engine ?? (USE_LOCAL_TTS ? 'piper' : 'edge-tts'), preference: this.enginePreference })
      await this._synthesize(clean, tempFile)
      log('PERF', 'tts_synthesis_done', { duration_ms: Date.now() - t0, chars: clean.length })

      // ── [隐式反馈] 记录本次 TTS 输出参数 ──
      const effectiveParams = this.emotionEnabled ? this.emotionParams : DEFAULT_EMOTION_PARAMS
      implicitFeedbackTracker.onTtsOutput(effectiveParams, clean)

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
      this._logError(err)
    } finally {
      try {
        fsp.unlink(tempFile).catch(() => {})
      } catch {}
    }
  }

  private async _synthesize(text: string, outputFile: string, attempt = 1): Promise<void> {
    const maxAttempts = 2

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
        const piper = execFile('python', [PIPER_SCRIPT, outputFile], { timeout: 15000, windowsHide: true })
        this.currentProcess = { kill: () => piper.kill() }
        piper.stdin?.end(text)
        await new Promise<void>((resolve, reject) => {
          piper.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`piper exit ${code}`))))
          piper.stderr?.on('data', (d) => console.log('[piper]', d.toString().trim()))
          piper.on('error', reject)
        }).finally(() => {
          this.currentProcess = null
        })
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
}
