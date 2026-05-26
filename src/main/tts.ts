import { execFile } from 'child_process'
import { promisify } from 'util'
import { createWriteStream, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const execFileAsync = promisify(execFile)
let currentProcess: { kill: () => void } | null = null

function getTempFile(): string {
  return join(tmpdir(), `akemi-mio-${Date.now()}.mp3`)
}

export async function speak(text: string): Promise<void> {
  const tempFile = getTempFile()

  try {
    await execFileAsync('edge-tts', [
      '--voice', 'zh-CN-XiaoxiaoNeural',
      '--text', text,
      '--write-media', tempFile,
      '--rate', '+0%',
      '--pitch', '+0Hz'
    ], { timeout: 30000 })

    await new Promise<void>((resolve, reject) => {
      const ffplay = execFile('ffplay', [
        '-nodisp', '-autoexit', tempFile
      ], (err) => {
        if (err && err.code === 1) {
          resolve()
          return
        }
        if (err) reject(err)
        else resolve()
      })
      currentProcess = { kill: () => ffplay.kill() }
    })
  } catch (err) {
    // Silently fail — speech is optional, text still displays
  } finally {
    try { unlinkSync(tempFile) } catch {}
  }
}

export function stop(): void {
  if (currentProcess) {
    currentProcess.kill()
    currentProcess = null
  }
}
