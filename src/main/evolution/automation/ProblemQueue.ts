/**
 * ProblemQueue — 问题队列
 *
 * 职责：
 * 1. 去重（相同 file:line:message 只保留一个 Problem）
 * 2. 按价值排序（severity × occurrenceCount / estimatedCost）
 * 3. 持久化（跨重启保留）
 * 4. 【MCP 模式迁移】集成 ProblemErrorType + ProblemFixCache：
 *    - markFailed() 时分类错误类型，不可修复类型直接丢弃
 *    - 可缓存类型记入 ProblemFixCache 避免重复尝试
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { log } from '../../logger/Logger'
import { classifyProblemError, shouldRetryOnError, shouldCacheErrorType, ProblemErrorType } from './ProblemErrorType'
import { problemFixCache } from './ProblemFixCache'
import type { Problem, ProblemSource, Severity, AssignedProblem } from './types'

const QUEUE_FILE = 'problem_queue.json'

/** 严重度数值权重 */
const SEVERITY_WEIGHT: Record<Severity, number> = {
  error: 10,
  warning: 3,
  info: 1,
}

/** 修复失败时的默认错误消息（无显式错误时使用） */
const DEFAULT_FAIL_MESSAGE = 'Fix attempt failed with no specific error'

export class ProblemQueue {
  private problems: Problem[] = []
  private completedIds = new Set<string>()
  private failedIds = new Map<string, number>()
  /** Phase 3C: skipped/blocked by governance gate */
  private skippedIds = new Set<string>()
  private blockedIds = new Set<string>()
  /** Processing cache for markFailed() reconstruction */
  private processingProblems = new Map<string, Problem>()
  private queuePath: string

  constructor(persistDir: string) {
    this.queuePath = join(persistDir, QUEUE_FILE)
    this.load()
  }

  /** 批量插入新问题（自动去重） */
  push(problems: Problem[]): number {
    let added = 0
    for (const p of problems) {
      const dup = this.findDuplicate(p)
      if (dup) {
        dup.occurrenceCount++
        dup.lastSeen = Math.max(dup.lastSeen, p.lastSeen)
        continue
      }
      if (this.completedIds.has(p.id)) continue
      if (this.skippedIds.has(p.id)) continue
      if (this.blockedIds.has(p.id)) continue
      this.problems.push(p)
      added++
    }
    this.sort()
    this.save()
    return added
  }

  /** 取下一个最高优先级的问题 */
  pop(): AssignedProblem | null {
    const now = Date.now()
    // 跳过所有已完结状态：completed / failed / skipped / blocked
    const idx = this.problems.findIndex(
      (p) =>
        !this.completedIds.has(p.id) &&
        !this.failedIds.has(p.id) &&
        !this.skippedIds.has(p.id) &&
        !this.blockedIds.has(p.id),
    )
    if (idx === -1) return null
    const p = this.problems.splice(idx, 1)[0]
    // 暂存以支持 markFailed() 重建完整信息
    this.processingProblems.set(p.id, p)
    const retries = this.failedIds.get(p.id) || 0
    this.save()
    return {
      ...p,
      attempt: retries + 1,
      assignedAt: now,
    }
  }

  /** 标记问题已修复 */
  markCompleted(problemId: string): void {
    this.completedIds.add(problemId)
    this.failedIds.delete(problemId)
    this.save()
  }

  /** 标记问题由治理策略跳过（不进入 executor，不影响 retry） */
  skip(problemId: string): void {
    this.skippedIds.add(problemId)
    this.processingProblems.delete(problemId)
    this.save()
  }

  /** 标记问题由治理策略阻断（不进入 executor，不影响 retry） */
  block(problemId: string): void {
    this.blockedIds.add(problemId)
    this.processingProblems.delete(problemId)
    this.save()
  }

