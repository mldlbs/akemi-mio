/**
 * MemoryCleaner — 记忆效用驱动的定期清理器
 *
 * 职责：
 * 1. 定期（每日）扫描低效用记忆
 * 2. 将低效用记忆移至归档表（memory_archive）
 * 3. 收集待清理列表供用户确认
 * 4. 清理后更新记忆存储并产生报告
 *
 * 集成点：
 * - MemoryService 在构造时启动清理定时器
 * - 清理候选列表通过事件/回调通知用户确认
 * - 清理前可以通过 getCleanupCandidates() 预览即将删除的记忆
 */

import { log } from '../logger/Logger'
import { getRawDb, markDirty } from '../db/connection'
import type { MemoryEntry } from './types'
import { type MemoryUtilityTracker, UTILITY_LOW_THRESHOLD } from './MemoryUtilityTracker'

// ══════════════════════════════════════════
//  配置常量
// ══════════════════════════════════════════

/** 默认清理检查间隔（24 小时） */
export const DEFAULT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 每次清理最多删除的记忆数 */
export const MAX_CLEANUP_PER_RUN = 20

/** 需要用户确认：默认 true（安全模式） */
export const REQUIRE_USER_CONFIRMATION = true

/** 清理后最少保留的记忆数（防止全部清空） */
export const MIN_MEMORIES_AFTER_CLEANUP = 10

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

export interface CleanupCandidate {
  entry: MemoryEntry
  /** 删除理由（如：效用过低、长期未引用） */
  reason: string
}

export interface CleanupReport {
  /** 清理时间 */
  timestamp: number
  /** 本次检查的总条目数 */
  totalChecked: number
  /** 本次清理删除的条目数 */
  removedCount: number
  /** 本次清理归档的条目数 */
  archivedCount: number
  /** 被删除的记忆 ID 列表 */
  removedIds: string[]
  /** 跳过的记忆 ID 列表（用户确认后删除才执行） */
  pendingConfirmationIds: string[]
  /** 清理后的总条目数 */
  remainingCount: number
}

// ══════════════════════════════════════════
//  MemoryCleaner
// ══════════════════════════════════════════

export class MemoryCleaner {
  private utilityTracker: MemoryUtilityTracker
  private timer: ReturnType<typeof setInterval> | null = null
  private cleanupIntervalMs: number
  private requireConfirmation: boolean

  /** 待用户确认的清理候选（requireConfirmation=true 时暂存） */
  public pendingCandidates: CleanupCandidate[] = []

  constructor(
    utilityTracker: MemoryUtilityTracker,
    options?: {
      cleanupIntervalMs?: number
      requireConfirmation?: boolean
    },
  ) {
    this.utilityTracker = utilityTracker
    this.cleanupIntervalMs = options?.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS
    this.requireConfirmation = options?.requireConfirmation ?? REQUIRE_USER_CONFIRMATION
  }

  // ══════════════════════════════════════════
  //  生命周期管理
  // ══════════════════════════════════════════

  /** 启动定时清理 */
  start(): void {
    if (this.timer) return
    // 首次清理延迟 5 分钟，给系统稳定时间
    const initialDelay = 5 * 60 * 1000

    setTimeout(() => {
      this.timer = setInterval(() => {
        log('INFO', 'memory_cleaner_tick')
      }, this.cleanupIntervalMs)

      log('INFO', 'memory_cleaner_started', {
        intervalMs: this.cleanupIntervalMs,
        requireConfirmation: this.requireConfirmation,
      })
    }, initialDelay)
  }

