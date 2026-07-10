/**
 * WhisperGpuAsrPlugin — GPU Whisper ASR 插件适配器
 *
 * 将现有的 WhisperGpuEngine 封装为 AsrPlugin 接口，使其可通过
 * SpeechPluginRegistry 发现和加载。
 *
 * 设计原则：
 * - 零侵入：不修改 WhisperGpuEngine 的现有接口
 * - 全委托：所有方法直接转发到引擎实例
 * - 渐进式：引擎可独立初始化，不阻塞插件注册
 */

import type { AsrPlugin, AsrPluginStatus, AsrTranscribeOptions, AsrTranscribeResult, SpeechPluginManifest } from '../types'
import { WhisperGpuEngine } from '../../asr/WhisperGpuEngine'

/** 默认 GPU 模型名 */
const DEFAULT_MODEL = 'small'

export class WhisperGpuAsrPlugin implements AsrPlugin {
  readonly manifest: SpeechPluginManifest = {
    name: 'whisper_gpu',
    version: '1.0.0',
    description: 'GPU-accelerated Whisper ASR via @kutalia/whisper-node-addon (Vulkan, RTX 3060)',
    capability: 'asr',
    priority: 100,
    author: 'akemi-mio',
  }

  private engine: WhisperGpuEngine
  private config: { model?: string } = {}

  constructor(engine?: WhisperGpuEngine) {
    this.engine = engine ?? new WhisperGpuEngine()
  }

  // ── AsrPlugin 接口实现 ──

  async transcribe(audio: Float32Array, options?: AsrTranscribeOptions): Promise<AsrTranscribeResult> {
    const result = await this.engine.transcribe(audio, options?.timeoutMs ?? 15000)
    return {
      text: result.text,
      duration: result.duration,
      raw: result.raw,
      hits: result.hits,
    }
  }

  getStatus(): AsrPluginStatus {
    const s = this.engine.getStatus()
    return { ...s, ready: s.loaded }
  }

  getModelInfo(): string {
    return this.engine.getModelInfo()
  }

  getInfo(): string {
    return this.getModelInfo()
  }

  async initialize(config?: { model?: string }): Promise<void> {
    if (config) {
      this.config = { ...this.config, ...config }
    }
    const model = this.config.model ?? DEFAULT_MODEL
    await this.engine.initialize(model)
  }

  async onUnload(): Promise<void> {
    // WhisperGpuEngine 没有显式的资源释放方法，标记卸载完成
  }

  setInitialPrompt(prompt: string | null): void {
    this.engine.setInitialPrompt(prompt)
  }

  setHotwords(hotwords: string[] | null): void {
    this.engine.setHotwords(hotwords)
  }

  resetContextOverrides(): void {
    this.engine.resetContextOverrides()
  }
}
