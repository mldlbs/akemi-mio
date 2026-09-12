/**
 * TaskMemoryCleaner — 任务步骤记忆过期策略与清理
 *
 * 职责：
 * 1. 定期扫描过期的任务步骤（task_step）记忆条目
 * 2. 已完成/已放弃的任务步骤超过 TTL 后降级到 ephemeral 层，自然衰减
 * 3. 中断任务（active/paused）保留完整记录（不受过期影响）
 * 4. 提供预览和配置接口
 *
 * 集成点：
 * - MemoryService 的定时衰减循环中调用
 * - MemoryCleaner 的清理循环中调用
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { MemoryEntry } from './types'

// ══════════════════════════════════════════
//  配置常量
// ══════════════════════════════════════════

/** 已完成任务步骤的默认 TTL（天） */
const DEFAULT_COMPLETED_TTL_DAYS = 7

/** 已放弃任务步骤的默认 TTL（天） */
const DEFAULT_ABANDONED_TTL_DAYS = 3

/** 中断任务步骤保护期（天）— 此期间内的步骤不受影响 */
const DEFAULT_ACTIVE_PROTECTION_DAYS = 30

/** 每次清理最多处理的步骤数 */
const MAX_CLEANUP_PER_RUN = 100

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

export interface TaskMemoryCleanerConfig {
  /** 已完成任务步骤 TTL（天） */
  completedTtlDays: number
  /** 已放弃任务步骤 TTL（天） */
  abandonedTtlDays: number
  /** 中断任务保护期（天） */
  activeProtectionDays: number
}

export interface TaskCleanupReport {
  /** 清理时间 */
  timestamp: number
  /** 检查的任务步骤总数 */
  totalChecked: number
  /** 降级到 ephemeral 的步骤数 */
  demotedCount: number
  /** 直接删除的步骤数 */
  removedCount: number
  /** 受保护的中断任务步骤数 */
  protectedCount: number
}

// ══════════════════════════════════════════
//  任务步骤结构化数据
// ══════════════════════════════════════════

/** 任务步骤的 structuredData 形状（与 TaskStepRecorder 中的 TaskStepRecord 一致） */
interface TaskStepRecordData {
  stepIndex: number
  sessionId: string
  taskId?: string
  toolName: string
  timestamp: number
  toolSuccess: boolean
  [key: string]: unknown
}

// ══════════════════════════════════════════
//  TaskMemoryCleaner
// ══════════════════════════════════════════

export class TaskMemoryCleaner {
  private config: TaskMemoryCleanerConfig

  constructor(config?: Partial<TaskMemoryCleanerConfig>) {
    this.config = {
      completedTtlDays: config?.completedTtlDays ?? DEFAULT_COMPLETED_TTL_DAYS,
      abandonedTtlDays: config?.abandonedTtlDays ?? DEFAULT_ABANDONED_TTL_DAYS,
      activeProtectionDays: config?.activeProtectionDays ?? DEFAULT_ACTIVE_PROTECTION_DAYS,
    }
  }

  // ══════════════════════════════════════════
  //  配置管理
  // ══════════════════════════════════════════

  getConfig(): TaskMemoryCleanerConfig {
    return { ...this.config }
  }

  updateConfig(partial: Partial<TaskMemoryCleanerConfig>): void {
    if (partial.completedTtlDays !== undefined) this.config.completedTtlDays = partial.completedTtlDays
    if (partial.abandonedTtlDays !== undefined) this.config.abandonedTtlDays = partial.abandonedTtlDays
    if (partial.activeProtectionDays !== undefined) this.config.activeProtectionDays = partial.activeProtectionDays
    log('INFO', 'task_memory_cleaner_config_updated', { config: this.config })
  }

  // ══════════════════════════════════════════
  //  清理执行
  // ══════════════════════════════════════════

