/**
 * PiperTtsPlugin — 本地 Piper TTS 插件适配器
 *
 * 将现有的 PiperOrchestrator 封装为 TtsPlugin 接口，使其可通过
 * SpeechPluginRegistry 发现和加载。
 *
 * Piper TTS 是本地引擎，使用 ONNX 模型进行语音合成，
 * 不需要网络连接，适合低延迟场景。
 */

import type { TtsPlugin, TtsPluginStatus, TtsSynthesizeOptions, TtsSynthesizeResult, SpeechPluginManifest } from '../types'
import { piperOrchestrator, type PiperTaskTag } from '../../tts/PiperOrchestrator'

export class PiperTtsPlugin implements TtsPlugin {
  readonly manifest: SpeechPluginManifest = {
    name: 'piper_tts',
    version: '1.0.0',
    description: 'Local Piper TTS engine via Python subprocess (offline, low-latency)',
    capability: 'tts',
    priority: 80,
    author: 'akemi-mio',
  }

  // ── TtsPlugin 接口实现 ──

  async synthesize(text: string, options?: TtsSynthesizeOptions): Promise<TtsSynthesizeResult> {
    // 映射通用 TTS 参数到 Piper 请求参数
    const taskTag = this.mapToTaskTag(options?.voice)

    const request = {
      text,
      taskTag,
      speed: options?.speedFactor,
      pitch: options?.pitchFactor,
      requestId: `piper_plugin_${Date.now()}`,
    }

    const result = await piperOrchestrator.synthesize(request)

    return {
      audioFile: result.audioFile ?? '',
      durationMs: result.durationMs,
      success: result.success,
      error: result.error,
      fallbackUsed: result.fallbackUsed,
    }
  }

  getStatus(): TtsPluginStatus {
    // PiperOrchestrator 始终可用（没有初始化要求）
    return {
      available: true,
      error: null,
    }
  }

  async initialize(): Promise<void> {
    // PiperOrchestrator 不需要额外初始化
  }

  async onUnload(): Promise<void> {
    piperOrchestrator.stop()
  }

  /**
   * 将通用 voice 名映射为 Piper 任务标签。
   */
  private mapToTaskTag(voice?: string): PiperTaskTag | undefined {
    if (!voice) return undefined

    const lower = voice.toLowerCase()
    if (lower.includes('story') || lower.includes('ling_ling') || lower.includes('lingling')) {
      return 'story'
    }
    if (lower.includes('alert') || lower.includes('mati') || lower.includes('tx_mati')) {
      return 'alert'
    }
    return 'chat'
  }
}
