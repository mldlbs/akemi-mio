import { pipeline, env } from '@xenova/transformers'

env.remoteHost = 'https://hf-mirror.com'

type Transcriber = (audio: Float32Array) => Promise<{ text: string }>

let transcribeFn: Transcriber | null = null
let loading = false
let loadError: string | null = null

export async function initASR(model: 'tiny' | 'small' = 'tiny'): Promise<void> {
  if (transcribeFn) return
  if (loading) throw new Error('already loading')
  loading = true
  loadError = null

  try {
    const pipe = await pipeline(
      'automatic-speech-recognition',
      `Xenova/whisper-${model}`,
      { progress_callback: (_progress: { status: string }) => {} }
    )
    transcribeFn = async (audio: Float32Array) => {
      const result = await pipe(audio, {
        language: 'zh',
        task: 'transcribe'
      }) as { text: string }
      return result
    }
  } catch (err) {
    loadError = String(err)
    throw err
  } finally {
    loading = false
  }
}

export async function transcribe(audioBuffer: Float32Array, timeoutMs = 10000): Promise<{ text: string; duration: number }> {
  if (!transcribeFn) throw new Error('ASR not initialized')

  const start = Date.now()
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), timeoutMs)
  )

  const result = await Promise.race([transcribeFn(audioBuffer), timer])
  return { text: result.text, duration: Date.now() - start }
}

export function getASRStatus(): { loaded: boolean; loading: boolean; error: string | null } {
  return { loaded: !!transcribeFn, loading, error: loadError }
}
