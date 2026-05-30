import { execFile } from 'child_process'
import { promisify } from 'util'
import { unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { BrowserWindow } from 'electron'
import { log } from './logger'

const execFileAsync = promisify(execFile)
let currentProcess: { kill: () => void } | null = null
let mainWindow: BrowserWindow | null = null

export function setMainWindow(w: BrowserWindow | null) {
  mainWindow = w
}

const FFPLAY_PATHS = [
  'C:\\Users\\gf191\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-essentials_build\\bin\\ffplay.exe',
  'ffplay',
]

function findFfplay(): string {
  for (const p of FFPLAY_PATHS) {
    if (p === 'ffplay' || existsSync(p)) return p
  }
  return 'ffplay'
}

function getTempFile(): string {
  return join(tmpdir(), `akemi-mio-${Date.now()}.mp3`)
}

function cleanTTS(text: string): string {
  const before = text
  const cleaned = text
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

async function speakInternal(text: string): Promise<void> {
  const clean = cleanTTS(text)
  if (!clean) return
  const tempFile = getTempFile()
  const t0 = Date.now()
  try {
    log('INFO', 'tts_synthesize', { char_count: clean.length })
    await execFileAsync('edge-tts', [
      '--voice', 'zh-CN-XiaoxiaoNeural',
      '--text', clean,
      '--write-media', tempFile,
      '--rate', '+0%',
      '--pitch', '+0Hz'
    ], { timeout: 30000 })
    const genTime = Date.now() - t0
    log('PERF', 'tts_synthesis_done', { duration_ms: genTime, chars: clean.length })

    const ffplay = findFfplay()
    log('INFO', 'tts_playback_start', { player: ffplay })
    const playT0 = Date.now()
    await new Promise<void>((resolve, reject) => {
      const proc = execFile(ffplay, [
        '-nodisp', '-autoexit', tempFile
      ], (err) => {
        if (err && err.code === 1) { resolve(); return }
        if (err) reject(err)
        else resolve()
      })
      currentProcess = { kill: () => proc.kill() }
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

export async function speak(text: string): Promise<void> {
  mainWindow?.webContents.send('state:update', { ttsPlaying: true })
  await speakInternal(text)
  mainWindow?.webContents.send('state:update', { ttsPlaying: false })
}

let ttsQueue: string[] = []
let isProcessing = false
let sentenceBuf = ''
let batchTimer: ReturnType<typeof setTimeout> | null = null

async function processQueue(): Promise<void> {
  if (isProcessing || ttsQueue.length === 0) return
  isProcessing = true
  mainWindow?.webContents.send('state:update', { ttsPlaying: true })

  do {
    while (ttsQueue.length > 0) {
      const batch: string[] = []
      while (ttsQueue.length > 0) batch.push(ttsQueue.shift()!)
      await speakInternal(batch.join(''))
    }
  } while (ttsQueue.length > 0) // catch items added mid-flight

  isProcessing = false
  mainWindow?.webContents.send('state:update', { ttsPlaying: false })
}

export function addTTSChunk(chunk: string): void {
  sentenceBuf += chunk
  const parts = sentenceBuf.split(/(?<=[。！？.!?\n])/)
  if (parts.length > 1) {
    sentenceBuf = parts.pop() || ''
    for (const p of parts) {
      const clean = cleanTTS(p.trim())
      if (clean) ttsQueue.push(clean)
    }
    // Batch: wait briefly to collect more sentences before starting TTS
    if (batchTimer) clearTimeout(batchTimer)
    batchTimer = setTimeout(() => {
      batchTimer = null
      processQueue()
    }, 300)
  }
}

export function flushTTSBuffer(): void {
  if (batchTimer) { clearTimeout(batchTimer); batchTimer = null }
  const clean = cleanTTS(sentenceBuf.trim())
  if (clean) {
    ttsQueue.push(clean)
    sentenceBuf = ''
    processQueue()
  }
}

export function stop(): void {
  if (currentProcess) {
    currentProcess.kill()
    currentProcess = null
  }
  if (batchTimer) { clearTimeout(batchTimer); batchTimer = null }
  ttsQueue = []
  sentenceBuf = ''
  isProcessing = false
  mainWindow?.webContents.send('state:update', { ttsPlaying: false })
}
