import { execFile } from 'child_process'
import { promisify } from 'util'
import { unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { BrowserWindow } from 'electron'

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

export async function speak(text: string): Promise<void> {
  const tempFile = getTempFile()

  mainWindow?.webContents.send('state:update', { ttsPlaying: true })

  try {
    await execFileAsync('edge-tts', [
      '--voice', 'zh-CN-XiaoxiaoNeural',
      '--text', text,
      '--write-media', tempFile,
      '--rate', '+0%',
      '--pitch', '+0Hz'
    ], { timeout: 30000 })

    const ffplay = findFfplay()
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
  } catch (err) {
    console.error('TTS: failed:', String(err))
  } finally {
    mainWindow?.webContents.send('state:update', { ttsPlaying: false })
    try { unlinkSync(tempFile) } catch {}
  }
}

export function stop(): void {
  if (currentProcess) {
    currentProcess.kill()
    currentProcess = null
  }
}
