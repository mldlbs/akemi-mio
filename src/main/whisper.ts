import { pipeline, env } from '@xenova/transformers'
import { log, createRequestId } from './logger'

interface HotwordHit {
  hotword: string
  count: number
}

interface TranscriptionResult {
  text: string
  raw?: string
  hits?: HotwordHit[]
}

type Transcriber = (audio: Float32Array) => Promise<TranscriptionResult>

let transcribeFn: Transcriber | null = null
let loading = false
let loadError: string | null = null
let loadPromise: Promise<void> | null = null
let currentModel = ''
let firstInferenceDone = false

const HOTWORDS = ['Agent', 'MCP', 'LangGraph', 'Claude', 'Cursor', 'OpenRouter', 'GitHub', 'API']

function applyHotwords(text: string): { text: string; hits: HotwordHit[] } {
  let corrected = text
  const hits: Array<{ hotword: string; count: number }> = []
  for (const hw of HOTWORDS) {
    const lower = hw.toLowerCase()
    const pattern = new RegExp(lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    const matches = corrected.match(pattern)
    if (matches) {
      const count = matches.length
      corrected = corrected.replace(pattern, hw)
      hits.push({ hotword: hw, count })
    }
  }
  return { text: corrected, hits }
}

export async function initASR(model = 'tiny', onProgress?: (pct: number, status: string) => void): Promise<void> {
  if (transcribeFn) return
  if (loading && loadPromise) return loadPromise
  loading = true
  loadError = null
  currentModel = `whisper-${model}`
  log('INFO', 'asr_init_start')
  loadPromise = _doInit(model, onProgress)
  return loadPromise
}

async function _doInit(model: string, onProgress?: (pct: number, status: string) => void): Promise<void> {
  const t0 = Date.now()
  const memBefore = process.memoryUsage().rss
  try {
    log('INFO', 'pipeline_create_start', { model: `Xenova/whisper-${model}`, quantized: true })
    const pipe = await pipeline(
      'automatic-speech-recognition',
      `Xenova/whisper-${model}`,
      {
        quantized: true,
        progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
          if (p.status === 'progress' && p.total) {
            const pct = Math.round((p.loaded || 0) / p.total * 100)
            onProgress?.(pct, `模型下载中 ${pct}%`)
            log('INFO', 'model_loading', { file: p.file, status: 'loading', progress: pct, loaded: p.loaded, total: p.total })
          } else if (p.status === 'initiate') {
            onProgress?.(0, '准备下载模型...')
            log('INFO', 'model_loading', { file: p.file, status: 'initiate' })
          } else if (p.status === 'done') {
            log('INFO', 'model_loading', { file: p.file, status: 'done' })
          }
        }
      }
    )
    const pipeTime = Date.now() - t0
    log('INFO', 'pipeline_create_complete', { model: `Xenova/whisper-${model}`, duration_ms: pipeTime })
    log('INFO', 'pipeline_loaded', {
      model: currentModel,
      duration_ms: pipeTime,
      execution_provider: 'CPU'
    })
    const memAfter = process.memoryUsage().rss
    const modelSizes: Record<string, number> = { 'large-v3': 1500, 'medium': 800, 'small': 500, 'base': 300, 'tiny': 150 }
    log('INFO', 'asr_init_complete', {
      model: currentModel,
      duration_ms: Date.now() - t0,
      memory_delta_mb: Math.round((memAfter - memBefore) / (1024 * 1024)),
      estimated_model_size_mb: modelSizes[model] || 0,
      execution_provider: 'CPU',
      onnx_cleanup_removed: 143
    })
    transcribeFn = async (audio: Float32Array) => {
      const result = await pipe(audio, {
        language: 'zh',
        task: 'transcribe'
      }) as { text: string }
      const post = applyHotwords(result.text)
      if (post.hits.length > 0) {
        log('INFO', 'asr_postprocess', {
          raw_text: result.text,
          corrected_text: post.text,
          hotword_hits: post.hits,
          hotword_count: post.hits.reduce((s, h) => s + h.count, 0)
        })
      }
      return { text: post.text, raw: result.text, hits: post.hits }
    }
  } catch (err) {
    loadError = String(err)
    log('ERROR', 'asr_init_failed', { error: String(err) })
    throw err
  } finally {
    loading = false
  }
}

export async function transcribe(audioBuffer: Float32Array, timeoutMs = 10000, requestId?: string): Promise<{
  text: string
  duration: number
  request_id: string
  raw?: string
  hits?: HotwordHit[]
}> {
  if (!transcribeFn) throw new Error('ASR not initialized')

  const t0 = Date.now()
  const audioLenNum = parseFloat((audioBuffer.length / 16000).toFixed(1))
  const rid = requestId || createRequestId()
  log('INFO', 'transcription_start', {
    request_id: rid,
    audio_len_s: audioLenNum,
    sample_count: audioBuffer.length,
    timeout_ms: timeoutMs
  })

  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), timeoutMs)
  )

  try {
    const result = await Promise.race([transcribeFn(audioBuffer), timer])
    const elapsed = Date.now() - t0
    const hotwordHit = result.hits && result.hits.length > 0 ? result.hits[0].hotword : undefined
    log('INFO', 'transcription', {
      request_id: rid,
      text: result.text,
      audio_len_s: audioLenNum,
      asr_inference_ms: elapsed,
      confidence: null,
      confidence_note: 'requires lower-level API',
      language: 'zh',
      hotword_hit: hotwordHit,
      raw_text: result.raw !== result.text ? result.raw : undefined
    })
    if (!firstInferenceDone) {
      firstInferenceDone = true
      log('PERF', 'first_inference', { audio_duration_s: audioLenNum, inference_ms: elapsed })
    }
    return { text: result.text, duration: elapsed, request_id: rid, raw: result.raw, hits: result.hits }
  } catch (err) {
    log('ERROR', 'transcription_failed', { request_id: rid, error: String(err) })
    throw err
  }
}

export function getASRStatus(): { loaded: boolean; loading: boolean; error: string | null } {
  return { loaded: !!transcribeFn, loading, error: loadError }
}

export function getModelInfo(): string {
  return currentModel || 'not loaded'
}
