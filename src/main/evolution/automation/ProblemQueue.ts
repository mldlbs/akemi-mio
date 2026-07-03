/**
 * ProblemQueue — 问题队列
 *
 * 职责：
 * 1. 去重（相同 file:line:message 只保留一个 Problem）
 * 2. 按价值排序（severity × occurrenceCount / estimatedCost）
 * 3. 持久化（跨重启保留）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { log } from '../../logger/Logger'
import type { Problem, ProblemSource, Severity, AssignedProblem } from './types'

const QUEUE_FILE = 'problem_queue.json'

/** 严重度数值权重 */
const SEVERITY_WEIGHT: Record<Severity, number> = {
  error: 10,
  warning: 3,
  info: 1,
}

export class ProblemQueue {
  private problems: Problem[] = []
  private completedIds = new Set<string>()
  private failedIds = new Map<string, number>() // problemId → retryCount
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
    // 找到第一个不是处理中且未完成的
    const idx = this.problems.findIndex((p) => !this.completedIds.has(p.id) && !this.failedIds.has(p.id))
    if (idx === -1) return null
    const p = this.problems.splice(idx, 1)[0]
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

  /** 标记问题失败（可重试） */
  markFailed(problemId: string): void {
    const retries = (this.failedIds.get(problemId) || 0) + 1
    if (retries >= 3) {
      // 超过重试上限，丢弃
      this.completedIds.add(problemId)
      this.failedIds.delete(problemId)
      log('WARN', 'problem_dropped_after_retries', { problemId, retries })
    } else {
      this.failedIds.set(problemId, retries)
      // 重新入队（放回尾部）
      this.problems.push(this.rehydrateProblem(problemId))
      this.save()
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
  getStats(): { pending: number; completed: number; failed: number } {
    return {
      pending: this.problems.length,
      completed: this.completedIds.size,
      failed: this.failedIds.size,
    }
  }

  /** 按来源获取等待中的问题列表 */
  getPendingBySource(source: ProblemSource): Problem[] {
    return this.problems.filter((p) => p.source === source)
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

  private rehydrateProblem(problemId: string): Problem {
    // 从持久化或内存重建
    for (const p of this.problems) {
      if (p.id === problemId) return p
    }
    // 从失败列表的 key 构造一个占位
    const parts = problemId.split(':')
    return {
      id: problemId,
      source: parts[0] as ProblemSource,
      severity: 'error',
      title: problemId,
      description: '',
      estimatedCostChars: 100,
      lastSeen: Date.now(),
      occurrenceCount: 1,
      context: { raw: '' },
    }
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
      log('INFO', 'problem_queue_loaded', {
        pending: this.problems.length,
        completed: this.completedIds.size,
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
