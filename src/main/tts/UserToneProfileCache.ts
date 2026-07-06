/**
 * UserToneProfileCache — 用户语气画像持久化缓存
 *
 * 将 UserToneProfile 序列化为 JSON 文件存储到 workspace cache 目录，
 * 支持跨会话恢复用户语气画像。
 *
 * 缓存策略：
 *   - 每次画像更新后自动保存（debounced，避免高频 IO）
 *   - 启动时自动加载
 *   - 单用户单文件（未来可扩展为多用户）
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { log } from '../logger/Logger'
import { WORKSPACE } from '../config'
import type { UserToneProfile } from './types'
import { DEFAULT_TONE_PROFILE } from './types'

/** 缓存文件名 */
const CACHE_FILENAME = 'user-tone-profile.json'

/** 缓存文件路径 */
function getCachePath(): string {
  const dir = WORKSPACE.cache
  return join(dir, CACHE_FILENAME)
}

/** Debounce 延迟（毫秒） */
const SAVE_DEBOUNCE_MS = 2000

export class UserToneProfileCache {
  private currentProfile: UserToneProfile = { ...DEFAULT_TONE_PROFILE }
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private dirty = false

  /**
   * 从磁盘加载缓存的语气画像。
   * 文件不存在或损坏时返回默认画像。
   */
  load(): UserToneProfile {
    const filePath = getCachePath()
    try {
      if (!existsSync(filePath)) {
        log('INFO', 'tone_profile_cache_miss', { path: filePath })
        return { ...DEFAULT_TONE_PROFILE }
      }

      const raw = readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as UserToneProfile

      // 基本校验
      if (
        typeof parsed.primaryTone !== 'string' ||
        typeof parsed.confidence !== 'number' ||
        !parsed.features
      ) {
        log('WARN', 'tone_profile_cache_invalid', { path: filePath })
        return { ...DEFAULT_TONE_PROFILE }
      }

      this.currentProfile = parsed
      log('INFO', 'tone_profile_cache_loaded', {
        tone: parsed.primaryTone,
        confidence: parsed.confidence.toFixed(2),
        messageCount: parsed.messageCount,
        lastUpdated: new Date(parsed.lastUpdated).toISOString(),
      })

      return { ...parsed }
    } catch (err) {
      log('WARN', 'tone_profile_cache_load_error', {
        path: filePath,
        error: String(err),
      })
      return { ...DEFAULT_TONE_PROFILE }
    }
  }

  /**
   * 保存语气画像到磁盘（带 debounce）。
   * 调用后不立即写入，等待 SAVE_DEBOUNCE_MS 内的后续更新合并。
   */
  save(profile: UserToneProfile): void {
    this.currentProfile = { ...profile }
    this.dirty = true

    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
    }

    this.saveTimer = setTimeout(() => {
      this.flush()
    }, SAVE_DEBOUNCE_MS)
  }

  /**
   * 立即写入磁盘（跳过 debounce）。
   * 用于应用退出前的紧急保存。
   */
  flush(): void {
    if (!this.dirty) return

    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }

    const filePath = getCachePath()
    try {
      // 确保目录存在
      const dir = dirname(filePath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      const profile = {
        ...this.currentProfile,
        lastUpdated: Date.now(),
      }

      writeFileSync(filePath, JSON.stringify(profile, null, 2), 'utf-8')
      this.dirty = false

      log('INFO', 'tone_profile_cache_saved', {
        tone: profile.primaryTone,
        confidence: profile.confidence.toFixed(2),
        messageCount: profile.messageCount,
      })
    } catch (err) {
      log('ERROR', 'tone_profile_cache_save_error', {
        path: filePath,
        error: String(err),
      })
    }
  }

  /**
   * 获取当前内存中的画像（不读磁盘）。
   */
  getCurrent(): UserToneProfile {
    return { ...this.currentProfile }
  }

  /**
   * 删除缓存文件并重置内存状态。
   */
  clear(): void {
    this.currentProfile = { ...DEFAULT_TONE_PROFILE }
    this.dirty = false
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }

    const filePath = getCachePath()
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath)
        log('INFO', 'tone_profile_cache_cleared', { path: filePath })
      }
    } catch (err) {
      log('WARN', 'tone_profile_cache_clear_error', { error: String(err) })
    }
  }
}

// ── 单例 ──

/** 全局单例 */
export const toneProfileCache = new UserToneProfileCache()
