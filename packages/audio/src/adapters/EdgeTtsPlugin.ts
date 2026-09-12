/**
 * EdgeTtsPlugin — 云端 Edge TTS 插件适配器
 *
 * 将 Microsoft Edge TTS (edge-tts CLI) 封装为 TtsPlugin 接口，使其可通过
 * SpeechPluginRegistry 发现和加载。
 *
 * Edge TTS 是云端引擎，支持多音色、情感语调可控，
 * 需要网络连接，适合高质量合成场景。
 */

import { execFile } from 'child_process'
import { promises as fsp, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { TtsPlugin, TtsPluginStatus, TtsSynthesizeOptions, TtsSynthesizeResult, SpeechPluginManifest } from '../types'
import { log } from '@akemi-mio/core/logger/Logger'

/** 默认语音参数 */
const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'
const DEFAULT_RATE = '+10%'
const DEFAULT_PITCH = '+8Hz'
const SYNTHESIS_TIMEOUT_MS = 30000

export class EdgeTtsPlugin implements TtsPlugin {
  readonly manifest: SpeechPluginManifest = {
    name: 'edge_tts',
    version: '1.0.0',
    description: 'Microsoft Edge TTS cloud engine via edge-tts CLI (high-quality, multi-voice)',
    capability: 'tts',
    priority: 70,
    author: 'akemi-mio',
  }

  private available = false
  private checkPromise: Promise<boolean> | null = null

  // ── TtsPlugin 接口实现 ──

  async synthesize(text: string, options?: TtsSynthesizeOptions): Promise<TtsSynthesizeResult> {
    const outputFile = join(tmpdir(), `akemi-edge-tts-${Date.now()}.mp3`)
    const t0 = Date.now()

    const voice = options?.voice ?? DEFAULT_VOICE
    const rate = options?.rate ?? DEFAULT_RATE
    const pitch = options?.pitch ?? DEFAULT_PITCH
    const timeout = options?.timeoutMs ?? SYNTHESIS_TIMEOUT_MS

    try {
      await new Promise<void>((resolve, reject) => {
        const proc = execFile(
          'edge-tts',
          ['--voice', voice, '--text', text, '--write-media', outputFile, '--rate', rate, '--pitch', pitch],
          { timeout, windowsHide: true },
          (err) => {
            if (err) reject(err)
            else resolve()
          },
        )
      })

      // 验证文件是否生成
      try {
        await fsp.access(outputFile)
      } catch {
        return {
          audioFile: '',
          durationMs: Date.now() - t0,
          success: false,
          error: 'Edge TTS 合成后未生成音频文件',
        }
      }

      const durationMs = Date.now() - t0
      log('INFO', 'edge_tts_plugin_synthesis_done', {
        chars: text.length,
        voice,
        rate,
        pitch,
        durationMs,
      })

      return {
        audioFile: outputFile,
        durationMs,
        success: true,
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      log('WARN', 'edge_tts_plugin_synthesis_failed', {
        error: errorMsg,
        voice,
        chars: text.length,
      })

      // 清理可能残留的文件
      try {
        unlinkSync(outputFile)
      } catch {
        /* 忽略 */
      }

      return {
        audioFile: '',
        durationMs: Date.now() - t0,
        success: false,
        error: errorMsg,
      }
    }
  }

  getModelInfo(): string {
    return `edge_tts (cloud, Microsoft Edge TTS)`
  }

  getInfo(): string {
    return this.getModelInfo()
  }

  getStatus(): TtsPluginStatus {
    return {
      available: this.available,
      error: this.available ? null : 'Edge TTS 尚未就绪（初始化后自动检测 edge-tts CLI）',
    }
  }

  async initialize(): Promise<void> {
    if (this.checkPromise) {
      this.available = await this.checkPromise
      return
    }

    this.checkPromise = this.checkEdgeTtsAvailable()
    this.available = await this.checkPromise
  }

  async onUnload(): Promise<void> {
    this.available = false
    this.checkPromise = null
  }

  /**
   * 检测 edge-tts CLI 是否可用。
   */
  private async checkEdgeTtsAvailable(): Promise<boolean> {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile('edge-tts', ['--list-voices'], { timeout: 5000, windowsHide: true }, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
      log('INFO', 'edge_tts_plugin_available')
      return true
    } catch (err) {
      log('WARN', 'edge_tts_plugin_not_available', {
        error: String(err),
        note: 'edge-tts CLI not found. Install with: pip install edge-tts',
      })
      return false
    }
  }
}