  /**
   * 标记问题失败（可重试）
   *
   * 【MCP 模式迁移】集成错误分类逻辑：
   * - 使用 classifyProblemError() 判断错误类型
   * - UNFIXABLE/ENVIRONMENT 类型 → 直接丢弃，不浪费重试
   * - 可缓存类型 → 记入 ProblemFixCache 避免后续重复尝试
   * - TRANSIENT/TIMEOUT → 按原有重试策略
   * - REGRESSION → 丢弃（应走回滚路径，不在队列重试）
   *
   * @param problemId 问题 ID
   * @param errorMessage 失败错误消息（可选，用于错误分类）
   */
  markFailed(problemId: string, errorMessage?: string): void {
    const original = this.findProblemById(problemId) || this.processingProblems.get(problemId)
    // 从处理中缓存移除
    this.processingProblems.delete(problemId)

    // 分类错误类型
    const errMsg = errorMessage || original?.context?.raw || DEFAULT_FAIL_MESSAGE
    const errorType = classifyProblemError(errMsg)

    // 检查缓存：记录不可修复类型到 ProblemFixCache
    if (shouldCacheErrorType(errorType) && original) {
      problemFixCache.record(original.source, original.title, errMsg)
    }

    // 不可重试类型 → 直接丢弃（不浪费重试次数）
    if (!shouldRetryOnError(errorType)) {
      this.completedIds.add(problemId)
      this.failedIds.delete(problemId)
      log('INFO', 'problem_dropped_unfixable', {
        problemId,
        errorType,
        reason: errMsg.slice(0, 120),
      })
      this.save()
      return
    }

    const retries = (this.failedIds.get(problemId) || 0) + 1
    if (retries >= 3) {
      // 超过重试上限，丢弃
      this.completedIds.add(problemId)
      this.failedIds.delete(problemId)
      log('WARN', 'problem_dropped_after_retries', { problemId, retries, errorType })
    } else {
      this.failedIds.set(problemId, retries)
      if (original) {
        // 用完整信息重新入队
        this.problems.push({ ...original })
      } else {
        this.problems.push(this.buildPlaceholderProblem(problemId))
      }
      this.save()
    }
  }

  /** 查找仍在队列中的完整问题 */
  private findProblemById(problemId: string): Problem | undefined {
    for (const p of this.problems) {
      if (p.id === problemId) return p
    }
    return undefined
  }

  /** 构造最小占位 — 引用不在队列中的 problemId（通常不应该发生） */
  private buildPlaceholderProblem(problemId: string): Problem {
    const parts = problemId.split(':')
    return {
      id: problemId,
      source: (parts[0] as ProblemSource) || 'tsc',
      severity: 'error',
      title: problemId,
      description: '',
      estimatedCostChars: 100,
      lastSeen: Date.now(),
      occurrenceCount: 1,
      context: { raw: '' },
    }
  }

  /** 队列是否为空 */
  get isEmpty(): boolean {
    return this.problems.length === 0
  }

  /** 当前待处理数量 */
  get size(): number {
    return this.problems.length
  }

  /** 今日已修复数量 */
  get completedCount(): number {
    const today = new Date().setHours(0, 0, 0, 0)
    return 0 // 简化：用持久化次数
  }

  /** 获取问题统计 */
  getStats(): { pending: number; completed: number; failed: number; skipped: number; blocked: number } {
    return {
      pending: this.problems.length,
      completed: this.completedIds.size,
      failed: this.failedIds.size,
      skipped: this.skippedIds.size,
      blocked: this.blockedIds.size,
    }
  }

  /** 按来源获取等待中的问题列表 */
  getPendingBySource(source: ProblemSource): Problem[] {
    return this.problems.filter((p) => p.source === source)
  }

