/**
 * ProblemFixCache — Evolution 问题修复缓存
 *
 * 迁移自 tool/ToolAvailabilityCache 的设计模式：
 * 对不可修复的问题类型进行缓存，避免浪费重试资源。
 *
 * 只缓存 UNFIXABLE 和 ENVIRONMENT 类型的修复失败，
 * TRANSIENT / TIMEOUT / UNKNOWN 不缓存（状态可能变化）。
 *
 * 基于日志实证：对已不存在的文件重复修复 3 次，
 * 每次浪费 30s+ 的 LLM 调用，直接导致管道吞吐下降。
 */

import { log } from '../../logger/Logger'
import { ProblemErrorType, shouldCacheErrorType, classifyProblemError } from './ProblemErrorType'

// ── 缓存配置 ──

const CACHE_TTL_MS = 30 * 60 * 1000 // 30 分钟（与 ToolAvailabilityCache 一致）
const MAX_CACHE_SIZE = 200

// ── 缓存条目 ──

interface CacheEntry {
  key: string
  source: string
  errorType: ProblemErrorType
  reason: string
  until: number
}

/**
 * ProblemFixCache — 问题修复缓存
 *
 * 检查队列中的问题是否属于已知不可修复类别，
 * 若是则跳过修复尝试，直接标记为完成。
 */
export class ProblemFixCache {
  private cache = new Map<string, CacheEntry>()

  /**
   * 检查问题是否已知不可修复
   *
   * @param source 问题来源 (tsc, test, lint, ...)
   * @param title  问题标题（用于模式匹配）
   * @param message 错误消息文本
   * @returns 如果不可修复，返回缓存原因（字符串）；否则返回 null
   */
  check(source: string, title: string, message: string): string | null {
    const key = this.buildKey(source, title)
    const entry = this.cache.get(key)
    if (entry && Date.now() < entry.until) {
      return entry.reason
    }
    if (entry) {
      this.cache.delete(key)
    }

    // 即使没有精确缓存，也做实时分类检查
    const errorType = classifyProblemError(message)
    if (shouldCacheErrorType(errorType)) {
      // 这种类型的错误应该被缓存，但还没在缓存中 → 标记首次发现
      // 此处不自动缓存，让 record() 在修复失败时调用
      return null
    }

    return null
  }

  /**
   * 记录修复失败，对于可缓存的错误类型写入缓存
   *
   * @param source  问题来源
   * @param title   问题标题
   * @param errorMessage 错误消息（用于分类）
   */
  record(source: string, title: string, errorMessage: string): void {
    const errorType = classifyProblemError(errorMessage)
    if (!shouldCacheErrorType(errorType)) return

    const key = this.buildKey(source, title)
    this.cache.set(key, {
      key,
      source,
      errorType,
      reason: errorMessage.slice(0, 200),
      until: Date.now() + CACHE_TTL_MS,
    })

    // 维护缓存上限
    this.evictIfNeeded()

    log('INFO', 'problem_fix_cache_recorded', {
      source,
      title: title.slice(0, 60),
      errorType,
      ttlMin: CACHE_TTL_MS / 60000,
    })
  }

  /**
   * 清除全部或指定来源的缓存
   */
  clear(source?: string): void {
    if (source) {
      for (const [key, entry] of this.cache) {
        if (entry.source === source) this.cache.delete(key)
      }
      log('INFO', 'problem_fix_cache_cleared_source', { source })
    } else {
      this.cache.clear()
      log('INFO', 'problem_fix_cache_cleared_all')
    }
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): { size: number; entries: Array<{ source: string; errorType: ProblemErrorType; remainingSec: number }> } {
    const now = Date.now()
    const entries: Array<{ source: string; errorType: ProblemErrorType; remainingSec: number }> = []
    for (const [, entry] of this.cache) {
      if (now < entry.until) {
        entries.push({
          source: entry.source,
          errorType: entry.errorType,
          remainingSec: Math.round((entry.until - now) / 1000),
        })
      }
    }
    return { size: entries.length, entries }
  }

  // ── Private ──

  /**
   * 构建缓存键：来源 + 标题归一化
   * 标题会去除变量部分（行号、数字、具体路径）以提高缓存命中率
   */
  private buildKey(source: string, title: string): string {
    const normalized = title
      .replace(/\d+/g, 'N') // 行号/数字 → N
      .replace(/: \d+:\d+/g, ': N:N') // 行号范围
      .replace(/"[^"]+"/g, '"..."') // 引号内容
      .replace(/'[^']+'/g, "'...'") // 单引号内容
      .replace(/\\/g, '/') // 路径归一化
      .replace(/\/[^/]+\/[^/]+\.\w+/g, '/.../file.ext') // 深路径归一化
      .trim()
    return `${source}|${normalized}`
  }

  /**
   * 维护缓存上限：超出时移除最旧条目
   */
  private evictIfNeeded(): void {
    if (this.cache.size <= MAX_CACHE_SIZE) return

    const entries = [...this.cache.entries()].sort((a, b) => a[1].until - b[1].until)
    const toRemove = Math.floor(MAX_CACHE_SIZE * 0.2)
    for (let i = 0; i < toRemove; i++) {
      this.cache.delete(entries[i][0])
    }
    log('INFO', 'problem_fix_cache_evicted', { removed: toRemove, remaining: this.cache.size })
  }
}

// ═══════════════════════════════════════════
//  全局单例
// ═══════════════════════════════════════════

export const problemFixCache = new ProblemFixCache()
