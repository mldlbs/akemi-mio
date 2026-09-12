/**
 * BlogVoiceService — 博客语音录制与音频文件管理
 *
 * 职责：
 * 1. 保存博客语音录音（从 ASR 捕获的 PCM → WebM 文件）
 * 2. 列出、获取、删除博客关联的音频文件
 * 3. 支持口述文稿录音与审核批注录音两种类型
 *
 * 存储结构：
 *   {userData}/blog-audio/
 *     dictation/    — 口述文稿录音（编辑器录制）
 *     annotation/   — 审核批注录音（审核界面录制）
 *   metadata 写入 blog-audio/index.json 索引文件
 */

import { promises as fsp } from 'fs'
import { join, dirname } from 'path'
import { app } from 'electron'
import { log } from '@akemi-mio/core'
import { randomUUID } from 'crypto'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

export type AudioType = 'dictation' | 'annotation'

export interface BlogAudioEntry {
  /** 唯一 ID */
  id: string
  /** 音频类型 */
  type: AudioType
  /** 关联的博客会话 ID（可选） */
  sessionId?: string
  /** 关联的文章段落索引（审核批注时使用） */
  paragraphIndex?: number
  /** 录制时长（秒） */
  durationSec: number
  /** 文件路径（相对存储根目录） */
  relativePath: string
  /** ASR 识别出的文本（可选） */
  transcribedText?: string
  /** 创建时间戳 */
  createdAt: number
  /** 标签/备注 */
  label?: string
}

interface BlogAudioIndex {
  entries: BlogAudioEntry[]
}

// ══════════════════════════════════════════
//  BlogVoiceService
// ══════════════════════════════════════════

export class BlogVoiceService {
  private storageRoot: string
  private indexPath: string
  private index: BlogAudioIndex = { entries: [] }
  private loaded = false

  constructor() {
    const userData = app.getPath('userData')
    this.storageRoot = join(userData, 'blog-audio')
    this.indexPath = join(this.storageRoot, 'index.json')
  }

  // ════════════════════════════════════════
  //  初始化
  // ════════════════════════════════════════

  async initialize(): Promise<void> {
    if (this.loaded) return
    try {
      await fsp.mkdir(join(this.storageRoot, 'dictation'), { recursive: true })
      await fsp.mkdir(join(this.storageRoot, 'annotation'), { recursive: true })
      await this.loadIndex()
      this.loaded = true
      log('INFO', 'blog_voice_service_init', {
        entryCount: this.index.entries.length,
        root: this.storageRoot,
      })
    } catch (err) {
      log('ERROR', 'blog_voice_service_init_failed', { error: String(err) })
    }
  }

  // ════════════════════════════════════════
  //  公开 API
  // ════════════════════════════════════════

  /**
   * 保存一段博客录音。
   * audioBuffer 为 Int16 PCM 数据（16kHz, mono, s16le），
   * 转为 WAV 格式写入磁盘。
   *
   * @returns 新建的音频条目
   */
  async saveAudio(
    audioBuffer: ArrayBuffer,
    type: AudioType,
    options?: {
      sessionId?: string
      paragraphIndex?: number
      durationSec?: number
      transcribedText?: string
      label?: string
    },
  ): Promise<BlogAudioEntry | null> {
    await this.ensureLoaded()

    const id = `blog_audio_${Date.now()}_${randomUUID().slice(0, 8)}`
    const subDir = type === 'annotation' ? 'annotation' : 'dictation'
    const fileName = `${id}.wav`
    const relativePath = `${subDir}/${fileName}`
    const absolutePath = join(this.storageRoot, relativePath)

    try {
      // 将 PCM Int16 写入 WAV 文件
      const wavBuffer = this.pcmToWav(new Int16Array(audioBuffer), 16000)
      await fsp.writeFile(absolutePath, wavBuffer)

      const entry: BlogAudioEntry = {
        id,
        type,
        sessionId: options?.sessionId,
        paragraphIndex: options?.paragraphIndex,
        durationSec: options?.durationSec ?? 0,
        relativePath,
        transcribedText: options?.transcribedText,
        createdAt: Date.now(),
        label: options?.label,
      }

      this.index.entries.push(entry)
      await this.saveIndex()

      log('INFO', 'blog_audio_saved', {
        id,
        type,
        duration: entry.durationSec,
        path: relativePath,
      })

      return entry
    } catch (err) {
      log('ERROR', 'blog_audio_save_failed', { id, error: String(err) })
      return null
    }
  }

