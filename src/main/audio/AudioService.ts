import { execFile } from 'child_process'
import { promises as fsp } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { findFfmpeg } from '../utils/ffmpeg'

export class AudioService {
  async decodeWebMToPCM(webmBuffer: ArrayBuffer): Promise<Buffer> {
    const ffmpeg = findFfmpeg()
    const ts = Date.now()
    const inputPath = join(tmpdir(), `akemi-input-${ts}.webm`)
    const outputPath = join(tmpdir(), `akemi-output-${ts}.raw`)

    await fsp.writeFile(inputPath, Buffer.from(webmBuffer))

    try {
      try {
        await new Promise<void>((resolve, reject) => {
          execFile(
            ffmpeg,
            ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-f', 's16le', outputPath],
            { timeout: 10000, windowsHide: true },
            (err) => {
              if (err) reject(err)
              else resolve()
            },
          )
        })
      } catch (ffmpegErr) {
        console.warn('ffmpeg: decode failed, input size:', webmBuffer.byteLength)
        return Buffer.alloc(0)
      }

      return await fsp.readFile(outputPath)
    } finally {
      try {
        await fsp.unlink(inputPath)
      } catch {}
      try {
        await fsp.unlink(outputPath)
      } catch {}
    }
  }
}
