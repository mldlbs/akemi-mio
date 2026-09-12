/**
 * TtsCache — TTS 合成结果缓存
 *
 * ── 职责 ──
 *
 * 缓存 TTS（云端 + Piper）的合成结果到本地磁盘，避免相同文本+参数的重复合成。
 * 支持自动过期清理和 LRU 风格的淘汰策略。
 *
 * ── 缓存键格式 ──
 *
 *   hash = MD5(text + emotion_label) 的前 16 字符
 *   文件 = {cacheDir}/{hash}.mp3/.wav
 *   索引 = {cacheDir}/index.json （持久化的缓存元数据）
 *
 * ── 过期策略 ──
 *
 *   - 每项有 maxAgeMs（默认 24h）
 *   - 缓存打满（maxEntries）时淘汰最旧条目
 *   - 定期清理在初始化时和每次 get() 命中时惰性检查
 *
 * ── 集成点 ──
 *
 *   - TtsScheduler: 在路由前调用 checkCache()，命中则直接返回缓存
 *   - TtsService._synthesize(): 云端合成完成后调用 set() 写入缓存
 *   - PhrasePregenService: 预生成短语时直接调用 set()
 */

import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join, extname } from 'path'
import { log } from '@akemi-mio/core/logger/Logger'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 缓存条目元数据 */
export interface CacheEntryMeta {
  /** 缓存键（hash） */
  key: string
  /** 原始文本（用于调试） */
  text: string
  /** 情感标签 */
  emotionLabel: string
  /** 使用的引擎 */
  engine: 'cloud' | 'piper'
  /** 文件路径 */
  filePath: string
  /** 文件大小（字节） */
  fileSize: number
  /** 创建时间戳 */
  createdAt: number
  /** 最后访问时间戳 */
  lastAccessedAt: number
  /** 访问次数 */
  accessCount: number
  /** 过期时间戳（0 = 永不过期） */
  expiresAt: number
}

/** 缓存配置 */
export interface TtsCacheConfig {
  /** 缓存存储目录 */
  cacheDir: string
  /** 默认过期时间（毫秒），默认 24h */
  defaultMaxAgeMs: number
  /** 最大条目数，超出时淘汰最旧条目 */
  maxEntries: number
  /** 是否启用缓存 */
  enabled: boolean
  /** 清理间隔（毫秒），默认 1h */
  cleanupIntervalMs: number
}

/** 持久化的缓存索引 */
interface CacheIndex {
  version: number
  entries: Record<string, CacheEntryMeta>
}

const CACHE_VERSION = 1

/** 默认缓存配置 */
export const DEFAULT_TTS_CACHE_CONFIG: TtsCacheConfig = {
  cacheDir: 'tts_cache',
  defaultMaxAgeMs: 24 * 60 * 60 * 1000, // 24 小时
  maxEntries: 500,
  enabled: true,
  cleanupIntervalMs: 60 * 60 * 1000, // 1 小时
}

// ══════════════════════════════════════════
//  TtsCache
// ══════════════════════════════════════════

export class TtsCache {
  private config: TtsCacheConfig
  private index: CacheIndex = { version: CACHE_VERSION, entries: {} }
  private initialized = false
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(config?: Partial<TtsCacheConfig>) {
    this.config = { ...DEFAULT_TTS_CACHE_CONFIG, ...config }
  }

  // ══════════════════════════════════════════
  //  初始化
  // ══════════════════════════════════════════