  /**
   * 执行任务步骤过期清理。
   *
   * 规则：
   * - 任务步骤关联的 taskId 在 activeTasks 集合中 → 保护（不过期）
   * - 其他 task_step：检查 timestamp 是否超过 TTL
   *   - 未超过 → 保留
   *   - 超过 → 降级到 ephemeral 层（自然衰减）
   *
   * @param entries 所有记忆条目（会被修改）
   * @param activeTaskIds 当前活跃的任务 ID 集合（受保护，不过期）
   * @returns 清理报告
   */
  runCleanup(entries: MemoryEntry[], activeTaskIds: Set<string>): TaskCleanupReport {
    const now = Date.now()
    let totalChecked = 0
    let demotedCount = 0
    const removedCount = 0
    let protectedCount = 0

    const completedMs = this.config.completedTtlDays * 24 * 60 * 60 * 1000
    const abandonedMs = this.config.abandonedTtlDays * 24 * 60 * 60 * 1000

    for (const entry of entries) {
      if (entry.type !== 'task_step') continue
      totalChecked++

      // 跳过没有 structuredData 的条目
      if (!entry.structuredData) continue

      let record: TaskStepRecordData | null = null
      try {
        record = JSON.parse(entry.structuredData) as TaskStepRecordData
      } catch {
        continue
      }

      // 跳过没有 timestamp 的记录
      if (!record.timestamp) continue

      const age = now - record.timestamp

      // 如果有关联的 taskId 且不在活跃任务中 → 应用 TTL
      if (record.taskId) {
        if (activeTaskIds.has(record.taskId)) {
          // 活跃任务 → 受保护
          protectedCount++
          continue
        }

        // 不在活跃任务中 → 应用已完成/已放弃 TTL
        // 默认使用 "completed" TTL（7天），因为没有状态信息
        const ttlMs = completedMs
        if (age > ttlMs) {
          // 超过 TTL，降级到 ephemeral
          entry.tier = 'ephemeral'
          entry.updatedAt = now
          demotedCount++
          log('DEBUG', 'task_step_demoted', {
            toolName: record.toolName,
            taskId: record.taskId,
            ageDays: Math.round(age / (24 * 60 * 60 * 1000)),
            ttlDays: this.config.completedTtlDays,
          })
        }
      } else {
        // 没有 taskId 的步骤：使用较短的 TTL（废弃 TTL）
        if (age > abandonedMs) {
          entry.tier = 'ephemeral'
          entry.updatedAt = now
          demotedCount++
        }
      }
    }

    if (demotedCount > 0 || protectedCount > 0) {
      log('INFO', 'task_memory_cleaner_run', {
        totalChecked,
        demoted: demotedCount,
        removed: removedCount,
        protected: protectedCount,
      })
    }

    return {
      timestamp: now,
      totalChecked,
      demotedCount,
      removedCount,
      protectedCount,
    }
  }

  /**
   * 预览将要被清理的步骤。
   * 不实际修改条目。
   */
  previewCleanup(
    entries: MemoryEntry[],
    activeTaskIds: Set<string>,
  ): Array<{
    entryId: string
    content: string
    ageDays: number
    reason: string
  }> {
    const now = Date.now()
    const completedMs = this.config.completedTtlDays * 24 * 60 * 60 * 1000
    const abandonedMs = this.config.abandonedTtlDays * 24 * 60 * 60 * 1000
    const candidates: Array<{
      entryId: string
      content: string
      ageDays: number
      reason: string
    }> = []

    for (const entry of entries) {
      if (entry.type !== 'task_step' || !entry.structuredData) continue

      let record: TaskStepRecordData | null = null
      try {
        record = JSON.parse(entry.structuredData) as TaskStepRecordData
      } catch {
        continue
      }
      if (!record.timestamp) continue

      const age = now - record.timestamp

      if (record.taskId && activeTaskIds.has(record.taskId)) continue

      const ttlMs = record.taskId ? completedMs : abandonedMs
      if (age > ttlMs) {
        candidates.push({
          entryId: entry.id,
          content: entry.content.slice(0, 80),
          ageDays: Math.round(age / (24 * 60 * 60 * 1000)),
          reason: record.taskId ? '已完成任务超过 TTL' : '无关联任务超过 TTL',
        })
      }
    }

    candidates.sort((a, b) => b.ageDays - a.ageDays)
    return candidates.slice(0, MAX_CLEANUP_PER_RUN)
  }
}
