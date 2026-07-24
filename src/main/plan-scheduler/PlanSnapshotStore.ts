/**
 * PlanSnapshotStore — 计划上下文记忆快照管理
 *
 * 为每个并行计划创建独立上下文快照，在 Memory 中持久化任务状态、
 * 关键参数和下一步行动。支持自动创建、恢复和基于遗忘曲线的过期清理。
 *
 * 核心流程：
 *   1. 任务切换/批次完成 → 自动通过钩子创建快照
 *   2. 恢复计划 → 从 Memory 加载对应快照，重建任务状态
 *   3. 定期清理 → 基于遗忘曲线清除过期快照
 *
 * 设计原则：
 * - 快照以 MemoryEntry (type='plan_snapshot') 形式存在，利用现有记忆衰减机制
 * - 每个快照独立存储，互不干扰
 * - 使用 structuredData JSON 字段保存序列化的任务快照数据
 * - 通过行为得分和访问计数实现遗忘曲线式过期
 */

import { log } from '../logger/Logger'
import type { MemoryService } from '../memory/MemoryService'
import type { MemoryEntry } from '../memory/types'
import type { PlanTask, PlanTaskState, PlanSnapshotData, SerializedTaskSnapshot, SnapshotReason } from './types'

// ════════════════════════════════════════════════════════════════
//  配置
// ════════════════════════════════════════════════════════════════

export interface PlanSnapshotStoreConfig {
  /** 快照默认存活时间（毫秒），超过此时间且未被访问则被清理 */
  snapshotTTL: number
  /** 快照最低行为得分，低于此值且创建超过 24h 则被清理 */
  minBehaviorScore: number
  /** 每个计划最多保留的快照数 */
  maxSnapshotsPerPlan: number
  /** 快照创建时的初始置信度 */
  defaultConfidence: number
  /** 快照内容摘要的最大长度 */
  summaryMaxLength: number
}

const DEFAULT_CONFIG: PlanSnapshotStoreConfig = {
  snapshotTTL: 48 * 60 * 60 * 1000,   // 48 小时
  minBehaviorScore: 0.2,
  maxSnapshotsPerPlan: 5,
  defaultConfidence: 0.7,
  summaryMaxLength: 200,
}

// ════════════════════════════════════════════════════════════════
//  PlanSnapshotStore
// ════════════════════════════════════════════════════════════════

export class PlanSnapshotStore {
  private memoryService: MemoryService | null = null
  private config: PlanSnapshotStoreConfig