  /**
   * 初始化缓存：加载索引、创建目录、启动定期清理。
   */
  initialize(cacheDir?: string): void {
    if (this.initialized) return
    if (cacheDir) {
      this.config.cacheDir = cacheDir
    }

    // 确保缓存目录存在
    if (!existsSync(this.config.cacheDir)) {
      mkdirSync(this.config.cacheDir, { recursive: true })
    }

    this.loadIndex()
    this.initialized = true

    // 启动定期清理
    if (this.config.cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => {
        this.runCleanup()
      }, this.config.cleanupIntervalMs)
      // 不让定时器阻止进程退出
      if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
        this.cleanupTimer.unref()
      }
    }

    log('INFO', 'tts_cache_initialized', {
      cacheDir: this.config.cacheDir,
      entries: Object.keys(this.index.entries).length,
      enabled: this.config.enabled,
      maxEntries: this.config.maxEntries,
      maxAgeMs: this.config.defaultMaxAgeMs,
    })
  }

  /**
   * 销毁缓存实例（清理定时器）。
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    this.persistIndex()
    this.initialized = false
    log('INFO', 'tts_cache_destroyed')
  }

  // ══════════════════════════════════════════
  //  核心 API
  // ══════════════════════════════════════════

  /**
   * 生成缓存键。
   * 格式：MD5(text + '|' + emotionLabel) 的前 16 字符
   */
  buildKey(text: string, emotionLabel: string): string {
    const hash = createHash('md5').update(`${text}|${emotionLabel}`).digest('hex')
    return hash.slice(0, 16)
  }

  /**
   * 检查缓存是否存在且有效。
   * @returns 缓存的音频文件路径，或 null（未命中/已过期）
   */
  checkCache(text: string, emotionLabel: string): string | null {
    if (!this.config.enabled) return null

    const key = this.buildKey(text, emotionLabel)
    const meta = this.index.entries[key]
    if (!meta) return null

    // 检查过期
    if (meta.expiresAt > 0 && Date.now() > meta.expiresAt) {
      this.removeEntry(key)
      return null
    }

    // 检查文件是否存在
    if (!existsSync(meta.filePath)) {
      this.removeEntry(key)
      return null
    }

    // 更新访问元数据
    meta.lastAccessedAt = Date.now()
    meta.accessCount++
    this.persistIndex()

    log('DEBUG', 'tts_cache_hit', {
      key,
      textSnippet: text.slice(0, 40),
      emotionLabel,
      engine: meta.engine,
      fileSize: meta.fileSize,
      accessCount: meta.accessCount,
    })

    return meta.filePath
  }

  /**
   * 写入缓存条目。
   * @param sourcePath 源音频文件路径（将被复制到缓存目录）
   * @param text 原始文本
   * @param emotionLabel 情感标签
   * @param engine 使用的引擎
   * @param fileExt 文件扩展名（.mp3 / .wav）
   * @param maxAgeMs 自定义过期时间（可选，默认使用配置值）
   * @returns 缓存键
   */
  setCache(
    sourcePath: string,
    text: string,
    emotionLabel: string,
    engine: 'cloud' | 'piper',
    fileExt?: string,
    maxAgeMs?: number,
  ): string | null {
    if (!this.config.enabled) return null

    const key = this.buildKey(text, emotionLabel)
    const ext = fileExt || extname(sourcePath) || '.mp3'
    const destPath = join(this.config.cacheDir, `${key}${ext}`)

    try {
      // 复制文件到缓存目录
      const srcContent = readFileSync(sourcePath)
      writeFileSync(destPath, srcContent)

      const fileSize = srcContent.length
      const now = Date.now()
      const expiresAt =
        maxAgeMs !== undefined && maxAgeMs > 0 ? now + maxAgeMs : this.config.defaultMaxAgeMs > 0 ? now + this.config.defaultMaxAgeMs : 0

      const meta: CacheEntryMeta = {
        key,
        text: text.slice(0, 100), // 只保存前 100 字符
        emotionLabel,
        engine,
        filePath: destPath,
        fileSize,
        createdAt: now,
        lastAccessedAt: now,
        accessCount: 0,
        expiresAt,
      }

      this.index.entries[key] = meta

      // 检查是否超出最大条目数
      this.enforceMaxEntries()

      this.persistIndex()

      log('DEBUG', 'tts_cache_set', {
        key,
        textSnippet: text.slice(0, 40),
        emotionLabel,
        engine,
        fileSize,
        expiresAt: expiresAt > 0 ? new Date(expiresAt).toISOString() : 'never',
      })

      return key
    } catch (err) {
      log('WARN', 'tts_cache_set_failed', {
        key,
        error: String(err),
        sourcePath,
      })
      return null
    }
  }

  /**
   * 获取缓存元数据（供调试/UI 使用）。
   */
  getMeta(key: string): CacheEntryMeta | null {
    return this.index.entries[key] || null
  }

  /**
   * 获取所有缓存条目的快照。
   */
  getAllEntries(): CacheEntryMeta[] {
    const now = Date.now()
    return Object.values(this.index.entries)
      .filter((e) => e.expiresAt === 0 || e.expiresAt > now)
      .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
  }

  /**
   * 获取缓存统计信息。
   */
  getStats(): { totalEntries: number; totalSizeBytes: number; expiredCount: number; enabled: boolean } {
    const now = Date.now()
    let totalSizeBytes = 0
    let expiredCount = 0

    for (const meta of Object.values(this.index.entries)) {
      totalSizeBytes += meta.fileSize
      if (meta.expiresAt > 0 && now > meta.expiresAt) {
        expiredCount++
      }
    }

    return {
      totalEntries: Object.keys(this.index.entries).length,
      totalSizeBytes,
      expiredCount,
      enabled: this.config.enabled,
    }
  }

  /**
   * 移除指定缓存条目。
   */
  removeEntry(key: string): boolean {
    const meta = this.index.entries[key]
    if (!meta) return false

    // 删除文件
    try {
      if (existsSync(meta.filePath)) {
        unlinkSync(meta.filePath)
      }
    } catch {
      // 忽略文件删除错误
    }

    delete this.index.entries[key]
    this.persistIndex()
    return true
  }

  /**
   * 清空所有缓存。
   */
  clear(): void {
    // 删除所有缓存文件
    for (const meta of Object.values(this.index.entries)) {
      try {
        if (existsSync(meta.filePath)) {
          unlinkSync(meta.filePath)
        }
      } catch {
        // 忽略
      }
    }
    this.index.entries = {}
    this.persistIndex()
    log('INFO', 'tts_cache_cleared')
  }

  /**
   * 启用/禁用缓存。
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled
    log('INFO', 'tts_cache_enabled_changed', { enabled })
  }

  /**
   * 获取配置。
   */
  getConfig(): TtsCacheConfig {
    return { ...this.config }
  }

  /**
   * 更新配置。
   */
  updateConfig(partial: Partial<TtsCacheConfig>): void {
    this.config = { ...this.config, ...partial }
    log('INFO', 'tts_cache_config_updated', { ...this.config })
  }

  // ══════════════════════════════════════════
  //  内部方法
  // ══════════════════════════════════════════

  /**
   * 从磁盘加载缓存索引。
   */
  private loadIndex(): void {
    const indexPath = join(this.config.cacheDir, 'index.json')
    if (!existsSync(indexPath)) {
      this.index = { version: CACHE_VERSION, entries: {} }
      return
    }

    try {
      const raw = readFileSync(indexPath, 'utf-8')
      const data = JSON.parse(raw) as CacheIndex

      if (data.version !== CACHE_VERSION) {
        log('WARN', 'tts_cache_index_version_mismatch', {
          expected: CACHE_VERSION,
          actual: data.version,
        })
        // 版本不匹配时重建索引
        this.index = { version: CACHE_VERSION, entries: {} }
        return
      }

      this.index = data

      // 验证并清理无效条目
      let cleaned = 0
      const now = Date.now()
      for (const [key, meta] of Object.entries(this.index.entries)) {
        if ((meta.expiresAt > 0 && now > meta.expiresAt) || !existsSync(meta.filePath)) {
          delete this.index.entries[key]
          cleaned++
        }
      }

      if (cleaned > 0) {
        log('INFO', 'tts_cache_index_cleaned', { cleaned })
        this.persistIndex()
      }
    } catch (err) {
      log('WARN', 'tts_cache_index_load_error', { error: String(err) })
      this.index = { version: CACHE_VERSION, entries: {} }
    }
  }

  /**
   * 持久化缓存索引到磁盘。
   */
  private persistIndex(): void {
    try {
      const indexPath = join(this.config.cacheDir, 'index.json')
      writeFileSync(indexPath, JSON.stringify(this.index, null, 2), 'utf-8')
    } catch (err) {
      log('ERROR', 'tts_cache_index_persist_error', { error: String(err) })
    }
  }

  /**
   * 确保缓存条目数不超过 maxEntries。
   * 超出时淘汰最久未访问的条目。
   */
  private enforceMaxEntries(): void {
    const entries = Object.values(this.index.entries)
    if (entries.length <= this.config.maxEntries) return

    // 按最后访问时间升序排列（最久未访问的在前）
    entries.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)

    const toRemove = entries.length - this.config.maxEntries
    for (let i = 0; i < toRemove; i++) {
      this.removeEntry(entries[i].key)
    }

    log('INFO', 'tts_cache_entries_evicted', { removed: toRemove, remaining: this.config.maxEntries })
  }

  /**
   * 运行清理：移除过期条目。
   */
  private runCleanup(): void {
    const now = Date.now()
    let removed = 0

    for (const [key, meta] of Object.entries(this.index.entries)) {
      if (meta.expiresAt > 0 && now > meta.expiresAt) {
        this.removeEntry(key)
        removed++
      }
    }

    if (removed > 0) {
      log('INFO', 'tts_cache_cleanup_completed', { removed, remaining: Object.keys(this.index.entries).length })
    }
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例，供 TtsScheduler、TtsService 使用 */
export const ttsCache = new TtsCache()
