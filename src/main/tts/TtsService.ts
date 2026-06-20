import { execFile } from 'child_process'
import { unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { log } from '../logger/Logger'
import { TtsStateCallback } from './types'
import { PIPER_SCRIPT, USE_LOCAL_TTS } from '../config'
import { findFfplay } from '../utils/ffmpeg'

function getTempFile(): string {
  return join(tmpdir(), `akemi-mio-${Date.now()}.mp3`)
}

export function cleanTTS(text: string): string {
  const before = text
  // 剥离流式响应中可能出现的畸形 UTF-16 代理对
  text = text.replace(/[\uD800-\uDFFF]/g, '')
  // 多音字修正 — 仅修复 edge-tts 已知会读错的极少数边界情况
  // 99% 的多音字 edge-tts 自己就能正确处理
  const polyphoneFixed = text
    .replace(/还行/g, '还型') // 行(xíng)→型, 避免读成háng
    .replace(/行吧/g, '型吧')
    .replace(/行了/g, '型了')
    .replace(/行吗/g, '型吗')
    .replace(/行不/g, '型不')
    .replace(/行啊/g, '型啊')
    .replace(/行啦/g, '型啦')
  const cleaned = polyphoneFixed
    // markdown 标题标记 ###
    .replace(/^#{1,6}\s*/gm, '')
    // 粗体/斜体 **text** *text* — 仅剥离标记符号，保留文字内容
    .replace(/\*{1,2}/g, '')
    // 反引号代码 (inline code / code fence)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    // 图片/链接标记
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]+\)/g, '$1')
    // 括号动作指示 (表情/动作)
    .replace(/[（(][^）)]*[）)]/g, '')
    // 列表标记
    .replace(/^[\s]*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.、]\s+/gm, '')
    // 表格管道符
    .replace(/[|│]/g, '')
    // 引用标记
    .replace(/^>\s+/gm, '')
    // 分隔线
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // emoji
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
    .replace(/[～~]+$/, '')
    .replace(/[～~]/g, '')
    .replace(/…{2,}/g, '…')
    .replace(/—{2,}/g, '—')
    .replace(/\s{2,}/g, ' ')
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

  constructor(onStateUpdate: TtsStateCallback, onAudioReady?: (filePath: string) => void) {
    this.onStateUpdate = onStateUpdate
    this.onAudioReady = onAudioReady ?? null
  }

  setAudioSink(cb: (filePath: string) => void): void {
    this.onAudioReady = cb
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
      log('INFO', 'tts_synthesize', { char_count: clean.length, engine: USE_LOCAL_TTS ? 'piper' : 'edge-tts' })
      await this._synthesize(clean, tempFile)
      log('PERF', 'tts_synthesis_done', { duration_ms: Date.now() - t0, chars: clean.length })

      // 仅通过 onAudioReady 发送到渲染进程播放（Web Audio API），
      // 不再额外调用 _playAudio，避免双路播放造成回声/叠音
      if (this.onAudioReady) {
        this.onAudioReady(tempFile)
      }
    } catch (err) {
      this._logError(err)
    } finally {
      try {
        unlinkSync(tempFile)
      } catch {}
    }
  }

  private async _synthesize(text: string, outputFile: string, attempt = 1): Promise<void> {
    const maxAttempts = 2
    try {
      if (USE_LOCAL_TTS) {
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
      const edgeTts = execFile(
        'edge-tts',
        ['--voice', 'zh-CN-XiaoxiaoNeural', '--text', text, '--write-media', outputFile, '--rate', '+10%', '--pitch', '+8Hz'],
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
