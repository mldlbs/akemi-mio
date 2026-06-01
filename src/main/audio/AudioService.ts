import { execFile } from 'child_process'
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const FFMPEG_PATHS = [
  'C:\\Users\\gf191\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-essentials_build\\bin\\ffmpeg.exe',
  'ffmpeg',
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
]

function findFfmpeg(): string {
  for (const p of FFMPEG_PATHS) {
    if (p === 'ffmpeg' || existsSync(p)) return p
  }
  return 'ffmpeg'
}

export class AudioService {
  async decodeWebMToPCM(webmBuffer: ArrayBuffer): Promise<Buffer> {
    const ffmpeg = findFfmpeg()
    const inputPath = join(tmpdir(), `akemi-input-${Date.now()}.webm`)
    const outputPath = join(tmpdir(), `akemi-output-${Date.now()}.raw`)

    writeFileSync(inputPath, Buffer.from(webmBuffer))

    try {
      try {
        await new Promise<void>((resolve, reject) => {
          execFile(ffmpeg, [
            '-y', '-i', inputPath,
            '-ar', '16000', '-ac', '1',
            '-f', 's16le', outputPath
          ], { timeout: 10000 }, (err) => {
            if (err) reject(err)
            else resolve()
          })
        })
      } catch (ffmpegErr) {
        console.warn('ffmpeg: decode failed, input size:', webmBuffer.byteLength)
        return Buffer.alloc(0)
      }

      return readFileSync(outputPath)
    } finally {
      try { unlinkSync(inputPath) } catch {}
      try { unlinkSync(outputPath) } catch {}
    }
  }
}