  /**
   * 【MCP 模式迁移】清除已知不可修复的问题
   *
   * 检查 ProblemFixCache 缓存，移除所有匹配的待处理问题。
   * 应在 pop() 之前调用，避免尝试修复已知的不可修复问题。
   *
   * @returns 移除的问题数量
   */
  skipCachedUnfixable(): number {
    const before = this.problems.length
    const toRemove: string[] = []

    for (const p of this.problems) {
      const cacheReason = problemFixCache.check(p.source, p.title, p.context.raw || '')
      if (cacheReason !== null) {
        toRemove.push(p.id)
        log('INFO', 'problem_skipped_cached', {
          problemId: p.id,
          source: p.source,
          title: p.title.slice(0, 60),
          reason: cacheReason,
        })
      }
    }

    for (const id of toRemove) {
      this.completedIds.add(id)
    }
    this.problems = this.problems.filter((p) => !toRemove.includes(p.id))

    if (toRemove.length > 0) {
      log('INFO', 'problem_queue_skipped_unfixable', { count: toRemove.length })
      this.save()
    }

    return toRemove.length
  }

  /**
   * 将队列中某来源的问题与最新采集结果对齐：
   * - 仍在 freshIds 中的 → 保留
   * - 不在 freshIds 中的 → 标记为已完成（已过期）
   * 返回值: 移除的数量
   */
  reconcile(source: ProblemSource, freshIds: Set<string>): number {
    const before = this.problems.length
    // 该来源的、不在 freshIds 中的问题 → 标记完成
    const toRemove = this.problems.filter((p) => p.source === source && !freshIds.has(p.id))
    for (const p of toRemove) {
      this.completedIds.add(p.id)
    }
    this.problems = this.problems.filter((p) => !(p.source === source && !freshIds.has(p.id)))
    const removed = before - this.problems.length
    if (removed > 0) {
      log('INFO', 'problem_queue_reconciled', { source, removed, remaining: this.problems.length })
      this.save()
    }
    return removed
  }

  // ── private ──

  private findDuplicate(p: Problem): Problem | undefined {
    return this.problems.find((existing) => existing.source === p.source && existing.file === p.file && existing.line === p.line)
  }

  private sort(): void {
    this.problems.sort((a, b) => {
      const scoreA = SEVERITY_WEIGHT[a.severity] * a.occurrenceCount
      const scoreB = SEVERITY_WEIGHT[b.severity] * b.occurrenceCount
      return scoreB - scoreA // 高分在前
    })
  }

  private load(): void {
    try {
      if (!existsSync(this.queuePath)) return
      const raw = readFileSync(this.queuePath, 'utf-8')
      const data = JSON.parse(raw)
      if (Array.isArray(data.problems)) this.problems = data.problems
      if (Array.isArray(data.completedIds)) this.completedIds = new Set(data.completedIds)
      if (data.failedIds) {
        this.failedIds = new Map(Object.entries(data.failedIds))
      }
      if (Array.isArray(data.skippedIds)) this.skippedIds = new Set(data.skippedIds)
      if (Array.isArray(data.blockedIds)) this.blockedIds = new Set(data.blockedIds)
      if (data.processingProblems) {
        this.processingProblems = new Map(Object.entries(data.processingProblems))
      }
      // 清理空壳问题（title === id 表示 buildPlaceholderProblem 产生的损坏条目）
      const before = this.problems.length
      this.problems = this.problems.filter((p) => p.title !== p.id)
      if (this.problems.length < before) {
        log('WARN', 'problem_queue_cleanup', { removed: before - this.problems.length })
      }
      log('INFO', 'problem_queue_loaded', {
        pending: this.problems.length,
        completed: this.completedIds.size,
        skipped: this.skippedIds.size,
        blocked: this.blockedIds.size,
      })
    } catch {
      log('WARN', 'problem_queue_load_failed')
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.queuePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(
        this.queuePath,
        JSON.stringify(
          {
            problems: this.problems,
            completedIds: Array.from(this.completedIds),
            failedIds: Object.fromEntries(this.failedIds),
            skippedIds: Array.from(this.skippedIds),
            blockedIds: Array.from(this.blockedIds),
            updatedAt: Date.now(),
          },
          null,
          2,
        ),
        'utf-8',
      )
    } catch {
      log('WARN', 'problem_queue_save_failed')
    }
  }
}
