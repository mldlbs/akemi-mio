import { join } from 'path'
import { promises as fsp, existsSync, mkdirSync } from 'fs'
import { log } from '../logger/Logger'
import type { MemoryService } from './MemoryService'
import type { VoiceBookmark as VoiceBookmarkType, MemoryEntry } from './types'
import { WORKSPACE } from '../config'
import { cleanTTS } from '../tts/TtsService'

// Re-export the bookmark type for convenience
export type { VoiceBookmarkType }
export type { VoiceBookmark } from './types'

/** 默认最近对话轮数 */
const DEFAULT_CONTEXT_ROUNDS = 5
/** 语音文件最大大小（字节，10MB） */
const MAX_AUDIO_FILE_SIZE = 10 * 1024 * 1024
/** 摘要最大长度 */
const MAX_SUMMARY_LENGTH = 200
/** 语音文本最大长度 */
const MAX_AUDIO_TEXT_LENGTH = 500

/**
 * 语音记忆书签服务
 *
 * 功能：
 * 1. 将最近 N 轮对话及回复文本存储为记忆条目（type='voice_bookmark'）
 * 2. 通过 PiperTTS（由外部传入合成函数）异步生成短语音文件并关联
 * 3. 支持查询、搜索、删除和播放控制
 *
 * 存储模式：
 * - 记忆条目存在 MemoryService 的 memories 表中，type='voice_bookmark'
 * - structuredData 存储 VoiceBookmark 的全部元数据（含对话上下文）
 * - 语音文件存储在 {WORKSPACE.databases}/voice-bookmarks/ 目录
 */
export class VoiceBookmarkService {
  private memoryService: MemoryService | null = null
  /** 外部注入的 TTS 合成函数 — 接受文本，返回音频文件路径，或 null 表示失败 */
  private synthesizeFn: ((text: string, outputPath: string) => Promise<boolean>) | null = null
  /** 书签语音文件存储目录 */
  private audioDir: string = ''
  /** 是否已初始化 */
  private initialized = false

  constructor() {
    this.audioDir = join(WORKSPACE.databases, 'voice-bookmarks')
  }

  /**
   * 注入 MemoryService 引用。
   * 在 AppRuntime 初始化时调用。
   */
  setMemoryService(svc: MemoryService): void {
    this.memoryService = svc
  }

  /**
   * 注入 TTS 合成函数。
   * 由 AppRuntime 在初始化 PiperTTS 桥接后提供。
   */
  setSynthesizeFn(fn: (text: string, outputPath: string) => Promise<boolean>): void {
    this.synthesizeFn = fn
  }

  /**
   * 初始化：确保音频存储目录存在。
   */
  async init(): Promise<void> {
    if (this.initialized) return
    try {
      mkdirSync(this.audioDir, { recursive: true })
      this.initialized = true
      log('INFO', 'voice_bookmark_init', { audioDir: this.audioDir })
    } catch (err) {
      log('ERROR', 'voice_bookmark_init_failed', { error: String(err) })
    }
  }

  // ══════════════════════════════════════════
  //  书签 CRUD
  // ══════════════════════════════════════════

  /**
   * 创建语音记忆书签。
   *
   * @param summary 书签摘要（用于显示和搜索）
   * @param conversationContext 对话上下文（最近若干轮）
   * @param options.audioText 用于合成语音的文本（默认用 summary）
   * @param options.tags 标签列表
   * @param options.isFavorite 是否标记为收藏
   * @returns 创建的书签对象，或 null（当 MemoryService 未注入时）
   */
  async createBookmark(
    summary: string,
    conversationContext: VoiceBookmarkType['conversationContext'],
    options?: {
      audioText?: string
      tags?: string[]
      isFavorite?: boolean
    },
  ): Promise<VoiceBookmarkType | null> {
    if (!this.memoryService) {
      log('ERROR', 'voice_bookmark_memory_not_injected')
      return null
    }

    const trimmedSummary = summary.slice(0, MAX_SUMMARY_LENGTH)
    const audioText = (options?.audioText || trimmedSummary).slice(0, MAX_AUDIO_TEXT_LENGTH)
    const cleanAudioText = cleanTTS(audioText)

    const now = Date.now()
    const bookmarkId = `vb_${now}_${Math.random().toString(36).slice(2, 8)}`

    // 1. 合成语音文件（异步，不阻塞创建）
    let audioPath = ''
    let ttsDurationMs = 0
    let ttsEngine = ''
    if (this.synthesizeFn && cleanAudioText.length >= 3) {
      try {
        const ext = process.platform === 'win32' ? '.wav' : '.wav'
        const fileName = `${bookmarkId}${ext}`
        const outputPath = join(this.audioDir, fileName)
        const t0 = Date.now()
        const success = await this.synthesizeFn(cleanAudioText, outputPath)
        ttsDurationMs = Date.now() - t0

        if (success) {
          // 检查文件大小
          try {
            const stat = await fsp.stat(outputPath)
            if (stat.size <= MAX_AUDIO_FILE_SIZE) {
              audioPath = outputPath
            } else {
              log('WARN', 'voice_bookmark_audio_too_large', {
                id: bookmarkId,
                size: stat.size,
                maxSize: MAX_AUDIO_FILE_SIZE,
              })
              // 文件过大，删除并继续
              await fsp.unlink(outputPath).catch(() => {})
            }
          } catch {
            // stat failed, ignore
          }
        }
      } catch (err) {
        log('WARN', 'voice_bookmark_tts_failed', { error: String(err) })
      }
    }

    // 2. 构建书签对象
    const bookmark: VoiceBookmarkType = {
      id: bookmarkId,
      summary: trimmedSummary,
      audioPath,
      audioText: cleanAudioText,
      ttsDurationMs,
      ttsEngine,
      bookmarkedAt: now,
      conversationContext: conversationContext.slice(-DEFAULT_CONTEXT_ROUNDS * 2),
      tags: options?.tags || [],
      isFavorite: options?.isFavorite || false,
    }

    // 3. 存储到 MemoryService
    const structuredData = JSON.stringify(bookmark)
    this.memoryService.addEntry(
      'voice_bookmark',
      `【书签】${trimmedSummary}`,
      0.95, // 高置信度，用户主动创建的书签
      { tier: 'semi', structuredData },
    )

    log('INFO', 'voice_bookmark_created', {
      id: bookmarkId,
      summary: trimmedSummary.slice(0, 60),
      audioPath: audioPath || '(none)',
      contextRounds: conversationContext.length,
      ttsMs: ttsDurationMs,
    })

    return bookmark
  }

