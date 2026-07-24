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

/** 行为加权清洗：话题保护乘数阈值（高于此值视为受保护） */
export const BEHAVIOR_PROTECT_MULTIPLIER = 1.5

/** 行为加权清洗：话题惩罚乘数阈值（低于此值视为应清理） */
export const BEHAVIOR_PENALTY_MULTIPLIER = 0.8

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

export interface CleanupCandidate {
  entry: MemoryEntry
  /** 删除理由（如：效用过低、长期未引用） */
  reason: string
  /** 行为加权乘数（用于清洗决策），无加权时为 null */
  behaviorMultiplier?: number
}

/**
 * 行为加权集成接口 — 供 MemoryCleaner 在清洗周期中
 * 根据用户行为模式动态调整记忆保留策略。
 */
export interface BehaviorWeightingIntegration {
  /**
   * 计算记忆条目的行为加权清洗乘数。
   * @param memoryTopics 记忆的话题标签
   * @returns 0.5 (惩罚) ~ 2.0 (保护) 的乘数
   */
  computeCleanupMultiplier(memoryTopics: string[]): number
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
  /** 是否启用了行为加权 */
  behaviorWeightingEnabled: boolean
  /** 被行为加权保护的候选数（乘数 > 保护阈值但效用过低） */
  protectedByBehavior?: number
  /** 被行为加权惩罚的候选数（乘数 < 惩罚阈值） */
  penalizedByBehavior?: number
}

// ══════════════════════════════════════════
//  MemoryCleaner
// ══════════════════════════════════════════

export class MemoryCleaner {
  private utilityTracker: MemoryUtilityTracker
  private timer: ReturnType<typeof setInterval> | null = null
  private cleanupIntervalMs: number
  private requireConfirmation: boolean
  /** 行为加权集成（可选），用于在清洗周期中根据用户行为动态调整记忆保留 */
  private behaviorWeighting: BehaviorWeightingIntegration | null

  /** 待用户确认的清理候选（requireConfirmation=true 时暂存） */
  public pendingCandidates: CleanupCandidate[] = []

