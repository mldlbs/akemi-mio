/**
 * BaiduAsrPlugin — 百度云 ASR 插件适配器
 *
 * 将现有的 BaiduEngine 封装为 AsrPlugin 接口，使其可通过
 * SpeechPluginRegistry 发现和加载。
 *
 * Baidu ASR 是云端后备引擎，需要 API Key / Secret Key 配置。
 */

import type { AsrPlugin, AsrPluginStatus, AsrTranscribeOptions, AsrTranscribeResult, SpeechPluginManifest } from '../types'
import { BaiduEngine } from '../BaiduEngine'

export class BaiduAsrPlugin implements AsrPlugin {
  readonly manifest: SpeechPluginManifest = {
    name: 'baidu_asr',
    version: '1.0.0',
    description: 'Baidu Cloud ASR REST API (fallback engine when GPU/CPU Whisper unavailable)',
    capability: 'asr',
    priority: 10,
    author: 'akemi-mio',
  }

  private engine: BaiduEngine
  private apiKey: string | null = null
  private secretKey: string | null = null

  constructor(engine?: BaiduEngine) {
    this.engine = engine ?? new BaiduEngine()
  }

  /**
   * 设置百度 ASR 的 API 凭据。
   * 可在初始化前或初始化后调用。
   */
  setCredentials(apiKey: string, secretKey: string): void {
    this.apiKey = apiKey
    this.secretKey = secretKey
  }

  /** 检查凭据是否已配置 */
  get hasCredentials(): boolean {
    return !!(this.apiKey && this.secretKey)
  }

  // ── AsrPlugin 接口实现 ──

  async transcribe(audio: Float32Array, options?: AsrTranscribeOptions): Promise<AsrTranscribeResult> {
    if (!this.apiKey || !this.secretKey) {
      throw new Error('Baidu ASR not configured: missing API key or secret key')
    }

    // Float32Array → Int16 → Buffer
    const int16 = new Int16Array(audio.length)
    for (let i = 0; i < audio.length; i++) {
      int16[i] = Math.max(-32768, Math.min(32767, Math.round(audio[i] * 32768)))
    }
    const pcmBuffer = Buffer.from(int16.buffer)

    const t0 = Date.now()
    const text = await this.engine.transcribe(pcmBuffer, this.apiKey, this.secretKey)
    const duration = Date.now() - t0

    return { text, duration }
  }

  getStatus(): AsrPluginStatus {
    return {
      loaded: this.hasCredentials,
      loading: false,
      error: !this.hasCredentials ? 'Baidu ASR credentials not configured' : null,
      ready: this.hasCredentials,
    }
  }

  getModelInfo(): string {
    return this.hasCredentials ? 'baidu_asr (cloud, REST API)' : 'not configured'
  }

  getInfo(): string {
    return this.getModelInfo()
  }

  async initialize(config?: { apiKey?: string; secretKey?: string }): Promise<void> {
    if (config?.apiKey) this.apiKey = config.apiKey
    if (config?.secretKey) this.secretKey = config.secretKey
    // BaiduEngine 不需要显式初始化，准备好凭据即可
  }

  async onUnload(): Promise<void> {
    this.apiKey = null
    this.secretKey = null
  }
}