  /**
   * 从 MemoryService 中查找所有语音书签记忆条目，解析为 VoiceBookmark 对象。
   */
  private findAllBookmarks(): Array<{ entry: MemoryEntry; bookmark: VoiceBookmarkType }> {
    if (!this.memoryService) return []

    const entries = this.memoryService.getEntries().filter((e) => e.type === 'voice_bookmark' && e.structuredData)
    const results: Array<{ entry: MemoryEntry; bookmark: VoiceBookmarkType }> = []

    for (const entry of entries) {
      try {
        const bookmark = JSON.parse(entry.structuredData!) as VoiceBookmarkType
        if (bookmark && bookmark.id) {
          results.push({ entry, bookmark })
        }
      } catch {
        // 解析失败，跳过
      }
    }

    // 按创建时间降序排序
    results.sort((a, b) => b.bookmark.bookmarkedAt - a.bookmark.bookmarkedAt)
    return results
  }

  /**
   * 获取所有书签列表。
   */
  listBookmarks(limit = 50, offset = 0): VoiceBookmarkType[] {
    const all = this.findAllBookmarks()
    return all.slice(offset, offset + limit).map((r) => r.bookmark)
  }

  /**
   * 获取单个书签详情。
   */
  getBookmark(id: string): VoiceBookmarkType | null {
    const all = this.findAllBookmarks()
    const found = all.find((r) => r.bookmark.id === id)
    return found?.bookmark ?? null
  }

  /**
   * 全文搜索书签（匹配摘要、标签、对话内容）。
   */
  searchBookmarks(query: string): VoiceBookmarkType[] {
    if (!query.trim()) return this.listBookmarks()

    const lower = query.toLowerCase()
    const all = this.findAllBookmarks()

    return all
      .filter((r) => {
        const b = r.bookmark
        // 搜索摘要
        if (b.summary.toLowerCase().includes(lower)) return true
        // 搜索标签
        if (b.tags.some((t) => t.toLowerCase().includes(lower))) return true
        // 搜索对话上下文
        if (b.conversationContext.some((c) => c.content.toLowerCase().includes(lower))) return true
        return false
      })
      .map((r) => r.bookmark)
  }

  /**
   * 删除书签。
   * 同时删除关联的语音文件。
   */
  async deleteBookmark(id: string): Promise<boolean> {
    if (!this.memoryService) return false

    const all = this.findAllBookmarks()
    const found = all.find((r) => r.bookmark.id === id)
    if (!found) return false

    // 删除语音文件
    if (found.bookmark.audioPath) {
      try {
        await fsp.unlink(found.bookmark.audioPath)
      } catch {
        // 文件可能已被删除
      }
    }

    // 从 MemoryService 删除记忆条目
    return this.memoryService.forgetEntry(found.entry.id)
  }

  /**
   * 获取书签的语音文件路径。
   * 如果书签没有关联的语音文件，返回 null。
   */
  getAudioPath(id: string): string | null {
    const bookmark = this.getBookmark(id)
    if (!bookmark || !bookmark.audioPath) return null

    // 检查文件是否存在
    try {
      if (existsSync(bookmark.audioPath)) {
        return bookmark.audioPath
      }
    } catch {
      // 检查失败
    }
    return null
  }

  /**
   * 切换书签的收藏状态。
   */
  toggleFavorite(id: string): boolean {
    if (!this.memoryService) return false

    const all = this.findAllBookmarks()
    const found = all.find((r) => r.bookmark.id === id)
    if (!found) return false

    const updated: VoiceBookmarkType = {
      ...found.bookmark,
      isFavorite: !found.bookmark.isFavorite,
    }

    // 通过公开的 setEntryStructuredData API 更新，避免访问私有方法
    return this.memoryService.setEntryStructuredData(found.entry.id, JSON.stringify(updated))
  }

  /**
   * 获取收藏的书签列表。
   */
  getFavorites(): VoiceBookmarkType[] {
    return this.findAllBookmarks()
      .filter((r) => r.bookmark.isFavorite)
      .map((r) => r.bookmark)
  }
}
