/**
 * WhisperCpuAsrPlugin — CPU Whisper ASR 插件适配器
 *
 * 将现有的 WhisperEngine（CPU / ONNX）封装为 AsrPlugin 接口，使其可通过
 * SpeechPluginRegistry 发现和加载。
 *
 * 设计原则：
 * - 零侵入：不修改 WhisperEngine 的现有接口
 * - 全委托：所有方法直接转发到引擎实例
 * - 延迟初始化：引擎在首次调用 initialize() 时创建，避免启动时阻塞
 */

import type { AsrPlugin, AsrPluginStatus, AsrTranscribeOptions, AsrTranscribeResult, SpeechPluginManifest } from '../types'
import type { ProgressCallback } from '../../asr/types'
import { WhisperEngine } from '../../asr/WhisperEngine'
import { createRequestId } from '../../logger/Logger'

/** 默认 CPU 模型名（tiny = 最快） */
const DEFAULT_MODEL = 'tiny'

export class WhisperCpuAsrPlugin implements AsrPlugin {
  readonly manifest: SpeechPluginManifest = {
    name: 'whisper_cpu',
    version: '1.0.0',
    description: 'CPU-based Whisper ASR via @xenova/transformers (ONNX, fallback engine)',
    capability: 'asr',
    priority: 50,
    author: 'akemi-mio',
  }

  private engine: WhisperEngine | null = null
  private engineInitPromise: Promise<void> | null = null
  private config: { model?: string; onProgress?: ProgressCallback } = {}

  // ── AsrPlugin 接口实现 ──

  async transcribe(audio: Float32Array, options?: AsrTranscribeOptions): Promise<AsrTranscribeResult> {
    if (!this.engine) {
      throw new Error('CPU Whisper plugin not initialized. Call initialize() first.')
    }

    const requestId = options?.requestId ?? createRequestId()
    const result = await this.engine.transcribe(
      audio,
      options?.timeoutMs ?? 20000,
      requestId,
    )
    return {
      text: result.text,
      duration: result.duration,
      raw: result.raw,
      hits: result.hits,
      requestId: result.request_id,
    }
  }

  getStatus(): AsrPluginStatus {
    if (!this.engine) {
      return { loaded: false, loading: false, error: null, ready: false }
    }
    const s = this.engine.getStatus()
    return { ...s, ready: s.loaded }
  }

  getModelInfo(): string {
    if (!this.engine) return 'not loaded'
    return this.engine.getModelInfo()
  }

  getInfo(): string {
    return this.getModelInfo()
  }

  async initialize(config?: { model?: string; onProgress?: ProgressCallback }): Promise<void> {
    if (config) {
      this.config = { ...this.config, ...config }
    }
    if (this.engine) return
    if (this.engineInitPromise) return this.engineInitPromise

    this.engineInitPromise = (async () => {
      const engine = new WhisperEngine()
      const model = this.config.model ?? DEFAULT_MODEL
      await engine.initialize(model, this.config.onProgress)
      this.engine = engine
    })()

    return this.engineInitPromise
  }

  async onUnload(): Promise<void> {
    this.engine = null
    this.engineInitPromise = null
  }

  setInitialPrompt(prompt: string | null): void {
    if (this.engine && prompt !== null) {
      this.engine.setInitialPrompt(prompt)
    } else if (this.engine) {
      this.engine.resetInitialPrompt()
    }
  }

  setHotwords(_hotwords: string[] | null): void {
    // WhisperEngine 通过 initialPrompt 间接使用热词，不由本方法直接管理
    // 热词上下文通过 setInitialPrompt 注入
  }

  resetContextOverrides(): void {
    if (this.engine) {
      this.engine.resetInitialPrompt()
    }
  }
}
