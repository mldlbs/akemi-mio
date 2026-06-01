import { log, createRequestId } from '../logger/Logger'
import { WhisperGpuEngine } from './WhisperGpuEngine'
import { BaiduEngine } from './BaiduEngine'

export class AsrService {
  private gpuEngine: WhisperGpuEngine
  private baiduEngine: BaiduEngine
  private baiduApiKey?: string
  private baiduSecretKey?: string
  private _pendingRequests = 0

  constructor(gpuEngine: WhisperGpuEngine, baiduEngine: BaiduEngine) {
    this.gpuEngine = gpuEngine
    this.baiduEngine = baiduEngine
  }

  setBaiduCredentials(apiKey: string, secretKey: string): void {
    this.baiduApiKey = apiKey
    this.baiduSecretKey = secretKey
  }

  get useBaidu(): boolean {
    return !!(this.baiduApiKey && this.baiduSecretKey)
  }

  get pendingRequests(): number {
    return this._pendingRequests
  }

  async transcribe(audioBuffer: ArrayBuffer, requestId?: string): Promise<{ text: string; request_id: string; error?: string }> {
    const rid = requestId || createRequestId()
    this._pendingRequests++
    if (this._pendingRequests > 1) {
      log('WARN', 'queue_status', { request_id: rid, pending_requests: this._pendingRequests, warning: 'concurrent ASR requests detected' })
    }

    // 1. GPU Whisper（Vulkan 加速，RTX 3060）
    if (this.gpuEngine.getStatus().loaded) {
      try {
        const samples = new Int16Array(audioBuffer)
        const float32 = new Float32Array(samples.length)
        for (let i = 0; i < samples.length; i++) float32[i] = samples[i] / 32768
        const result = await this.gpuEngine.transcribe(float32, 15000)
        this._pendingRequests--
        return { text: result.text, request_id: rid }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log('WARN', 'gpu_asr_fallback_to_baidu', { request_id: rid, error: msg })
      }
    }

    // 2. 后备：百度 ASR（云端）
    if (this.useBaidu) {
      try {
        const samples = new Int16Array(audioBuffer)
        const audioLen = parseFloat((samples.length / 16000).toFixed(1))
        const t0 = Date.now()
        const text = await Promise.race([
          this.baiduEngine.transcribe(Buffer.from(audioBuffer), this.baiduApiKey!, this.baiduSecretKey!),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('baidu asr timeout')), 20000))
        ])
        log('INFO', 'transcription', {
          request_id: rid, text, audio_len_s: audioLen, asr_inference_ms: Date.now() - t0, engine: 'baidu'
        })
        this._pendingRequests--
        return { text, request_id: rid }
      } catch (err) {
        this._pendingRequests--
        const msg = err instanceof Error ? err.message : String(err)
        log('ERROR', 'asr_all_failed', { request_id: rid, error: msg })
        return { text: '', request_id: rid, error: msg }
      }
    }

    this._pendingRequests--
    return { text: '', request_id: rid, error: 'no ASR engine available' }
  }
}