  /**
   * 获取存储根目录的绝对路径（供渲染进程读取音频文件时使用）。
   */
  getStorageRoot(): string {
    return this.storageRoot
  }

  /**
   * 获取音频文件的绝对路径。
   */
  getAudioPath(entryId: string): string | null {
    const entry = this.index.entries.find((e) => e.id === entryId)
    if (!entry) return null
    return join(this.storageRoot, entry.relativePath)
  }

  /**
   * 列出博客音频条目，按类型过滤，按创建时间降序。
   */
  listAudio(type?: AudioType, limit = 50): BlogAudioEntry[] {
    let entries = this.index.entries
    if (type) entries = entries.filter((e) => e.type === type)
    return entries
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
  }

  /**
   * 删除一条音频记录及其文件。
   */
  async deleteAudio(entryId: string): Promise<boolean> {
    const idx = this.index.entries.findIndex((e) => e.id === entryId)
    if (idx === -1) return false

    const entry = this.index.entries[idx]
    const filePath = join(this.storageRoot, entry.relativePath)

    try {
      await fsp.unlink(filePath).catch(() => {})
    } catch {
      // 文件可能已被外部删除
    }

    this.index.entries.splice(idx, 1)
    await this.saveIndex()

    log('INFO', 'blog_audio_deleted', { id: entryId })
    return true
  }

  /**
   * 获取关联到指定会话的所有音频。
   */
  listAudioBySession(sessionId: string): BlogAudioEntry[] {
    return this.index.entries.filter((e) => e.sessionId === sessionId).sort((a, b) => b.createdAt - a.createdAt)
  }

  // ════════════════════════════════════════
  //  内部方法
  // ════════════════════════════════════════

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.initialize()
  }

  private async loadIndex(): Promise<void> {
    try {
      const data = await fsp.readFile(this.indexPath, 'utf-8')
      this.index = JSON.parse(data) as BlogAudioIndex
      if (!Array.isArray(this.index.entries)) this.index.entries = []
    } catch {
      this.index = { entries: [] }
    }
  }

  private async saveIndex(): Promise<void> {
    try {
      await fsp.writeFile(this.indexPath, JSON.stringify(this.index, null, 2), 'utf-8')
    } catch (err) {
      log('ERROR', 'blog_audio_index_save_failed', { error: String(err) })
    }
  }

  /**
   * 将 Int16 PCM 数据编码为 WAV 文件。
   */
  private pcmToWav(pcm: Int16Array, sampleRate: number): Buffer {
    const numChannels = 1
    const bitsPerSample = 16
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
    const blockAlign = numChannels * (bitsPerSample / 8)
    const dataSize = pcm.length * (bitsPerSample / 8)
    const headerSize = 44
    const totalSize = headerSize + dataSize

    const buffer = Buffer.alloc(totalSize)
    let offset = 0

    // RIFF header
    buffer.write('RIFF', offset)
    offset += 4
    buffer.writeUInt32LE(totalSize - 8, offset)
    offset += 4
    buffer.write('WAVE', offset)
    offset += 4

    // fmt sub-chunk
    buffer.write('fmt ', offset)
    offset += 4
    buffer.writeUInt32LE(16, offset)
    offset += 4 // sub-chunk size
    buffer.writeUInt16LE(1, offset)
    offset += 2 // PCM format
    buffer.writeUInt16LE(numChannels, offset)
    offset += 2
    buffer.writeUInt32LE(sampleRate, offset)
    offset += 4
    buffer.writeUInt32LE(byteRate, offset)
    offset += 4
    buffer.writeUInt16LE(blockAlign, offset)
    offset += 2
    buffer.writeUInt16LE(bitsPerSample, offset)
    offset += 2

    // data sub-chunk
    buffer.write('data', offset)
    offset += 4
    buffer.writeUInt32LE(dataSize, offset)
    offset += 4

    // PCM data
    for (let i = 0; i < pcm.length; i++) {
      buffer.writeInt16LE(pcm[i], offset)
      offset += 2
    }

    return buffer
  }
}

/** 全局单例 */
export const blogVoiceService = new BlogVoiceService()
