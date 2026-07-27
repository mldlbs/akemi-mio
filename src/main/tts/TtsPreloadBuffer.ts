/**
 * TtsPreloadBuffer — TTS 引擎切换预加载缓冲
 *
 * 在引擎切换时维持语音输出的连续性，避免断音。
 *
 * 工作原理：
 *   1. 记录当前使用的主引擎
 *   2. 当前文本长度超过阈值时，预先用备选引擎合成同一文本
 *   3. 当路由决策发生引擎切换时，先播放预加载的缓冲音频
 *   4. 在新引擎完成"热身"后切换到正常流程
 *
 * 预加载策略：
 *   - 短文本（< preloadThresholdChars）不预加载（切换代价小）
 *   - QoS 评分处于边界区域（0.3–0.5）时预加载
 *   - 用户手动指定引擎时不预加载
 *   - 缓冲条目有过期时间（entryTtlMs），过期后自动清除
 *
 * 设计特点：
 *   - 无阻塞：预加载异步执行，不影响当前合成流程
 *   - 容错：预加载失败不阻塞，降级到无缓冲切换
 *   - 轻量：最大缓冲条目数可控（maxEntries）
 */

import { promises as fsp, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { log } from '../logger/Logger'
import { shallowMerge } from '../core/utils/configMerge'
import type { EmotionTtsParams, PreloadBufferEntry, PreloadBufferConfig, PreloadBufferState } from './types'
import { DEFAULT_PRELOAD_BUFFER_CONFIG } from './types'

/** 合成回调类型 — TtsService 提供的合成能力 */
export type SynthesizeFn = (text: string, outputFile: string, engine: 'cloud' | 'local') => Promise<void>

export class TtsPreloadBuffer {
  private config: PreloadBufferConfig

  /** 缓冲条目（先进先出） */
  private buffer: PreloadBufferEntry[] = []

  /** 当前使用的主引擎 */
  private currentEngine: 'cloud' | 'local' = 'cloud'

  /** 累计预加载命中次数 */
  private totalPreloadHits = 0

  /** 累计切换次数 */
  private totalSwitches = 0

  /** 最近一次切换记录 */
  private lastSwitch: PreloadBufferState['lastSwitch'] = null

  /** TTS 合成能力注入（由 TtsService 提供） */
  private synthesizeFn: SynthesizeFn | null = null

  /** 清理定时器 */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(config?: Partial<PreloadBufferConfig>) {
    this.config = shallowMerge(DEFAULT_PRELOAD_BUFFER_CONFIG, config)

    // 启动定期清理过期条目
    this.cleanupTimer = setInterval(() => this.cleanup(), 30000)
    if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      this.cleanupTimer.unref()
    }
  }

  /**
   * 注入合成能力（由 TtsService 在初始化时调用）。
   */
  setSynthesizeFn(fn: SynthesizeFn): void {
    this.synthesizeFn = fn
  }

  /**
   * 更新配置。
   */
  updateConfig(partial: Partial<PreloadBufferConfig>): void {
    this.config = { ...this.config, ...partial }
    log('INFO', 'preload_buffer_config_updated', { ...this.config })
  }

  /**
   * 获取配置。
   */
  getConfig(): PreloadBufferConfig {
    return { ...this.config }
  }

  /**
   * 通知预加载缓冲当前使用的引擎。
   * 每次合成前调用，让缓冲知道当前引擎。
   */
  setCurrentEngine(engine: 'cloud' | 'local'): void {
    this.currentEngine = engine
  }

  /**
   * 检查是否有可用的预加载缓冲条目。
   *
   * 当路由决策切换到另一个引擎时，TtsService 先调用此方法
   * 查看是否有预先合成的音频可以直接使用。
   *
   * @param text 要合成的文本
   * @param emotionParams 当前情感参数（用于匹配）
   * @returns 匹配的缓冲条目，或 null
   */
  async getBuffered(text: string, emotionParams: EmotionTtsParams): Promise<string | null> {
    if (!this.config.enabled) return null
    if (this.buffer.length === 0) return null

    const targetEngine = this.currentEngine === 'cloud' ? 'local' : 'cloud'

    // 查找匹配的条目（相同文本 + 相同引擎）
    const idx = this.buffer.findIndex(
      (entry) => entry.text === text && entry.engine === targetEngine && entry.verified,
    )

    if (idx < 0) return null

    const entry = this.buffer[idx]
    this.buffer.splice(idx, 1) // 取出后移除

    // 验证文件仍然存在
    try {
      await fsp.access(entry.audioFile)
    } catch {
      log('WARN', 'preload_buffer_file_missing', { text: text.slice(0, 40) })
      return null
    }

    this.totalPreloadHits++
    log('INFO', 'preload_buffer_hit', {
      engine: targetEngine,
      textLen: text.length,
      remaining: this.buffer.length,
      totalHits: this.totalPreloadHits,
    })

    return entry.audioFile
  }

  /**
   * 尝试用备选引擎预加载当前文本。
   *
   * 调用时机：在 TtsService 用主引擎合成完成后（不阻塞主流程），
   * 如果文本足够长且条件合适，用备选引擎异步预合成同样文本。
   *
   * @param text 已合成的文本
   * @param engine 当前使用的引擎（备选引擎 = 另一个）
   * @param emotionParams 当前情感参数
   */
  tryPreload(text: string, engine: 'cloud' | 'local', emotionParams: EmotionTtsParams): void {
    if (!this.config.enabled) return
    if (!this.synthesizeFn) return
    if (text.length < this.config.preloadThresholdChars) return
    if (this.buffer.length >= this.config.maxEntries) return

    const targetEngine = engine === 'cloud' ? 'local' : 'cloud'

    // 检查是否已有相同文本的预加载
    const existing = this.buffer.some(
      (entry) => entry.text === text && entry.engine === targetEngine,
    )
    if (existing) return

    // 异步预加载（不阻塞）
    this.synthesizeWithTarget(text, targetEngine, emotionParams).catch((err) => {
      log('WARN', 'preload_buffer_synthesis_failed', {
        engine: targetEngine,
        error: String(err).slice(0, 100),
      })
    })
  }

  /**
   * 记录引擎切换事件。
   *
   * 在 TtsService 实际切换引擎时调用。
   * 用于统计和调试。
   */
  recordSwitch(fromEngine: 'cloud' | 'local', toEngine: 'cloud' | 'local', usedPreloaded: boolean): void {
    this.totalSwitches++
    this.lastSwitch = {
      fromEngine,
      toEngine,
      usedPreloaded,
      timestamp: Date.now(),
    }
    log('INFO', 'preload_buffer_engine_switch', {
      from: fromEngine,
      to: toEngine,
      usedPreloaded,
      totalSwitches: this.totalSwitches,
    })
  }

  /**
   * 获取当前缓冲状态（调试/UI 展示用）。
   */
  getState(): PreloadBufferState {
    return {
      entryCount: this.buffer.length,
      enabled: this.config.enabled,
      lastSwitch: this.lastSwitch,
      totalPreloadHits: this.totalPreloadHits,
      totalSwitches: this.totalSwitches,
    }
  }

  /**
   * 清理过期条目。
   */
  cleanup(): void {
    const now = Date.now()
    const before = this.buffer.length

    // 过滤过期条目，同时清理磁盘文件
    const keep: PreloadBufferEntry[] = []
    for (const entry of this.buffer) {
      if (now - entry.synthesizedAt > this.config.entryTtlMs) {
        this.deleteFile(entry.audioFile)
      } else {
        keep.push(entry)
      }
    }

    this.buffer = keep

    if (keep.length !== before) {
      log('DEBUG', 'preload_buffer_cleanup', { removed: before - keep.length, remaining: keep.length })
    }
  }

  /**
   * 清空所有缓冲条目。
   */
  clear(): void {
    for (const entry of this.buffer) {
      this.deleteFile(entry.audioFile)
    }
    this.buffer = []
    log('INFO', 'preload_buffer_cleared')
  }

  /**
   * 销毁清理定时器。
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    this.clear()
  }

  // ── 私有 ──

  /**
   * 用目标引擎异步合成文本并加入缓冲。
   */
  private async synthesizeWithTarget(
    text: string,
    engine: 'cloud' | 'local',
    emotionParams: EmotionTtsParams,
  ): Promise<void> {
    if (!this.synthesizeFn) return

    const tmpFile = join(tmpdir(), `akemi-preload-${engine}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp3`)
    const t0 = Date.now()

    try {
      await this.synthesizeFn(text, tmpFile, engine)

      // 验证文件是否成功生成
      const stat = await fsp.stat(tmpFile)
      if (stat.size === 0) {
        this.deleteFile(tmpFile)
        return
      }

      const entry: PreloadBufferEntry = {
        text,
        engine,
        audioFile: tmpFile,
        synthesizedAt: Date.now(),
        emotionParams: { ...emotionParams },
        verified: true,
      }

      this.buffer.push(entry)

      // 超出最大条目数时丢弃最旧的
      if (this.buffer.length > this.config.maxEntries) {
        const removed = this.buffer.shift()
        if (removed) this.deleteFile(removed.audioFile)
      }

      log('INFO', 'preload_buffer_entry_added', {
        engine,
        textLen: text.length,
        durationMs: Date.now() - t0,
        bufferSize: this.buffer.length,
      })
    } catch (err) {
      // 预加载失败不抛异常
      this.deleteFile(tmpFile)
      throw err
    }
  }

  /**
   * 安全删除临时文件。
   */
  private deleteFile(filePath: string): void {
    try {
      unlinkSync(filePath)
    } catch {
      // 文件可能已被清理
    }
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例，供 TtsService 使用 */
export const ttsPreloadBuffer = new TtsPreloadBuffer()
