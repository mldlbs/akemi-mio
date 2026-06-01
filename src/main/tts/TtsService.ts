import { execFile } from 'child_process'
import { promisify } from 'util'
import { unlinkSync, existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { app, BrowserWindow } from 'electron'
import { log } from '../logger/Logger'
import { TtsStateCallback } from './types'

const execFileAsync = promisify(execFile)

const FFPLAY_PATHS = [
  'C:\\Users\\gf191\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-essentials_build\\bin\\ffplay.exe',
  'ffplay',
]

const PIPER_PY = resolve(join(__dirname, '..', '..', 'scripts', 'piper_speak.py'))
const PIPER_MODEL = resolve(join(__dirname, '..', '..', 'models', 'piper', 'zh_CN-huayan-medium.onnx'))
const useLocalTts = false // 默认 edge-tts，Piper 仅作为离线备选

function findFfplay(): string {
  for (const p of FFPLAY_PATHS) {
    if (p === 'ffplay' || existsSync(p)) return p
  }
  return 'ffplay'
}

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
    .replace(/还行/g, '还型')       // 行(xíng)→型, 避免读成háng
    .replace(/行吧/g, '型吧')
    .replace(/行了/g, '型了')
    .replace(/行吗/g, '型吗')
    .replace(/行不/g, '型不')
    .replace(/行啊/g, '型啊')
    .replace(/行啦/g, '型啦')
  const cleaned = polyphoneFixed
    .replace(/\*{1,2}(.*?)\*{1,2}/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\[[^\]]*\]/g, '')
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

  constructor(onStateUpdate: TtsStateCallback, onAudioReady?: (filePath: string) => void) {
    this.onStateUpdate = onStateUpdate
    this.onAudioReady = onAudioReady ?? null
  }

  setAudioSink(cb: (filePath: string) => void): void {
    this.onAudioReady = cb
  }

  addChunk(chunk: string): void {
    this.sentenceBuf += chunk
    const parts = this.sentenceBuf.split(/(?<=[。！？.!?\n])/)
    if (parts.length > 1) {
      this.sentenceBuf = parts.pop() || ''
      for (const p of parts) {
        const clean = cleanTTS(p.trim())
        if (clean && clean.length >= 2) this.ttsQueue.push(clean)
      }
      // 2000ms 自适应：每来一句重置，LLM 停 2 秒才触发合成
      if (this.batchTimer) clearTimeout(this.batchTimer)
      this.batchTimer = setTimeout(() => {
        this.batchTimer = null
        if (this.ttsQueue.length > 0) this.processQueue()
      }, 2000)
    }
  }

  flushBuffer(): void {
    if (this.batchTimer) { clearTimeout(this.batchTimer); this.batchTimer = null }
    if (!this.sentenceBuf.trim() && this.ttsQueue.length === 0) return
    if (this.sentenceBuf.trim()) {
      const clean = cleanTTS(this.sentenceBuf.trim())
      this.sentenceBuf = ''
      if (clean && clean.length >= 2) this.ttsQueue.push(clean)
    }
    if (this.ttsQueue.length > 0) this.processQueue()
  }

  stop(): void {
    this.playbackStopRequested = true
    if (this.currentProcess) {
      this.currentProcess.kill()
      this.currentProcess = null
    }
    if (this.batchTimer) { clearTimeout(this.batchTimer); this.batchTimer = null }
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
    if (!clean || clean.length < 2) return
    const tempFile = getTempFile()
    const t0 = Date.now()
    try {
      log('INFO', 'tts_synthesize', { char_count: clean.length, engine: useLocalTts ? 'piper' : 'edge-tts' })
      if (useLocalTts) {
        // 本地 Piper TTS (Python, ~2s)
        const piper = execFile('python', [PIPER_PY, tempFile], { timeout: 15000 })
        this.currentProcess = { kill: () => piper.kill() }
        piper.stdin?.end(clean)
        await new Promise<void>((resolve, reject) => {
          piper.on('close', (code) => code === 0 ? resolve() : reject(new Error(`piper exit ${code}`)))
          piper.stderr?.on('data', (d) => console.log('[piper]', d.toString().trim()))
          piper.on('error', reject)
        })
        this.currentProcess = null
      } else {
        // 云端 edge-tts (~3s)
        await execFileAsync('edge-tts', [
          '--voice', 'zh-CN-XiaoxiaoNeural',
          '--text', clean,
          '--write-media', tempFile,
          '--rate', '+10%',
          '--pitch', '+8Hz'
        ], { timeout: 30000 })
      }
      const genTime = Date.now() - t0
      log('PERF', 'tts_synthesis_done', { duration_ms: genTime, chars: clean.length })

      // send audio file path to renderer for playback + wave visualization
      if (this.onAudioReady) {
        this.onAudioReady(tempFile)
      }
      // fallback: use ffplay if no renderer callback
      const ffplay = findFfplay()
      log('INFO', 'tts_playback_start', { player: ffplay })
      const playT0 = Date.now()
      const ffplayTimeout = setTimeout(() => {
        if (this.currentProcess) { this.currentProcess.kill(); this.currentProcess = null }
      }, 30000)
      await new Promise<void>((resolve, reject) => {
        this.playbackStopRequested = false
        const proc = execFile(ffplay, [
          '-nodisp', '-autoexit', tempFile
        ], (err) => {
          clearTimeout(ffplayTimeout)
          if (this.playbackStopRequested) {
            log('INFO', 'tts_playback_stopped', { duration_ms: Date.now() - playT0 })
            resolve()
            return
          }
          if (err && err.code === 1) { resolve(); return }
          if (err) reject(err)
          else resolve()
        })
        this.currentProcess = { kill: () => { clearTimeout(ffplayTimeout); proc.kill() } }
      })
      log('PERF', 'tts_playback_done', { duration_ms: Date.now() - playT0 })
    } catch (err) {
      const errMsg = String(err)
      if (errMsg.includes('ffplay') || errMsg.includes('Exit code')) {
        const code = err instanceof Error && 'code' in err ? (err as any).code : null
        log('ERROR', 'tts_playback_failed', { error_type: 'ffplay_exit', exit_code: code, message: errMsg.slice(0, 200) })
      } else if (errMsg.includes('edge-tts') || errMsg.includes('ETIMEOUT') || errMsg.includes('timed out')) {
        log('ERROR', 'tts_synthesis_failed', { error_type: 'synthesis_timeout', message: errMsg.slice(0, 200) })
      } else {
        log('ERROR', 'tts_failed', { error_type: 'unknown', message: errMsg.slice(0, 200) })
      }
    } finally {
      try { unlinkSync(tempFile) } catch {}
    }
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.ttsQueue.length === 0) return
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