  /** 停止定时清理 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.pendingCandidates = []
  }

  /**
   * 获取低效用记忆作为清理候选（预览用，不实际删除）。
   * 按效用分数升序排列（最低效用的排在前面）。
   */
  getCleanupCandidates(entries: MemoryEntry[], maxCount = MAX_CLEANUP_PER_RUN): CleanupCandidate[] {
    const candidates: CleanupCandidate[] = []

    for (const entry of entries) {
      if (entry.tier === 'permanent' || entry.isPinned) continue
      if (entry.type !== 'user_fact') continue

      const utility = this.utilityTracker.computeUtilityScore(entry)
      if (utility >= UTILITY_LOW_THRESHOLD) continue

      // 生成删除理由
      const reasons: string[] = []
      if (utility < 0.1) reasons.push('效用极低')
      else reasons.push('效用过低')
      if (entry.agentReferenceCount === 0) reasons.push('从未被 Agent 引用')
      if (entry.accessCount <= 1) reasons.push('很少被访问')

      candidates.push({
        entry,
        reason: reasons.join('、'),
      })
    }

    // 按效用升序排列（最低效用优先）
    candidates.sort(
      (a, b) =>
        this.utilityTracker.computeUtilityScore(a.entry) - this.utilityTracker.computeUtilityScore(b.entry),
    )

    return candidates.slice(0, maxCount)
  }

