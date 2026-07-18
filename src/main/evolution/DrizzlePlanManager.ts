import { getRawDb, markDirty } from '../db/connection'
import { eventBus } from '../core/EventBus'
import { AsyncLock } from '../utils/AsyncLock'
import { log } from '../logger/Logger'
import type { DevPlan, PlanStep } from './types'

let idCounter = 0

interface PlanRow {
  id: string
  title: string
  description: string
  status: string
  reflection: string | null
  created_at: number
  updated_at: number
}

interface StepRow {
  id: string
  plan_id: string
  step_index: number
  description: string
  status: string
  result: string | null
}

function rowToPlan(r: PlanRow): {
  id: string
  title: string
  description: string
  status: DevPlan['status']
  reflection?: string
  createdAt: number
  updatedAt: number
} {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status as DevPlan['status'],
    reflection: r.reflection ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function rowToStep(r: StepRow): PlanStep {
  return {
    id: r.id,
    description: r.description,
    status: r.status as PlanStep['status'],
    result: r.result ?? undefined,
  }
}

/** 安全获取数据库实例，未初始化时返回 null */
function tryDb(): ReturnType<typeof getRawDb> | null {
  try {
    return getRawDb()
  } catch {
    return null
  }
}

export class DrizzlePlanManager {
  readonly lock: AsyncLock = new AsyncLock()

  /** 当前活跃计划上限 */
  static readonly MAX_ACTIVE_PLANS = 3

  createPlan(title: string, description: string, stepDescriptions: string[], priority?: number): DevPlan {
    const existing = this.getActivePlanByTitle(title)
    if (existing) {
      log('INFO', 'plan_duplicate_skipped', { plan_id: existing.id, title })
      return existing
    }

    // 计划膨胀治理：活跃计划上限检查（最多 3 个）
    const activeCount = this.listActivePlans().length
    if (activeCount >= DrizzlePlanManager.MAX_ACTIVE_PLANS) {
      const msg = `活跃计划已达上限（${activeCount}/${DrizzlePlanManager.MAX_ACTIVE_PLANS}）。请先完成或放弃现有计划。`
      log('WARN', 'plan_limit_exceeded', { active_count: activeCount, max: DrizzlePlanManager.MAX_ACTIVE_PLANS })
      throw new Error(msg)
    }

    const db = tryDb()
    if (!db) {
      const plan = this.createInMemoryPlan(title, description, stepDescriptions, Date.now(), priority)
      return plan
    }
    const planId = `plan_${Date.now()}_${++idCounter}`
    const now = Date.now()

    db.run('INSERT INTO plans (id, title, description, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      planId,
      title,
      description,
      'active',
      priority ?? 0,
      now,
      now,
    ])

    const stepRows = stepDescriptions.map((desc, i) => {
      const stepId = `step_${i}_${Date.now()}`
      db.run('INSERT INTO plan_steps (id, plan_id, step_index, description, status) VALUES (?, ?, ?, ?, ?)', [
        stepId,
        planId,
        i,
        desc,
        'pending',
      ])
      return { id: stepId, description: desc, status: 'pending' as const }
    })

    markDirty()

    const devPlan: DevPlan = {
      id: planId,
      title,
      description,
      steps: stepRows,
      status: 'active',
      priority: priority ?? 0,
      createdAt: now,
      updatedAt: now,
    }

    eventBus.emit('agent.plan.created', { planId, title })
    log('INFO', 'plan_created', { plan_id: planId, title, steps: stepDescriptions.length })
    return devPlan
  }

  getPlan(id: string): DevPlan | undefined {
    const db = tryDb()
    if (!db) return undefined
    const stmt = db.prepare('SELECT * FROM plans WHERE id = ?')
    stmt.bind([id])
    if (!stmt.step()) {
      stmt.free()
      return undefined
    }
    const row = stmt.getAsObject() as unknown as PlanRow
    stmt.free()
    return this.hydratePlan(row)
  }

  getActivePlan(): DevPlan | undefined {
    const db = tryDb()
    if (!db) return undefined
    const stmt = db.prepare('SELECT * FROM plans WHERE status = ? ORDER BY created_at DESC LIMIT 1')
    stmt.bind(['active'])
    if (!stmt.step()) {
      stmt.free()
      return undefined
    }
    const row = stmt.getAsObject() as unknown as PlanRow
    stmt.free()
    return this.hydratePlan(row)
  }

  /** 标题相似度阈值 (0-1)，低于此值视为重复计划 */
  private static readonly TITLE_SIMILARITY_THRESHOLD = 0.75

  /** 归一化标题：去空格、转小写、去标点 */
  private normalizeTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[\s\p{P}]+/gu, ' ')
      .trim()
  }

  /** 计算两个规范化标题的 Dice 系数相似度 */
  private titleSimilarity(a: string, b: string): number {
    if (a === b) return 1.0
    const aWords = new Set(a.split(' '))
    const bWords = new Set(b.split(' '))
    if (aWords.size === 0 || bWords.size === 0) return 0
    let intersection = 0
    for (const w of aWords) if (bWords.has(w)) intersection++
    return (2 * intersection) / (aWords.size + bWords.size)
  }

  /** 精确匹配：数据库层查询活跃计划标题 */
  private findExactTitleMatch(title: string): DevPlan | undefined {
    const db = tryDb()
    if (!db) return undefined
    const stmt = db.prepare('SELECT * FROM plans WHERE title = ? AND status = ? LIMIT 1')
    stmt.bind([title, 'active'])
    if (!stmt.step()) {
      stmt.free()
      return undefined
    }
    const row = stmt.getAsObject() as unknown as PlanRow
    stmt.free()
    return this.hydratePlan(row)
  }

  /** 检查是否有标题相似度超过阈值的活跃计划 */
  private findSimilarActivePlan(title: string): DevPlan | undefined {
    const normalized = this.normalizeTitle(title)
    if (!normalized) return undefined
    return this.listActivePlans().find(
      (p) => this.titleSimilarity(this.normalizeTitle(p.title), normalized) >= DrizzlePlanManager.TITLE_SIMILARITY_THRESHOLD,
    )
  }

  private getActivePlanByTitle(title: string): DevPlan | undefined {
    const exact = this.findExactTitleMatch(title)
    if (exact) return exact
    return this.findSimilarActivePlan(title)
  }

  listPlans(): DevPlan[] {
    const db = tryDb()
    if (!db) return []
    const stmt = db.prepare('SELECT * FROM plans ORDER BY updated_at DESC')
    const plans: DevPlan[] = []
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as PlanRow
      plans.push(this.hydratePlan(row))
    }
    stmt.free()
    return plans
  }

  updateStep(planId: string, stepIndex: number, status: PlanStep['status'], result?: string): boolean {
    const db = tryDb()
    if (!db) return false
    const check = db.prepare('SELECT id FROM plan_steps WHERE plan_id = ? AND step_index = ?')
    check.bind([planId, stepIndex])
    if (!check.step()) {
      check.free()
      return false
    }
    check.free()

    db.run('UPDATE plan_steps SET status = ?, result = ? WHERE plan_id = ? AND step_index = ?', [status, result || null, planId, stepIndex])
    db.run('UPDATE plans SET updated_at = ? WHERE id = ?', [Date.now(), planId])

    markDirty()
    eventBus.emit('agent.plan.step', { planId, stepIndex, status, result })
    log('INFO', 'plan_step_update', { plan_id: planId, step: stepIndex, status })
    return true
  }

  completePlan(planId: string, reflection?: string): boolean {
    const db = tryDb()
    if (!db) return false
    db.run('UPDATE plans SET status = ?, reflection = ?, updated_at = ? WHERE id = ?', [
      'completed',
      reflection || null,
      Date.now(),
      planId,
    ])
    const affected = db.getRowsModified()
    if (affected === 0) {
      log('WARN', 'plan_complete_not_found', { plan_id: planId })
      return false
    }
    markDirty()
    eventBus.emit('agent.plan.completed', { planId })
    log('INFO', 'plan_completed', { plan_id: planId })
    return true
  }

  abandonPlan(planId: string, reason?: string): boolean {
    const db = tryDb()
    if (!db) return false
    db.run('UPDATE plans SET status = ?, reflection = ?, updated_at = ? WHERE id = ?', ['abandoned', reason || null, Date.now(), planId])
    const affected = db.getRowsModified()
    if (affected === 0) {
      log('WARN', 'plan_abandon_not_found', { plan_id: planId })
      return false
    }
    markDirty()
    log('INFO', 'plan_abandoned', { plan_id: planId, reason })
    return true
  }

  freezePlan(planId: string, reason?: string): boolean {
    const db = tryDb()
    if (!db) return false
    const check = db.prepare('SELECT status FROM plans WHERE id = ?')
    check.bind([planId])
    if (!check.step()) {
      check.free()
      return false
    }
    const currentStatus = check.getAsObject() as { status: string }
    check.free()
    if (currentStatus.status !== 'active') return false

    db.run('UPDATE plans SET status = ?, reflection = ?, updated_at = ? WHERE id = ?', ['frozen', reason || null, Date.now(), planId])
    const affected = db.getRowsModified()
    if (affected === 0) {
      log('WARN', 'plan_freeze_not_found', { plan_id: planId })
      return false
    }
    markDirty()
    log('INFO', 'plan_frozen', { plan_id: planId, reason })
    return true
  }

  /** 返回所有活跃计划列表 */
  private listActivePlans(): DevPlan[] {
    const db = tryDb()
    if (!db) return []
    const stmt = db.prepare('SELECT * FROM plans WHERE status = ? ORDER BY created_at DESC')
    stmt.bind(['active'])
    const plans: DevPlan[] = []
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as PlanRow
      plans.push(this.hydratePlan(row))
    }
    stmt.free()
    return plans
  }

  getFormattedContext(): string {
    const active = this.getActivePlan()
    if (!active) return ''
    const doneSteps = active.steps.filter((s) => s.status === 'done').length
    const totalSteps = active.steps.length
    let ctx = `【当前开发计划】${active.title}\n进度: ${doneSteps}/${totalSteps}\n`
    for (const s of active.steps) {
      const mark = s.status === 'done' ? '[✓]' : s.status === 'in_progress' ? '[→]' : s.status === 'failed' ? '[✗]' : '[ ]'
      ctx += `${mark} ${s.description}\n`
    }
    return ctx
  }

  /**
   * 清理旧计划：删除 completed（超过 completedCutoff）和 abandoned（超过 abandonedCutoff）的计划
   * 同时清理关联的 plan_steps。返回删除的计划数量。
   */
  cleanupOldPlans(completedCutoff: number, abandonedCutoff: number): number {
    const db = tryDb()
    if (!db) return 0

    // 先清理关联 steps
    const expiredPlans = db.prepare('SELECT id FROM plans WHERE (status = ? AND created_at < ?) OR (status = ? AND created_at < ?)')
    expiredPlans.bind(['completed', completedCutoff, 'abandoned', abandonedCutoff])
    while (expiredPlans.step()) {
      const row = expiredPlans.getAsObject() as { id: string }
      db.run('DELETE FROM plan_steps WHERE plan_id = ?', [row.id])
    }
    expiredPlans.free()

    db.run('DELETE FROM plans WHERE (status = ? AND created_at < ?) OR (status = ? AND created_at < ?)', [
      'completed',
      completedCutoff,
      'abandoned',
      abandonedCutoff,
    ])
    const removed = db.getRowsModified()
    if (removed > 0) markDirty()
    return removed
  }

  private createInMemoryPlan(title: string, description: string, stepDescriptions: string[], now: number, priority?: number): DevPlan {
    const planId = `plan_${now}_${++idCounter}`
    const steps = stepDescriptions.map((desc, i) => ({
      id: `step_${i}_${now}`,
      description: desc,
      status: 'pending' as const,
    }))
    const devPlan: DevPlan = {
      id: planId,
      title,
      description,
      steps,
      status: 'active',
      priority: priority ?? 0,
      createdAt: now,
      updatedAt: now,
    }
    log('INFO', 'plan_created_in_memory', { plan_id: planId, title, steps: stepDescriptions.length })
    return devPlan
  }

  private hydratePlan(row: PlanRow): DevPlan {
    const db = tryDb()
    if (!db) return { ...rowToPlan(row), steps: [] }
    const stmt = db.prepare('SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY step_index ASC')
    stmt.bind([row.id])
    const steps: PlanStep[] = []
    while (stmt.step()) {
      const sobj = stmt.getAsObject() as unknown as StepRow
      steps.push(rowToStep(sobj))
    }
    stmt.free()

    return {
      ...rowToPlan(row),
      steps,
    }
  }
}
