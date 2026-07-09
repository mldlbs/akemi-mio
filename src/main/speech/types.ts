/**
 * Speech Plugin Contracts — ASR / TTS 插件契约定义
 *
 * 设计原则：
 * 1. 插件 API 的稳定性直接影响生态建设，变更前请评估兼容性。
 * 2. 每个插件实现单一契约（AsrPlugin | TtsPlugin），职责边界清晰。
 * 3. 插件无需关心 SpeechPluginRegistry 的内部调度，只需聚焦于接口实现。
 *
 * 对照现有的 EvolutionPlugin 模式，本模块提供了类似的 ServiceLoader 架构，
 * 但独立于 evolution 系统，专用于语音处理领域。
 */

import type { AsrResult, ProgressCallback } from '../asr/types'

// ══════════════════════════════════════════
//  插件元数据
// ══════════════════════════════════════════

/** 插件能力类型 — ASR（语音识别）或 TTS（语音合成） */
export type SpeechCapability = 'asr' | 'tts'

/** 插件元数据 */
export interface SpeechPluginManifest {
  /** 唯一标识名，例如 'whisper_gpu', 'baidu_asr', 'piper_tts', 'edge_tts' */
  name: string
  /** 语义版本 */
  version: string
  /** 人类可读描述 */
  description: string
  /** 插件能力类型 */
  capability: SpeechCapability
  /** 作者（可选） */
  author?: string
  /** 优先级（数值越大越优先，默认 0） */
  priority?: number
}

// ══════════════════════════════════════════
//  ASR 插件契约
// ══════════════════════════════════════════

/** ASR 引擎状态 */
export interface AsrPluginStatus {
  loaded: boolean
  loading: boolean
  error: string | null
}

/** ASR 转录选项 */
export interface AsrTranscribeOptions {
  /** 超时时间（毫秒） */
  timeoutMs?: number
  /** 请求唯一标识 */
  requestId?: string
  /** 进度回调 */
  onProgress?: ProgressCallback
  /** 初始提示词 */
  initialPrompt?: string
  /** 热词列表 */
  hotwords?: string[]
}

/** ASR 转录结果 */
export interface AsrTranscribeResult {
  text: string
  duration: number
  raw?: string
  hits?: Array<{ hotword: string; count: number }>
  requestId?: string
}

/**
 * ASR 插件接口。
 *
 * 实现此接口的类将成为 SpeechPluginRegistry 可发现的 ASR 引擎。
 * 插件只需关注音频 → 文本的转换逻辑，不需要了解 AsrService 的调度策略、
 * 降级回退或上下文注入细节。
 */
export interface AsrPlugin {
  /** 插件元数据 */
  readonly manifest: SpeechPluginManifest

  /**
   * 对音频数据进行语音识别。
   * @param audio Float32Array PCM 数据（16kHz, mono）
   * @param options 可选配置
   * @returns 转录结果
   */
  transcribe(audio: Float32Array, options?: AsrTranscribeOptions): Promise<AsrTranscribeResult>

  /**
   * 获取当前引擎状态。
   */
  getStatus(): AsrPluginStatus

  /**
   * 获取引擎信息（供调试/UI 展示）。
   */
  getModelInfo(): string

  // ── 生命周期钩子（可选） ──

  /**
   * 初始化引擎（模型加载等）。
   * 在注册后由 SpeechPluginRegistry.loadAll() 调用。
   */
  initialize?(config?: unknown): Promise<void>

  /**
   * 引擎卸载前的清理。
   */
  onUnload?(): Promise<void>

  /**
   * 设置动态初始提示词（可选，用于上下文注入）。
   */
  setInitialPrompt?(prompt: string | null): void

  /**
   * 设置动态热词列表（可选，用于上下文注入）。
   */
  setHotwords?(hotwords: string[] | null): void

  /**
   * 清除所有动态覆盖（可选）。
   */
  resetContextOverrides?(): void
}

// ══════════════════════════════════════════
//  TTS 插件契约
// ══════════════════════════════════════════

/** TTS 引擎状态 */
export interface TtsPluginStatus {
  available: boolean
  error: string | null
}

/** TTS 合成选项 */
export interface TtsSynthesizeOptions {
  /** 语音角色名 */
  voice?: string
  /** 语速，如 '+10%' */
  rate?: string
  /** 音调偏移，如 '+8Hz' */
  pitch?: string
  /** 音量 0.0–1.0 */
  volume?: number
  /** 语速因子（用于本地引擎） */
  speedFactor?: number
  /** 音调因子（用于本地引擎） */
  pitchFactor?: number
  /** 超时时间（毫秒） */
  timeoutMs?: number
}

/** TTS 合成结果 */
export interface TtsSynthesizeResult {
  /** 合成的音频文件路径 */
  audioFile: string
  /** 合成耗时（毫秒） */
  durationMs: number
  /** 是否成功 */
  success: boolean
  /** 错误信息（当 success = false 时） */
  error?: string
  /** 是否使用了回退模型 */
  fallbackUsed?: boolean
}

/**
 * TTS 插件接口。
 *
 * 实现此接口的类将成为 SpeechPluginRegistry 可发现的 TTS 引擎。
 * 插件只需关注文本 → 音频的转换逻辑，不需要了解 TtsService 的路由策略、
 * 队列管理或情感参数混合细节。
 */
export interface TtsPlugin {
  /** 插件元数据 */
  readonly manifest: SpeechPluginManifest

  /**
   * 将文本合成为音频文件。
   * @param text 要合成的文本
   * @param options 可选配置
   * @returns 合成结果
   */
  synthesize(text: string, options?: TtsSynthesizeOptions): Promise<TtsSynthesizeResult>

  /**
   * 获取当前引擎状态。
   */
  getStatus(): TtsPluginStatus

  // ── 生命周期钩子（可选） ──

  /**
   * 初始化引擎。
   * 在注册后由 SpeechPluginRegistry.loadAll() 调用。
   */
  initialize?(config?: unknown): Promise<void>

  /**
   * 引擎卸载前的清理。
   */
  onUnload?(): Promise<void>
}