  constructor(
    utilityTracker: MemoryUtilityTracker,
    options?: {
      cleanupIntervalMs?: number
      requireConfirmation?: boolean
      behaviorWeighting?: BehaviorWeightingIntegration | null
    },
  ) {
    this.utilityTracker = utilityTracker
    this.cleanupIntervalMs = options?.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS
    this.requireConfirmation = options?.requireConfirmation ?? REQUIRE_USER_CONFIRMATION
    this.behaviorWeighting = options?.behaviorWeighting ?? null
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
   *
   * 当 behaviorWeighting 集成存在时，每一条记忆会额外计算行为加权乘数：
   * - 乘数 > 1.5（受保护）: 当前用户正在关注相关话题 → 即使效用较低也暂不清理
   * - 乘数 < 0.8（应惩罚）: 相关话题长期未被提及 → 提高清理优先级
   * - 乘数在中间范围: 不做额外调整
   */
  getCleanupCandidates(entries: MemoryEntry[], maxCount = MAX_CLEANUP_PER_RUN): CleanupCandidate[] {
    const candidates: CleanupCandidate[] = []

    for (const entry of entries) {
      if (entry.tier === 'permanent' || entry.isPinned) continue
      if (entry.type !== 'user_fact') continue

      const utility = this.utilityTracker.computeUtilityScore(entry)

      // ── 行为加权乘数 ──
      let behaviorMultiplier: number | undefined
      let effectiveUtility = utility

      if (this.behaviorWeighting && entry.topics && entry.topics.length > 0) {
        behaviorMultiplier = this.behaviorWeighting.computeCleanupMultiplier(entry.topics)

        // 乘数调整 utility:
        //   - multiplier > 1   → 保护（effectiveUtility 升高，更难进入清理候选）
        //   - multiplier < 1   → 惩罚（effectiveUtility 降低，更容易进入清理候选）
        effectiveUtility = utility * behaviorMultiplier
      }

      if (effectiveUtility >= UTILITY_LOW_THRESHOLD) continue

      // 生成删除理由
      const reasons: string[] = []
      if (behaviorMultiplier !== undefined && behaviorMultiplier < BEHAVIOR_PENALTY_MULTIPLIER) {
        reasons.push('相关话题长期未关注')
      }
      if (utility < 0.1) reasons.push('效用极低')
      else reasons.push('效用过低')
      if (entry.agentReferenceCount === 0) reasons.push('从未被 Agent 引用')
      if (entry.accessCount <= 1) reasons.push('很少被访问')

      candidates.push({
        entry,
        reason: reasons.join('、'),
        behaviorMultiplier,
      })
    }

    // 按行为加权后的有效效用升序排列（最低优先）
    candidates.sort((a, b) => {
      const utilityA = this.utilityTracker.computeUtilityScore(a.entry)
      const utilityB = this.utilityTracker.computeUtilityScore(b.entry)
      const multA = a.behaviorMultiplier ?? 1
      const multB = b.behaviorMultiplier ?? 1
      return utilityA * multA - utilityB * multB
    })

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
    let protectedByBehavior = 0
    let penalizedByBehavior = 0
    const archiveEntries: Array<{ id: string; type: string; content: string; confidence: number; tier: string; reason: string }> = []

    // 1. 收集候选
    const allCandidates = this.getCleanupCandidates(entries)

    // 统计行为加权影响
    for (const c of allCandidates) {
      if (c.behaviorMultiplier !== undefined) {
        if (c.behaviorMultiplier >= BEHAVIOR_PROTECT_MULTIPLIER) protectedByBehavior++
        if (c.behaviorMultiplier <= BEHAVIOR_PENALTY_MULTIPLIER) penalizedByBehavior++
      }
    }
    this.pendingCandidates = allCandidates

    totalChecked = entries.length

    if (this.requireConfirmation && allCandidates.length > 0) {
      log('INFO', 'memory_cleaner_pending_confirmation', {
        count: allCandidates.length,
        behaviorWeightedCount: allCandidates.filter((c) => c.behaviorMultiplier !== undefined).length,
        candidates: allCandidates.map((c) => ({
          id: c.entry.id,
          content: c.entry.content.slice(0, 40),
          reason: c.reason,
          behaviorMultiplier: c.behaviorMultiplier?.toFixed(2),
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
      behaviorWeightingEnabled: this.behaviorWeighting !== null,
      protectedByBehavior,
      penalizedByBehavior,
    }

    if (removedCount > 0 || this.pendingCandidates.length > 0 || protectedByBehavior > 0 || penalizedByBehavior > 0) {
      log('INFO', 'memory_cleaner_run', {
        removed: removedCount,
        archived: archivedCount,
        pendingConfirmation: this.pendingCandidates.length,
        remaining: entries.length,
        behaviorWeightingEnabled: this.behaviorWeighting !== null,
        protectedByBehavior,
        penalizedByBehavior,
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
  getConfig(): {
    cleanupIntervalMs: number
    requireConfirmation: boolean
    behaviorWeightingEnabled: boolean
  } {
    return {
      cleanupIntervalMs: this.cleanupIntervalMs,
      requireConfirmation: this.requireConfirmation,
      behaviorWeightingEnabled: this.behaviorWeighting !== null,
    }
  }

  // ══════════════════════════════════════════
  //  快速清理（6 小时周期）
  // ══════════════════════════════════════════

  /**
   * 执行快速清理：直接归档长期未访问的低权重记忆，无需用户确认。
   *
   * 与 runCleanup() 不同：
   * - 不等待用户确认，直接归档
   * - 只针对同时满足"长期未访问"和"低效用"的记忆
   * - 每次清理数量更少（最多 10 条）
   * - 不触发 pendingCandidates 机制
   *
   * 判定条件：
   * 1. 不是 permanent 或 isPinned
   * 2. 类型为 user_fact
   * 3. 超过 7 天未访问
   * 4. 效用分数低于低效用阈值
   * 5. 行为得分低于初始值（已衰减）
   *
   * @param entries 所有记忆条目（会被修改）
   * @param removedIds 用以收集被删除 ID 的 Set
   * @returns 实际归档的条目数
   */
  quickCleanup(entries: MemoryEntry[], removedIds: Set<string>): number {
    const now = Date.now()
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
    const MAX_QUICK_CLEANUP = 10
    let removedCount = 0
    const archiveEntries: Array<{
      id: string
      type: string
      content: string
      confidence: number
      tier: string
      reason: string
    }> = []

    // 1. 定位候选
    const candidates = entries
      .filter((e) => {
        if (e.type !== 'user_fact') return false
        if (e.tier === 'permanent' || e.isPinned) return false

        // 长期未访问（7 天以上）
        if (e.lastAccessedAt <= 0) return false
        if (now - e.lastAccessedAt < SEVEN_DAYS_MS) return false

        // 低效用
        const utility = this.utilityTracker.computeUtilityScore(e)
        if (utility >= UTILITY_LOW_THRESHOLD) return false

        // 行为得分已低于初始值
        if (e.behaviorScore >= 0.5) return false

        return true
      })
      .sort((a, b) => {
        // 按最后访问时间升序（最久未访问的优先）
        return a.lastAccessedAt - b.lastAccessedAt
      })
      .slice(0, MAX_QUICK_CLEANUP)

    if (candidates.length === 0) return 0

    // 2. 直接归档（无需用户确认）
    for (const candidate of candidates) {
      const idx = entries.findIndex((e) => e.id === candidate.id)
      if (idx < 0) continue

      archiveEntries.push({
        id: candidate.id,
        type: candidate.type,
        content: candidate.content,
        confidence: candidate.confidence,
        tier: candidate.tier,
        reason: '快速清理：长期未访问（' + Math.floor((now - candidate.lastAccessedAt) / (1000 * 60 * 60 * 24)) + '天未使用）',
      })

      removedIds.add(candidate.id)
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
      } catch (err) {
        try {
          getRawDb().run('ROLLBACK')
        } catch {}
        log('ERROR', 'memory_quick_cleanup_archive_failed', { error: String(err) })
      }
    }

    log('INFO', 'memory_quick_cleanup_done', {
      removed: removedCount,
      totalChecked: entries.length + removedCount,
    })

    return removedCount
  }

  /** 更新配置 */
  updateConfig(config: {
    cleanupIntervalMs?: number
    requireConfirmation?: boolean
    behaviorWeighting?: BehaviorWeightingIntegration | null
  }): void {
    if (config.cleanupIntervalMs !== undefined) {
      this.cleanupIntervalMs = config.cleanupIntervalMs
    }
    if (config.requireConfirmation !== undefined) {
      this.requireConfirmation = config.requireConfirmation
    }
    if (config.behaviorWeighting !== undefined) {
      const wasEnabled = this.behaviorWeighting !== null
      this.behaviorWeighting = config.behaviorWeighting
      log('INFO', 'memory_cleaner_behavior_weighting_changed', {
        enabled: this.behaviorWeighting !== null,
        wasEnabled,
      })
    }
    log('INFO', 'memory_cleaner_config_updated', {
      cleanupIntervalMs: this.cleanupIntervalMs,
      requireConfirmation: this.requireConfirmation,
      behaviorWeightingEnabled: this.behaviorWeighting !== null,
    })
  }
}