  /**
   * 执行清理：删除低效用记忆并归档。
   * 如果 requireConfirmation=true，先将候选列表存入 pendingCandidates，
   * 等待外部调用 confirmCleanup() 执行实际删除。
   *
   * @param entries 所有记忆条目（会被修改）
   * @param removedIds 用以收集被删除 ID 的 Set
   * @returns 清理报告
   */
  runCleanup(entries: MemoryEntry[], removedIds: Set<string>): CleanupReport {
    const now = Date.now()
    let totalChecked = 0
    let removedCount = 0
    let archivedCount = 0
    const archiveEntries: Array<{ id: string; type: string; content: string; confidence: number; tier: string; reason: string }> = []

    // 1. 收集候选
    const allCandidates = this.getCleanupCandidates(entries)
    this.pendingCandidates = allCandidates

    totalChecked = entries.length

    if (this.requireConfirmation && allCandidates.length > 0) {
      log('INFO', 'memory_cleaner_pending_confirmation', {
        count: allCandidates.length,
        candidates: allCandidates.map((c) => ({
          id: c.entry.id,
          content: c.entry.content.slice(0, 40),
          reason: c.reason,
        })),
      })
    }

    // 2. 如果不需要用户确认，直接删除
    const candidatesToRemove = this.requireConfirmation ? [] : allCandidates

    // 确保清理后最少保留数
    const nonPermanent = entries.filter(
      (e) => e.tier !== 'permanent' && !e.isPinned && e.type === 'user_fact',
    )
    const maxRemovable = Math.max(0, nonPermanent.length - MIN_MEMORIES_AFTER_CLEANUP)

    for (let i = 0; i < Math.min(candidatesToRemove.length, maxRemovable); i++) {
      const candidate = candidatesToRemove[i]
      const idx = entries.findIndex((e) => e.id === candidate.entry.id)
      if (idx < 0) continue

      // 归档
      archiveEntries.push({
        id: candidate.entry.id,
        type: candidate.entry.type,
        content: candidate.entry.content,
        confidence: candidate.entry.confidence,
        tier: candidate.entry.tier,
        reason: candidate.reason,
      })

      // 从当前内存中移除
      removedIds.add(candidate.entry.id)
      entries.splice(idx, 1)
      removedCount++
    }

    // 3. 写入归档
    if (archiveEntries.length > 0) {
      try {
        const db = getRawDb()
        db.run('BEGIN')
        for (const ae of archiveEntries) {
          db.run(
            `INSERT OR REPLACE INTO memory_archive (id, type, content, confidence, tier, reason, archived_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [ae.id, ae.type, ae.content, ae.confidence, ae.tier, ae.reason, now],
          )
        }
        db.run('COMMIT')
        markDirty()
        archivedCount = archiveEntries.length
      } catch (err) {
        try {
          getRawDb().run('ROLLBACK')
        } catch {}
        log('ERROR', 'memory_cleaner_archive_failed', { error: String(err) })
      }
    }

    const report: CleanupReport = {
      timestamp: now,
      totalChecked,
      removedCount,
      archivedCount,
      removedIds: Array.from(removedIds).slice(-removedCount),
      pendingConfirmationIds: this.requireConfirmation
        ? allCandidates.map((c) => c.entry.id)
        : [],
      remainingCount: entries.length,
    }

    if (removedCount > 0 || this.pendingCandidates.length > 0) {
      log('INFO', 'memory_cleaner_run', {
        removed: removedCount,
        archived: archivedCount,
        pendingConfirmation: this.pendingCandidates.length,
        remaining: entries.length,
      })
    }

    return report
  }

  /**
   * 用户确认清理。执行之前暂存的待删除记忆。
   * 用户可以选择全部删除或指定 ID 列表。
   *
   * @param entries 所有记忆条目（会被修改）
   * @param removedIds 用以收集被删除 ID 的 Set
   * @param confirmIds 用户确认要删除的记忆 ID 列表（null=全部删除）
   * @returns 实际删除的数量
   */
  confirmCleanup(
    entries: MemoryEntry[],
    removedIds: Set<string>,
    confirmIds?: string[],
  ): number {
    if (this.pendingCandidates.length === 0) return 0

    const idsToRemove = confirmIds ?? this.pendingCandidates.map((c) => c.entry.id)
    let confirmedCount = 0
    const archiveEntries: Array<{ id: string; type: string; content: string; confidence: number; tier: string; reason: string }> = []

    for (const candidate of this.pendingCandidates) {
      if (!idsToRemove.includes(candidate.entry.id)) continue
      const idx = entries.findIndex((e) => e.id === candidate.entry.id)
      if (idx < 0) continue

      archiveEntries.push({
        id: candidate.entry.id,
        type: candidate.entry.type,
        content: candidate.entry.content,
        confidence: candidate.entry.confidence,
        tier: candidate.entry.tier,
        reason: candidate.reason,
      })

      removedIds.add(candidate.entry.id)
      entries.splice(idx, 1)
      confirmedCount++
    }

    // 归档
    if (archiveEntries.length > 0) {
      try {
        const db = getRawDb()
        db.run('BEGIN')
        for (const ae of archiveEntries) {
          db.run(
            `INSERT OR REPLACE INTO memory_archive (id, type, content, confidence, tier, reason, archived_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [ae.id, ae.type, ae.content, ae.confidence, ae.tier, ae.reason, Date.now()],
          )
        }
        db.run('COMMIT')
        markDirty()
      } catch (err) {
        try {
          getRawDb().run('ROLLBACK')
        } catch {}
        log('ERROR', 'memory_cleaner_confirm_archive_failed', { error: String(err) })
      }
    }

    this.pendingCandidates = []

    log('INFO', 'memory_cleaner_confirmed', {
      confirmed: confirmedCount,
      archived: archiveEntries.length,
    })

    return confirmedCount
  }

  /**
   * 拒绝所有待清理候选（不做删除）。
   */
  rejectCleanup(): void {
    const count = this.pendingCandidates.length
    this.pendingCandidates = []
    log('INFO', 'memory_cleaner_rejected', { count })
  }

  /**
   * 获取配置
   */
  getConfig(): { cleanupIntervalMs: number; requireConfirmation: boolean } {
    return {
      cleanupIntervalMs: this.cleanupIntervalMs,
      requireConfirmation: this.requireConfirmation,
    }
  }

  /** 更新配置 */
  updateConfig(config: { cleanupIntervalMs?: number; requireConfirmation?: boolean }): void {
    if (config.cleanupIntervalMs !== undefined) {
      this.cleanupIntervalMs = config.cleanupIntervalMs
    }
    if (config.requireConfirmation !== undefined) {
      this.requireConfirmation = config.requireConfirmation
    }
    log('INFO', 'memory_cleaner_config_updated', {
      cleanupIntervalMs: this.cleanupIntervalMs,
      requireConfirmation: this.requireConfirmation,
    })
  }
}
