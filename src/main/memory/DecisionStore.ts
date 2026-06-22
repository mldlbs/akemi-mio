/**
 * DecisionStore — P1 决策记录
 *
 * 在每次交互后记录关键决策（工具选择、策略路由、计划调整、恢复），
 * 供 Evolution 和 FailureAnalyzer 查询。
 *
 * ReflectLoop 写入（不再写入 EngineeringMemory 的 failure_pattern）。
 */

import { log } from '../logger/Logger'
import { getRawDb } from '../db/connection'

export type DecisionCategory = 'tool_select' | 'strategy' | 'plan_route' | 'goal_adjust' | 'recovery'
export type DecisionOutcome = 'pending' | 'success' | 'failure'

export interface DecisionRecord {
  id: string
  timestamp: number
  agentId: string
  category: DecisionCategory
  context: string
  choice: string
  alternatives: string[]
  outcome: DecisionOutcome
  confidence: number
  relatedPlanId?: string
  createdAt: number
}

export interface DecisionQuery {
  categories?: DecisionCategory[]
  agentId?: string
  since?: number
  until?: number
  limit?: number
  outcome?: DecisionOutcome
}

let idCounter = 0
const MAX_RECORDS = 200

export class DecisionStore {
  /** 写入一条决策记录 */
  record(input: {
    agentId: string
    category: DecisionCategory
    context: string
    choice: string
    alternatives?: string[]
    confidence?: number
    relatedPlanId?: string
    outcome?: DecisionOutcome
  }): string {
    const db = getRawDb()
    const id = `dec_${Date.now()}_${++idCounter}`
    const now = Date.now()
    db.run(
      `INSERT INTO decisions (id, timestamp, agent_id, category, context, choice, alternatives, outcome, confidence, related_plan_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        now,
        input.agentId,
        input.category,
        input.context.slice(0, 500),
        input.choice,
        JSON.stringify(input.alternatives || []),
        input.outcome || 'pending',
        input.confidence ?? 0.5,
        input.relatedPlanId || null,
        now,
      ],
    )
    log('INFO', 'decision_recorded', { id, category: input.category, choice: input.choice.slice(0, 40) })
    this.prune()
    return id
  }

  /** 更新决策结果 */
  updateOutcome(id: string, outcome: DecisionOutcome): void {
    const db = getRawDb()
    db.run('UPDATE decisions SET outcome = ? WHERE id = ?', [outcome, id])
  }

  /** 查询决策记录 */
  query(q: DecisionQuery = {}): DecisionRecord[] {
    const db = getRawDb()
    const conditions: string[] = []
    const params: any[] = []

    if (q.categories?.length) {
      conditions.push(`category IN (${q.categories.map(() => '?').join(',')})`)
      params.push(...q.categories)
    }
    if (q.agentId) {
      conditions.push('agent_id = ?')
      params.push(q.agentId)
    }
    if (q.since !== undefined) {
      conditions.push('timestamp >= ?')
      params.push(q.since)
    }
    if (q.until !== undefined) {
      conditions.push('timestamp <= ?')
      params.push(q.until)
    }
    if (q.outcome) {
      conditions.push('outcome = ?')
      params.push(q.outcome)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = q.limit || 20

    const stmt = db.prepare(`SELECT * FROM decisions ${where} ORDER BY timestamp DESC LIMIT ${limit}`)
    stmt.bind(params)
    const results: DecisionRecord[] = []
    while (stmt.step()) {
      const r = stmt.getAsObject() as any
      results.push({
        id: r.id,
        timestamp: r.timestamp,
        agentId: r.agent_id,
        category: r.category,
        context: r.context,
        choice: r.choice,
        alternatives: JSON.parse(r.alternatives || '[]'),
        outcome: r.outcome,
        confidence: r.confidence,
        relatedPlanId: r.related_plan_id || undefined,
        createdAt: r.created_at,
      })
    }
    stmt.free()
    return results
  }

  /** 获取格式化上下文（供 Evolution 和 FailureAnalyzer 使用） */
  getFormattedContext(category?: DecisionCategory, limit = 5): string {
    const q: DecisionQuery = { limit }
    if (category) q.categories = [category]
    const records = this.query(q)
    if (records.length === 0) return ''
    const parts = ['---', '【近期决策记录】']
    for (const r of records) {
      parts.push(`[${r.category}] ${r.choice.slice(0, 60)} (${r.outcome}, ${r.confidence.toFixed(2)})`)
    }
    parts.push('---')
    return parts.join('\n')
  }

  private prune(): void {
    try {
      const db = getRawDb()
      const count = Number(db.exec('SELECT COUNT(*) AS c FROM decisions')[0]?.values[0]?.[0] || 0)
      if (count > MAX_RECORDS) {
        db.run(`DELETE FROM decisions WHERE id IN (SELECT id FROM decisions ORDER BY timestamp ASC LIMIT ?)`, [count - MAX_RECORDS])
      }
    } catch {
      /* ignore */
    }
  }
}
