/**
 * TtsEngineBuffer — 引擎切换缓冲区
 *
 * ── 职责 ──
 * 在活跃引擎正常工作时，后台预生成备用引擎的音频并缓存到缓冲区。
 * 当引擎切换发生时，直接从缓冲区取出预生成的音频播放，避免切换时的音频断音。
 *
 * ── 工作原理 ──
 * 1. 假设当前使用云端 TTS（edge-tts），缓冲区会在后台使用 Piper 预生成最近合成的文本
 * 2. 当 QoS 评估器决定切换到本地引擎时，缓冲区中的 Piper 音频已就绪，可直接播放
 * 3. 反之亦然：当前使用 Piper 时，缓冲区预生成 edge-tts 音频
 * 4. 缓冲区深度有限（默认 3 条），采用 FIFO 淘汰
 *
 * ── 设计约束 ──
 * - 后台预生成不能阻塞主合成路径
 * - 预生成失败不影响当前播放（静默降级）
 * - 缓冲区内存占用有限（音频文件在磁盘，仅缓存路径）
 *
 * ── 集成点 ──
 * - TtsService: 每次合成后向缓冲区报告，触发预生成
 * - TtsRouter: 切换引擎时从缓冲区读取预生成结果
 */

import { existsSync, copyFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { log } from '@akemi-mio/core/logger/Logger'
import type { TtsEngine } from './types'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 缓冲条目 — 一条预生成的音频 */
export interface BufferEntry {
  /** 原文文本 */
  text: string
  /** 预生成引擎 */
  engine: TtsEngine
  /** 音频文件路径 */
  audioFile: string
  /** 预生成时间戳 */
  createdAt: number
  /** 是否已就绪（文件已生成） */
  ready: boolean
  /** 是否已被消费 */
  consumed: boolean
}

/** 缓冲区快照（用于调试/UI） */
export interface BufferSnapshot {
  /** 对位引擎的缓冲条目数 */
  entries: Array<{
    text: string
    engine: TtsEngine
    ready: boolean
    consumed: boolean
    age: number
  }>
  /** 总缓冲深度 */
  depth: number
  /** 最大深度 */
  maxDepth: number
  /** 当前活跃引擎 */
  activeEngine: TtsEngine
  /** 对位引擎（预生成的目标） */
  standbyEngine: TtsEngine
}

/** 缓冲区配置 */
export interface EngineBufferConfig {
  /** 最大缓冲深度（每个引擎的缓冲条目数） */
  maxDepth: number
  /** 预生成输出目录 */
  outputDir: string
  /** 是否启用缓冲区 */
  enabled: boolean
}

/** 预生成回调 — 由 TtsService 提供，用于实际执行合成 */
export type PreSynthesizeCallback = (text: string, engine: TtsEngine) => Promise<string | null> // 返回音频文件路径或 null

// ══════════════════════════════════════════
//  默认配置
// ══════════════════════════════════════════

const DEFAULT_BUFFER_DIR = join(tmpdir(), 'akemi-mio-tts-buffer')

export const DEFAULT_ENGINE_BUFFER_CONFIG: EngineBufferConfig = {
  maxDepth: 3,
  outputDir: DEFAULT_BUFFER_DIR,
  enabled: true,
}

// ══════════════════════════════════════════
//  TtsEngineBuffer
// ══════════════════════════════════════════

export class TtsEngineBuffer {
  private config: EngineBufferConfig
  private entries: BufferEntry[] = []
  private activeEngine: TtsEngine = 'cloud'
  private preSynthCallback: PreSynthesizeCallback | null = null

  /** 预生成去重池：正在预生成的文本集合（防重复） */
  private pendingTexts = new Set<string>()

  constructor(config?: Partial<EngineBufferConfig>) {
    this.config = { ...DEFAULT_ENGINE_BUFFER_CONFIG, ...config }

    // 确保输出目录存在
    try {
      const { mkdirSync } = require('fs')
      if (!existsSync(this.config.outputDir)) {
        mkdirSync(this.config.outputDir, { recursive: true })
      }
    } catch {
      // 静默失败
    }
  }

  // ══════════════════════════════════════════
  //  配置
  // ══════════════════════════════════════════

  /** 获取当前配置 */
  getConfig(): EngineBufferConfig {
    return { ...this.config }
  }

  /** 更新配置 */
  updateConfig(partial: Partial<EngineBufferConfig>): void {
    this.config = { ...this.config, ...partial }
    log('INFO', 'tts_buffer_config_updated', { ...this.config })
  }

  /** 启用/禁用缓冲区 */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled
    if (!enabled) {
      this.clear()
    }
    log('INFO', 'tts_buffer_enabled_changed', { enabled })
  }

  /** 获取活跃引擎 */
  getActiveEngine(): TtsEngine {
    return this.activeEngine
  }

  // ══════════════════════════════════════════
  //  回调注册
  // ══════════════════════════════════════════

  /**
   * 注册预生成回调函数。
   * 当缓冲区需要预生成备用引擎的音频时，调用此回调执行实际合成。
   */
  setPreSynthesizeCallback(cb: PreSynthesizeCallback): void {
    this.preSynthCallback = cb
  }

  // ══════════════════════════════════════════
  //  核心操作
  // ══════════════════════════════════════════

  /**
   * 设置当前活跃引擎。
   * 缓冲区会根据活跃引擎确定对位引擎（预生成目标）。
   */
  setActiveEngine(engine: TtsEngine): void {
    const prev = this.activeEngine
    this.activeEngine = engine

    if (prev !== engine) {
      log('INFO', 'tts_buffer_active_engine_changed', {
        from: prev,
        to: engine,
      })

      // 引擎切换后，标记所有对位引擎的条目为未消费（可被新引擎消费）
      const standby = this.getStandbyEngine()
      for (const entry of this.entries) {
        if (entry.engine === standby && !entry.ready) {
          // 清理未就绪的对位条目（已过时）
          this.removeEntry(entry)
        }
      }
    }
  }

  /**
   * 报告一次合成完成，触发备选引擎的预生成。
   * 应在每次成功合成后调用，让缓冲区有机会预生成备用引擎版本。
   *
   * @param text 已合成的文本
   * @param engine 使用的引擎
   */
  onSynthesisDone(text: string, engine: TtsEngine): void {
    if (!this.config.enabled) return
    if (!this.preSynthCallback) return

    this.setActiveEngine(engine)
    const standby = this.getStandbyEngine()

    // 检查是否已在缓冲中
    if (this.isAlreadyBuffered(text, standby)) {
      return
    }

    // 检查是否正在预生成
    const dedupKey = `${standby}:${text}`
    if (this.pendingTexts.has(dedupKey)) {
      return
    }

    // 检查缓冲深度
    const standbyEntries = this.entries.filter((e) => e.engine === standby && !e.consumed)
    if (standbyEntries.length >= this.config.maxDepth) {
      // FIFO 淘汰最旧条目
      const oldest = standbyEntries.sort((a, b) => a.createdAt - b.createdAt)[0]
      if (oldest) {
        this.removeEntry(oldest)
      }
    }

    // 后台触发预生成
    this.pendingTexts.add(dedupKey)
    this.preSynthesizeInBackground(text, standby, dedupKey)
  }

  /**
   * 尝试从缓冲区取出预生成的音频。
   * 当引擎切换时调用，返回已预生成的音频文件路径（如果命中）。
   *
   * @param text 需要合成的文本
   * @param targetEngine 目标引擎（切换后的引擎）
   * @returns 预生成的音频文件路径，或 null（未命中缓冲）
   */
  consume(text: string, targetEngine: TtsEngine): string | null {
    if (!this.config.enabled) return null

    // 查找匹配的缓冲条目
    const idx = this.entries.findIndex((e) => e.engine === targetEngine && e.text === text && e.ready && !e.consumed)

    if (idx < 0) return null

    const entry = this.entries[idx]

    // 验证文件存在
    if (!existsSync(entry.audioFile)) {
      this.entries.splice(idx, 1)
      return null
    }

    entry.consumed = true

    log('INFO', 'tts_buffer_consumed', {
      engine: targetEngine,
      textSnippet: text.slice(0, 40),
    })

    return entry.audioFile
  }

  /**
   * 获取对位引擎的缓冲命中率数据。
   */
  getStats(): {
    totalEntries: number
    readyCount: number
    consumedCount: number
    pendingCount: number
    activeEngine: TtsEngine
    standbyEngine: TtsEngine
  } {
    const total = this.entries.length
    const ready = this.entries.filter((e) => e.ready).length
    const consumed = this.entries.filter((e) => e.consumed).length

    return {
      totalEntries: total,
      readyCount: ready,
      consumedCount: consumed,
      pendingCount: this.pendingTexts.size,
      activeEngine: this.activeEngine,
      standbyEngine: this.getStandbyEngine(),
    }
  }

  /**
   * 获取缓冲区快照（供调试/UI）。
   */
  getSnapshot(): BufferSnapshot {
    return {
      entries: this.entries.map((e) => ({
        text: e.text.slice(0, 40),
        engine: e.engine,
        ready: e.ready,
        consumed: e.consumed,
        age: Date.now() - e.createdAt,
      })),
      depth: this.entries.filter((e) => !e.consumed).length,
      maxDepth: this.config.maxDepth * 2,
      activeEngine: this.activeEngine,
      standbyEngine: this.getStandbyEngine(),
    }
  }

  /**
   * 清空缓冲区。
   */
  clear(): void {
    for (const entry of this.entries) {
      this.removeFile(entry.audioFile)
    }
    this.entries = []
    this.pendingTexts.clear()
    log('INFO', 'tts_buffer_cleared')
  }

  // ══════════════════════════════════════════
  //  内部方法
  // ══════════════════════════════════════════

  /**
   * 获取对位引擎（需要预生成的目标）。
   */
  private getStandbyEngine(): TtsEngine {
    return this.activeEngine === 'cloud' ? 'local' : 'cloud'
  }

  /**
   * 检查文本是否已在缓冲区中（对位引擎）。
   */
  private isAlreadyBuffered(text: string, engine: TtsEngine): boolean {
    return this.entries.some((e) => e.engine === engine && e.text === text && !e.consumed)
  }

  /**
   * 后台预生成备选引擎的音频。
   */
  private async preSynthesizeInBackground(text: string, engine: TtsEngine, dedupKey: string): Promise<void> {
    try {
      const audioFile = await this.preSynthCallback!(text, engine)

      if (audioFile) {
        // 复制到缓冲区目录
        const ext = audioFile.endsWith('.wav') ? '.wav' : '.mp3'
        const bufFile = join(this.config.outputDir, `buf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)

        try {
          copyFileSync(audioFile, bufFile)
        } catch {
          // 复制失败，直接使用原文件路径
        }

        this.entries.push({
          text,
          engine,
          audioFile: existsSync(bufFile) ? bufFile : audioFile,
          createdAt: Date.now(),
          ready: true,
          consumed: false,
        })

        log('INFO', 'tts_buffer_pre_generated', {
          engine,
          textSnippet: text.slice(0, 40),
        })
      }
    } catch (err) {
      // 后台预生成失败静默处理
      log('DEBUG', 'tts_buffer_pre_generation_failed', {
        engine,
        error: String(err).slice(0, 100),
      })
    } finally {
      this.pendingTexts.delete(dedupKey)
    }
  }

  /**
   * 移除缓冲条目并清理磁盘文件。
   */
  private removeEntry(entry: BufferEntry): void {
    this.removeFile(entry.audioFile)
    const idx = this.entries.indexOf(entry)
    if (idx >= 0) {
      this.entries.splice(idx, 1)
    }
  }

  /**
   * 安全删除文件。
   */
  private removeFile(filePath: string): void {
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath)
      }
    } catch {
      // 静默
    }
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例，供 TtsService 使用 */
export const ttsEngineBuffer = new TtsEngineBuffer()
