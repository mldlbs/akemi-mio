/**
 * GuardrailDecisionStore — Decision 持久化层
 *
 * 轻量级实现：只持久化 replay-identity 必要的字段。
 * 透明降级：record() 失败时只 WARN 日志，不影响决策流程。
 *
 * ── 数据流 ──
 * GuardrailPipeline.check()
 *   → DecisionStore.record()  [fire-and-forget, 不阻塞]
 *     → guardrail_decisions 表
 */

import { log } from '../../logger/Logger'
import type { GuardrailDecision, GuardrailAction, RuntimeAction } from './GuardrailTypes'

/** retry 最大间隔 */
const RETRY_DELAY_MS = 200

/** retry 最大次数 */
const MAX_RETRIES = 3

export interface DecisionRecord {
  decisionId: string
  traceId: string
  turn: number
  action: GuardrailAction
  runtimeAction: RuntimeAction
  policyVersion: string
  signals: string // JSON-serialized SignalState[]
  decidedAt: number
}

/** 原始 SQLite 运作回调类型 */
type RawDb = {
  run: (sql: string, params?: any[]) => void
  query: (sql: string, params?: any[]) => Record<string, any>[]
}

export class GuardrailDecisionStore {
  private raw: RawDb | null = null

  /** 注入原始 sqlite 引用 */
  setRawDb(raw: RawDb): void {
    this.raw = raw
  }

  /** 延迟初始化 raw db */
  private async ensureRaw(): Promise<RawDb | null> {
    if (this.raw) return this.raw
    try {
      const { getRawDb } = await import('../../db/connection')
      const rdb = getRawDb()
      this.raw = {
        run: (s, p) => rdb.run(s, p),
        query: (s, p) => {
          const stmt = rdb.prepare(s)
          p && stmt.bind(p)
          const rows: any[] = []
          while (stmt.step()) rows.push(stmt.getAsObject())
          stmt.free()
          return rows
        },
      }
      return this.raw
    } catch {
      return null
    }
  }

  /**
   * 持久化一条 Decision 记录。
   * 异步 fire-and-forget：失败不影响决策流程。
   * 内建 best-effort retry（最多 3 次，200ms 间隔）。
   */
  async record(
    decisionId: string,
    decision: GuardrailDecision,
    runtimeAction: RuntimeAction,
    traceId: string,
    turn: number,
  ): Promise<void> {
    await this.recordWithRetry(decisionId, decision, runtimeAction, traceId, turn)
  }

  private async recordWithRetry(
    decisionId: string,
    decision: GuardrailDecision,
    runtimeAction: RuntimeAction,
    traceId: string,
    turn: number,
    attempt: number = 1,
  ): Promise<void> {
    try {
      const r = await this.ensureRaw()
      if (!r) return
      r.run(
        'INSERT OR IGNORE INTO guardrail_decisions (decision_id, trace_id, turn, action, runtime_action, policy_version, signals, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          decisionId,
          traceId,
          turn,
          decision.action,
          runtimeAction,
          decision.policyVersion,
          JSON.stringify(decision.signals),
          decision.decidedAt,
        ],
      )
    } catch (err: any) {
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
        return this.recordWithRetry(decisionId, decision, runtimeAction, traceId, turn, attempt + 1)
      }
      log('WARN', 'decision_store_record_failed', { traceId, turn, attempt, error: err.message })
    }
  }

  /**
   * 查询指定 trace 的所有 Decision 记录。
   * 失败时返回空数组。
   */
  async getByTrace(traceId: string): Promise<DecisionRecord[]> {
    try {
      const r = await this.ensureRaw()
      if (!r) return []
      const rows = r.query('SELECT * FROM guardrail_decisions WHERE trace_id = ? ORDER BY decided_at ASC', [traceId])
      return rows.map((row: any) => ({
        decisionId: row.decision_id,
        traceId: row.trace_id,
        turn: row.turn,
        action: row.action,
        runtimeAction: row.runtime_action,
        policyVersion: row.policy_version,
        signals: row.signals,
        decidedAt: row.decided_at,
      }))
    } catch {
      return []
    }
  }

  /**
   * 按 decisionId 查询单条 Decision 记录。
   * 不存在或 DB 不可用时返回 null（与 getByTrace 的 degraded 模式一致）。
   */
  async getDecision(decisionId: string): Promise<DecisionRecord | null> {
    try {
      const r = await this.ensureRaw()
      if (!r) return null
      const rows = r.query('SELECT * FROM guardrail_decisions WHERE decision_id = ?', [decisionId])
      if (rows.length === 0) return null
      const row = rows[0] as any
      return {
        decisionId: row.decision_id,
        traceId: row.trace_id,
        turn: row.turn,
        action: row.action,
        runtimeAction: row.runtime_action,
        policyVersion: row.policy_version,
        signals: row.signals,
        decidedAt: row.decided_at,
      }
    } catch {
      return null
    }
  }

  /**
   * 删除 decided_at < cutoff 的决策记录。
   * Best-effort，失败时 WARN 日志。
   * @returns 删除的行数
   */
  async deleteOlderThan(cutoff: number, batchSize: number = 500): Promise<number> {
    let totalDeleted = 0
    try {
      const r = await this.ensureRaw()
      if (!r) return 0
      let deleted = batchSize
      while (deleted === batchSize) {
        r.run('DELETE FROM guardrail_decisions WHERE decided_at < ? LIMIT ?', [cutoff, batchSize])
        const rows = r.query('SELECT changes() AS c', [])
        deleted = (rows[0]?.c as number) ?? 0
        totalDeleted += deleted
      }
    } catch (err: any) {
      log('WARN', 'decision_store_delete_failed', { cutoff, error: err.message })
    }
    return totalDeleted
  }

  /**
   * 查询最近 N 条决策记录（精简字段）。
   * DB 不可用时返回空数组。
   */
  async listRecent(
    limit: number = 10,
  ): Promise<Pick<DecisionRecord, 'decisionId' | 'traceId' | 'action' | 'runtimeAction' | 'decidedAt'>[]> {
    try {
      const r = await this.ensureRaw()
      if (!r) return []
      const rows = r.query(
        'SELECT decision_id, trace_id, action, runtime_action, decided_at FROM guardrail_decisions ORDER BY decided_at DESC LIMIT ?',
        [limit],
      )
      return rows.map((row: any) => ({
        decisionId: row.decision_id,
        traceId: row.trace_id,
        action: row.action,
        runtimeAction: row.runtime_action,
        decidedAt: row.decided_at,
      }))
    } catch {
      return []
    }
  }
}