  constructor(config?: Partial<PlanSnapshotStoreConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 注入 MemoryService 实例。
   * 允许延迟注入，便于依赖解析。
   */
  setMemoryService(memoryService: MemoryService): void {
    this.memoryService = memoryService
  }

  /** 获取当前配置 */
  getConfig(): PlanSnapshotStoreConfig {
    return { ...this.config }
  }

  /**
   * 更新配置
   */
  updateConfig(partial: Partial<PlanSnapshotStoreConfig>): void {
    this.config = { ...this.config, ...partial }
  }

  // ── 快照创建 ──────────────────────────────────────────────

  /**
   * 从任务列表创建计划上下文快照并存入 Memory。
   * 利用 MemoryService 的 addEntry 方法创建类型为 'plan_snapshot' 的记忆条目，
   * 将序列化的任务数据存储在 structuredData 字段中。
   *
   * @param planId 计划 ID
   * @param planTitle 计划标题
   * @param tasks 当前任务列表（来自 PlanTaskEngine）
   * @param reason 快照触发原因
   * @returns 创建的 MemoryEntry ID，如失败则返回 null
   */
  createSnapshot(
    planId: string,
    planTitle: string,
    tasks: PlanTask[],
    reason: SnapshotReason,
  ): string | null {
    if (!this.memoryService) {
      log('WARN', 'plan_snapshot_store_no_memory', { planId })
      return null
    }

    const serialized = this.serializeTasks(tasks)
    const summary = this.computeSummary(tasks)
    const content = this.buildContent(planTitle, summary, reason)

    const snapshotData: PlanSnapshotData = {
      version: 1,
      planId,
      planTitle,
      tasks: serialized,
      summary,
      snapshotReason: reason,
      createdAt: Date.now(),
    }

    // 作为 plan_snapshot 类型条目存储，利用记忆系统的衰减和清理机制
    this.memoryService.addEntry('plan_snapshot', content, this.config.defaultConfidence, {
      tier: 'ephemeral',
      structuredData: JSON.stringify(snapshotData),
    })

    const entry = this.findLatestSnapshotEntry(planId)
    const entryId = entry?.id ?? 'unknown'

    log('INFO', 'plan_snapshot_created', {
      planId,
      planTitle,
      reason,
      taskCount: tasks.length,
      remainingCount: summary.remaining,
      entryId,
    })

    // 创建后自动执行容量管理（防止快照膨胀）
    this.enforceMaxSnapshotsPerPlan(planId)

    return entryId
  }

  // ── 快照恢复 ──────────────────────────────────────────────

  /**
   * 从指定 MemoryEntry 恢复任务状态。
   * 解析 structuredData JSON 并返回 PlanSnapshotData。
   * 恢复时自动强化相关记忆（增加行为得分和访问计数），
   * 符合遗忘曲线的"间隔重复"原则。
   *
   * @param entry MemoryEntry 对象（type='plan_snapshot'）
   * @returns 反序列化的快照数据，或 null（数据损坏时）
   */
  restoreFromEntry(entry: MemoryEntry): PlanSnapshotData | null {
    if (entry.type !== 'plan_snapshot' || !entry.structuredData) {
      log('WARN', 'plan_snapshot_restore_invalid_entry', { entryId: entry.id })
      return null
    }

    try {
      const data = JSON.parse(entry.structuredData) as PlanSnapshotData

      if (!data.planId || !data.tasks || !Array.isArray(data.tasks)) {
        log('WARN', 'plan_snapshot_restore_corrupted', { entryId: entry.id })
        return null
      }

      // 访问强化：通过 MemoryService 增强记忆留存（遗忘曲线复习）
      this.reinforceSnapshot(entry)

      log('INFO', 'plan_snapshot_restored', {
        planId: data.planId,
        tasks: data.tasks.length,
        reason: data.snapshotReason,
        entryId: entry.id,
      })

      return data
    } catch (err) {
      log('WARN', 'plan_snapshot_restore_parse_error', {
        entryId: entry.id,
        error: String(err),
      })
      return null
    }
  }

  /**
   * 从指定快照 ID 恢复任务状态。
   *
   * @param snapshotEntryId MemoryEntry ID
   * @returns 反序列化的快照数据，或 null
   */
  restoreById(snapshotEntryId: string): PlanSnapshotData | null {
    if (!this.memoryService) {
      log('WARN', 'plan_snapshot_restore_no_memory', { snapshotEntryId })
      return null
    }

    const entry = this.findSnapshotEntryById(snapshotEntryId)
    if (!entry) {
      log('WARN', 'plan_snapshot_entry_not_found', { snapshotEntryId })
      return null
    }

    return this.restoreFromEntry(entry)
  }

  /**
   * 从指定计划的最新快照恢复。
   * 适用于"任务中断后恢复"场景：找到最近一次快照，重建执行上下文。
   *
   * @param planId 计划 ID
   * @returns 反序列化的快照数据，或 null（无可用快照）
   */
  restoreLatest(planId: string): PlanSnapshotData | null {
    if (!this.memoryService) {
      log('WARN', 'plan_snapshot_restore_no_memory', { planId })
      return null
    }

    const entry = this.findLatestSnapshotEntry(planId)
    if (!entry) {
      log('INFO', 'plan_snapshot_no_snapshot', { planId })
      return null
    }

    return this.restoreFromEntry(entry)
  }

  // ── 查询 ──────────────────────────────────────────────────

  /**
   * 获取指定计划的所有快照条目（按时间降序，最新的在前）。
   */
  listPlanSnapshots(planId: string): MemoryEntry[] {
    if (!this.memoryService) return []

    return this.querySnapshotEntries()
      .filter((e) => {
        try {
          const data = e.structuredData ? JSON.parse(e.structuredData) : null
          return data?.planId === planId
        } catch {
          return false
        }
      })
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * 获取指定计划的快照数量。
   */
  getSnapshotCount(planId: string): number {
    return this.listPlanSnapshots(planId).length
  }

  /**
   * 检查指定计划是否有可恢复的快照。
   */
  hasSnapshot(planId: string): boolean {
    return this.findLatestSnapshotEntry(planId) !== null
  }

  // ── 清理 ──────────────────────────────────────────────────

  /**
   * 清理过期快照。
   *
   * 基于遗忘曲线规则的清理策略：
   * ┌────────────────────────────────────────────┬──────────┐
   * │ 条件                                       │ 操作     │
   * ├────────────────────────────────────────────┼──────────┤
   * │ 超过 TTL(48h) 且 访问次数 < 2              │ 删除     │
   * │ 行为得分 < 0.2 且 创建超过 24h             │ 删除     │
   * │ 超过 TTL(48h) 且 从未被访问                │ 删除     │
   * │ 同一计划快照超过 maxSnapshotsPerPlan(5)    │ 删除最旧 │
   * └────────────────────────────────────────────┴──────────┘
   *
   * 这种策略确保：
   * - 经常恢复的快照（访问次数多/行为得分高）得以保留
   * - 一次性使用后遗忘的快照自动清理
   * - 每计划快照数量有上限，防止快照膨胀
   *
   * @returns 被清理的条目数
   */
  cleanupExpiredSnapshots(): number {
    if (!this.memoryService) return 0

    const now = Date.now()
    const oneDayMs = 24 * 60 * 60 * 1000
    let removedCount = 0

    const snapshotEntries = this.querySnapshotEntries()

    // 1. 基于遗忘曲线规则的清理
    for (const entry of snapshotEntries) {
      const age = now - entry.createdAt
      let shouldRemove = false

      // 超过 TTL 且几乎未被访问（一次性使用后遗忘）
      if (age > this.config.snapshotTTL && entry.accessCount < 2) {
        shouldRemove = true
      }

      // 行为得分低且已创建 24h 以上（自然遗忘）
      if (entry.behaviorScore < this.config.minBehaviorScore && age > oneDayMs) {
        shouldRemove = true
      }

      // 创建超过 TTL 但从未被访问的孤立快照
      if (age > this.config.snapshotTTL && entry.accessCount === 0) {
        shouldRemove = true
      }

      if (shouldRemove) {
        this.removeSnapshotEntry(entry.id)
        removedCount++
      }
    }

    // 2. 超出每个计划容量限制的清理
    if (removedCount >= 0) {
      const planGroups = this.groupSnapshotsByPlan()
      for (const [, entries] of planGroups) {
        if (entries.length > this.config.maxSnapshotsPerPlan) {
          // 保留最新的 N 个，删除其余
          const sorted = [...entries].sort((a, b) => a.createdAt - b.createdAt)
          const toRemove = sorted.slice(0, sorted.length - this.config.maxSnapshotsPerPlan)
          for (const entry of toRemove) {
            this.removeSnapshotEntry(entry.id)
            removedCount++
          }
        }
      }
    }

    if (removedCount > 0) {
      log('INFO', 'plan_snapshot_cleanup', {
        removedCount,
        remainingCount: this.querySnapshotEntries().length,
      })
    }

    return removedCount
  }

  /**
   * 删除指定计划的所有快照。
   *
   * @returns 被删除的条目数
   */
  clearPlanSnapshots(planId: string): number {
    if (!this.memoryService) return 0

    const snapshots = this.listPlanSnapshots(planId)
    for (const entry of snapshots) {
      this.removeSnapshotEntry(entry.id)
    }

    log('INFO', 'plan_snapshot_cleared', { planId, removedCount: snapshots.length })
    return snapshots.length
  }

  // ── 内部方法 ──────────────────────────────────────────────

  /**
   * 序列化 PlanTask[] 为可存储的 JSON 结构。
   * 只保留可序列化的字段，排除运行时瞬态数据。
   */
  private serializeTasks(tasks: PlanTask[]): SerializedTaskSnapshot[] {
    return tasks.map((t) => ({
      id: t.id,
      stepIndex: t.stepIndex,
      description: t.description,
      state: t.state,
      analysis: t.analysis,
      activeTool: t.activeTool,
      activeArgs: t.activeArgs,
      attemptCount: t.attemptCount,
      maxAttempts: t.maxAttempts,
      lastError: t.lastError,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
      durationMs: t.durationMs,
      dependsOnTaskIds: t.dependsOnTaskIds,
      output: t.output,
    }))
  }

  /**
   * 计算任务执行摘要。
   */
  private computeSummary(tasks: PlanTask[]): PlanSnapshotData['summary'] {
    const terminal = new Set<PlanTaskState>(['completed', 'skipped', 'cancelled', 'failed'])
    return {
      total: tasks.length,
      completed: tasks.filter((t) => t.state === 'completed').length,
      failed: tasks.filter((t) => t.state === 'failed').length,
      skipped: tasks.filter((t) => t.state === 'skipped').length,
      cancelled: tasks.filter((t) => t.state === 'cancelled').length,
      remaining: tasks.filter((t) => !terminal.has(t.state)).length,
    }
  }

  /**
   * 构建快照的人类可读摘要，用作 MemoryEntry.content。
   */
  private buildContent(planTitle: string, summary: PlanSnapshotData['summary'], reason: SnapshotReason): string {
    const reasonMap: Record<SnapshotReason, string> = {
      batch_complete: '批次完成时',
      pause: '暂停时',
      task_switch: '任务切换时',
      manual: '手动创建',
    }
    const parts = [
      `【计划快照】${planTitle}`,
      `触发：${reasonMap[reason]}`,
      `进度：${summary.completed}/${summary.total} 完成, ${summary.remaining} 待处理`,
    ]
    if (summary.failed > 0) parts.push(`${summary.failed} 失败`)
    if (summary.skipped > 0) parts.push(`${summary.skipped} 跳过`)

    return parts.join(' | ').slice(0, this.config.summaryMaxLength)
  }

  /**
   * 访问强化：通过 MemoryService 增强记忆留存。
   * 模拟"间隔重复"的复习效果：每次恢复快照时增加行为得分和访问计数。
   */
  private reinforceSnapshot(entry: MemoryEntry): void {
    if (!this.memoryService) return

    // 使用 addEntry 的精确去重逻辑：同 type+content 会触发强化而非新建
    // 这等价于一次"复习"，增加 reinforceCount 和置信度
    this.memoryService.addEntry(
      'plan_snapshot',
      entry.content,
      entry.confidence,
      { tier: entry.tier, structuredData: entry.structuredData },
    )
  }

  /**
   * 从 MemoryService 获取所有 plan_snapshot 类型的条目。
   */
  private querySnapshotEntries(): MemoryEntry[] {
    if (!this.memoryService) return []
    return this.memoryService.getEntriesByType('plan_snapshot')
  }

  /**
   * 查找指定计划的最新快照条目。
   */
  private findLatestSnapshotEntry(planId: string): MemoryEntry | null {
    const snapshots = this.listPlanSnapshots(planId)
    return snapshots.length > 0 ? snapshots[0] : null
  }

  /**
   * 按 ID 查找快照条目。
   */
  private findSnapshotEntryById(entryId: string): MemoryEntry | null {
    const entries = this.querySnapshotEntries()
    return entries.find((e) => e.id === entryId) ?? null
  }

  /**
   * 移除指定 ID 的 MemoryEntry。
   */
  private removeSnapshotEntry(entryId: string): void {
    if (!this.memoryService) return
    this.memoryService.removeEntryById(entryId)
  }

  /**
   * 按 planId 分组快照条目。
   * 从 structuredData 中解析 planId 进行分组。
   */
  private groupSnapshotsByPlan(): Map<string, MemoryEntry[]> {
    const groups = new Map<string, MemoryEntry[]>()
    for (const entry of this.querySnapshotEntries()) {
      try {
        const data = entry.structuredData ? JSON.parse(entry.structuredData) : null
        const planId = data?.planId as string | undefined
        if (planId) {
          const list = groups.get(planId) ?? []
          list.push(entry)
          groups.set(planId, list)
        }
      } catch {
        // 跳过 JSON 损坏的条目
      }
    }
    return groups
  }

  /**
   * 确保每个计划的快照不超过上限。
   * 超出时删除最旧的快照。
   */
  private enforceMaxSnapshotsPerPlan(planId: string): void {
    const entries = this.listPlanSnapshots(planId)
    if (entries.length > this.config.maxSnapshotsPerPlan) {
      // 保留最新的 N 个
      const toRemove = entries.slice(this.config.maxSnapshotsPerPlan)
      for (const entry of toRemove) {
        this.removeSnapshotEntry(entry.id)
      }
      log('INFO', 'plan_snapshot_enforce_capacity', {
        planId,
        removed: toRemove.length,
        maxSnapshotsPerPlan: this.config.maxSnapshotsPerPlan,
      })
    }
  }
}
