import { execFile } from 'child_process'
import { writeFileSync, unlinkSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

export async function decodeWebMToPCM(webmBuffer: ArrayBuffer): Promise<Float32Array> {
  const inputPath = join(tmpdir(), `akemi-input-${Date.now()}.webm`)
  const outputPath = join(tmpdir(), `akemi-output-${Date.now()}.raw`)

  writeFileSync(inputPath, Buffer.from(webmBuffer))

  try {
    await new Promise<void>((resolve, reject) => {
      execFile('ffmpeg', [
        '-y', '-i', inputPath,
        '-ar', '16000', '-ac', '1',
        '-f', 's16le', outputPath
      ], { timeout: 10000 }, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    const raw = readFileSync(outputPath)
    const samples = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2)
    const float32 = new Float32Array(samples.length)
    for (let i = 0; i < samples.length; i++) {
      float32[i] = samples[i] / 32768
    }
    return float32
  } finally {
    try { unlinkSync(inputPath) } catch {}
    try { unlinkSync(outputPath) } catch {}
  }
}
