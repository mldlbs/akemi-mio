import { pipeline, env } from '@xenova/transformers'
import { log, createRequestId } from '../logger/Logger'
import { AsrResult, ProgressCallback, HotwordHit } from './types'

const HOTWORDS = ['Agent', 'MCP', 'LangGraph', 'Claude', 'Cursor', 'OpenRouter', '贝斯', '音阶', '和弦', '旋律', '小确幸', '巴赫', '轻音', '晚安', '踏实', '陪伴', '温柔', '练习', '享受']
const SAMPLE_RATE = 16000
const MAX_ASR_AUDIO_SECONDS = 25

export function applyHotwords(text: string): { text: string; hits: HotwordHit[] } {
  let corrected = text
  const hits: HotwordHit[] = []
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

type Transcriber = (audio: Float32Array) => Promise<{ text: string; raw?: string; hits?: HotwordHit[] }>

export class WhisperEngine {
  private transcribeFn: Transcriber | null = null
  private loading = false
  private loadError: string | null = null
  private loadPromise: Promise<void> | null = null
  private currentModel = ''
  private firstInferenceDone = false

  async initialize(model = 'tiny', onProgress?: ProgressCallback): Promise<void> {
    if (this.transcribeFn) return
    if (this.loading && this.loadPromise) return this.loadPromise
    this.loading = true
    this.loadError = null
    this.currentModel = `whisper-${model}`
    log('INFO', 'asr_init_start')
    this.loadPromise = this._doInit(model, onProgress)
    return this.loadPromise
  }

  private async _doInit(model: string, onProgress?: ProgressCallback): Promise<void> {
    const t0 = Date.now()
    const memBefore = process.memoryUsage().rss
    try {
      const modelId = `Xenova/whisper-${model}`
      log('INFO', 'pipeline_create_start', { model: modelId, quantized: true })
      log('INFO', 'before_pipeline', { model: modelId, quantized: true, execution_provider: 'dml' })
      const pipelineStart = Date.now()
      const pendingTimer = setInterval(() => {
        log('PERF', 'pipeline_pending', {
          model: modelId,
          elapsed_ms: Date.now() - pipelineStart,
          stage: 'await_pipeline'
        })
      }, 10000)
      let pipe: Awaited<ReturnType<typeof pipeline>>
      try {
        pipe = await pipeline(
          'automatic-speech-recognition',
          modelId,
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
      } catch (err) {
        log('ERROR', 'pipeline_failed', {
          model: modelId,
          cost_ms: Date.now() - pipelineStart,
          error: String(err)
        })
        throw err
      } finally {
        clearInterval(pendingTimer)
      }
      const pipeTime = Date.now() - t0
      log('INFO', 'after_pipeline', {
        model: modelId,
        cost_ms: Date.now() - pipelineStart,
        execution_provider: 'dml'
      })
      log('INFO', 'pipeline_create_complete', { model: modelId, duration_ms: pipeTime })
      log('INFO', 'pipeline_loaded', {
        model: this.currentModel,
        cost_ms: Date.now() - pipelineStart,
        duration_ms: pipeTime,
        execution_provider: 'dml'
      })
      const memAfter = process.memoryUsage().rss
      const modelSizes: Record<string, number> = { 'large-v3': 1500, 'medium': 800, 'small': 500, 'base': 300, 'tiny': 150 }
      log('INFO', 'asr_init_complete', {
        model: this.currentModel,
        duration_ms: Date.now() - t0,
        memory_delta_mb: Math.round((memAfter - memBefore) / (1024 * 1024)),
        estimated_model_size_mb: modelSizes[model] || 0,
        execution_provider: 'CPU',
        onnx_cleanup_removed: 143
      })
      this.transcribeFn = async (audio: Float32Array) => {
        const result = await pipe(audio, {
          language: 'zh',
          task: 'transcribe',
          max_new_tokens: 100,
          return_timestamps: false,
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
      this.loadError = String(err)
      log('ERROR', 'asr_init_failed', { error: String(err) })
      throw err
    } finally {
      this.loading = false
    }
  }

  async transcribe(audioBuffer: Float32Array, timeoutMs = 10000, requestId?: string): Promise<AsrResult & { request_id: string }> {
    if (!this.transcribeFn) throw new Error('ASR not initialized')

    const maxSamples = SAMPLE_RATE * MAX_ASR_AUDIO_SECONDS
    const audio = audioBuffer.length > maxSamples
      ? audioBuffer.slice(audioBuffer.length - maxSamples)
      : audioBuffer
    const t0 = Date.now()
    const audioLenNum = parseFloat((audio.length / SAMPLE_RATE).toFixed(1))
    const rid = requestId || createRequestId()
    if (audio !== audioBuffer) {
      log('WARN', 'asr_audio_trimmed', {
        request_id: rid,
        original_len_s: parseFloat((audioBuffer.length / SAMPLE_RATE).toFixed(1)),
        trimmed_len_s: audioLenNum
      })
    }
    log('INFO', 'transcription_start', {
      request_id: rid,
      audio_len_s: audioLenNum,
      sample_count: audio.length,
      timeout_ms: timeoutMs
    })

    const timer = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), timeoutMs)
    )

    try {
      const result = await Promise.race([this.transcribeFn(audio), timer])
      const elapsed = Date.now() - t0
      const hotwordHit = result.hits && result.hits.length > 0 ? result.hits[0].hotword : undefined
      log('CHAT', 'transcription', {
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
      if (!this.firstInferenceDone) {
        this.firstInferenceDone = true
        log('PERF', 'first_inference', { audio_duration_s: audioLenNum, inference_ms: elapsed })
      }
      return { text: result.text, duration: elapsed, request_id: rid, raw: result.raw, hits: result.hits }
    } catch (err) {
      log('ERROR', 'transcription_failed', { request_id: rid, error: String(err) })
      throw err
    }
  }

  getStatus(): { loaded: boolean; loading: boolean; error: string | null } {
    return { loaded: !!this.transcribeFn, loading: this.loading, error: this.loadError }
  }

  getModelInfo(): string {
    return this.currentModel || 'not loaded'
  }
}
