/**
 * pipeline/CacheManager.ts — 中间结果缓存管理器
 *
 * 为流水线中每个 Stage 的输出提供缓存能力：根据输入哈希查找缓存，
 * 在输入未变时跳过重复执行，支持按 Stage 维度无效化。
 *
 * 设计原则：
 * - 纯内存缓存（适合单会话场景）
 * - 输入哈希使用 JSON-stable-stringify + SHA-256 摘要
 * - 可选的 TTL 过期
 * - 线程安全（通过 JS 单线程保证）
 */

import { createHash } from 'crypto'
import { log } from '@akemi-mio/core/logger/Logger'
import type { CacheEntry, CacheStats, ICacheManager, StageOutput } from '@akemi-mio/intelligence/pipeline/types'

/** 默认缓存 TTL：5 分钟 */
const DEFAULT_TTL_MS = 5 * 60 * 1000

/**
 * 计算输入哈希：稳定 JSON 序列化 → SHA-256 前缀。
 * 使用前 16 字符作为缓存 key 后缀，兼顾唯一性与可读性。
 */
export function computeInputHash(inputs: Record<string, unknown>): string {
  const stable = JSON.stringify(inputs, Object.keys(inputs).sort())
  return createHash('sha256').update(stable).digest('hex').slice(0, 16)
}

export class CacheManager implements ICacheManager {
  /** 缓存存储 */
  private readonly store = new Map<string, CacheEntry>()

  /** 统计 */
  private hits = 0
  private misses = 0

  get(stageId: string, inputHash: string): StageOutput | null {
    const key = `${stageId}::${inputHash}`
    const entry = this.store.get(key)

    if (!entry) {
      this.misses++
      return null
    }

    // TTL 检查
    if (entry.ttlMs > 0 && Date.now() - entry.createdAt > entry.ttlMs) {
      this.store.delete(key)
      this.misses++
      return null
    }

    this.hits++
    log('DEBUG', 'pipeline_cache_hit', { stageId, key: key.slice(0, 32) })
    return {
      ...entry.output,
      fromCache: true,
    }
  }

  set(stageId: string, inputHash: string, output: StageOutput, ttlMs: number = DEFAULT_TTL_MS): void {
    const key = `${stageId}::${inputHash}`
    this.store.set(key, {
      stageId,
      inputHash,
      output,
      createdAt: Date.now(),
      ttlMs,
    })
    log('DEBUG', 'pipeline_cache_set', { stageId, key: key.slice(0, 32), ttlMs })
  }

  /**
   * 无效化缓存。
   * @param stageId 可选：仅无效化指定 stage 的缓存；不传则清空全部。
   */
  invalidate(stageId?: string): void {
    if (!stageId) {
      this.store.clear()
      log('INFO', 'pipeline_cache_invalidated_all')
      return
    }

    // 删除所有以 `${stageId}::` 开头的条目
    const prefix = `${stageId}::`
    let count = 0
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key)
        count++
      }
    }
    if (count > 0) {
      log('INFO', 'pipeline_cache_invalidated', { stageId, count })
    }
  }

  getStats(): CacheStats {
    return {
      entries: this.store.size,
      hits: this.hits,
      misses: this.misses,
    }
  }
}

/** 全局单例 */
export const cacheManager = new CacheManager()
