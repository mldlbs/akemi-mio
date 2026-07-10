/**
 * GuardrailMetricsStore — Metrics 持久化层
 *
 * 职责：
 * - 写入 metrics row（INSERT OR REPLACE — idempotent）
 * - 按窗口查询 / 获取最新 / 清空 / 聚合查询
 *
 * 透明降级：失败时只 WARN 日志（与 GuardrailDecisionStore 一致）。
 */
import { log } from '../../logger/Logger'

export interface MetricsRow {
  id: string
  windowSince: number
  windowUntil: number
  checkedCount: number
  warningCount: number
  terminatedCount: number
  continueCount: number
  totalSignalsHealthy: number
  totalSignalsDegrading: number
  totalSignalsStalled: number
  updatedAt: number
}

export interface MetricsSummary {
  totalChecked: number
  totalWarning: number
  totalTerminated: number
  totalContinue: number
  totalSignalsHealthy: number
  totalSignalsDegrading: number
  totalSignalsStalled: number
  windowCount: number
}

/** 原始 SQLite 回调类型 */
type RawDb = {
  run: (sql: string, params?: any[]) => void
  query: (sql: string, params?: any[]) => Record<string, any>[]
}

export class GuardrailMetricsStore {
  private raw: RawDb | null = null

  setRawDb(raw: RawDb): void {
    this.raw = raw
  }

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

  /** INSERT OR REPLACE — idempotent upsert */
  async upsert(row: MetricsRow): Promise<void> {
    try {
      const r = await this.ensureRaw()
      if (!r) return
      r.run(
        `INSERT OR REPLACE INTO guardrail_metrics
         (id, window_since, window_until, checked_count, warning_count, terminated_count, continue_count,
          total_signals_healthy, total_signals_degrading, total_signals_stalled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.windowSince,
          row.windowUntil,
          row.checkedCount,
          row.warningCount,
          row.terminatedCount,
          row.continueCount,
          row.totalSignalsHealthy,
          row.totalSignalsDegrading,
          row.totalSignalsStalled,
          row.updatedAt,
        ],
      )
    } catch (err: any) {
      log('WARN', 'metrics_store_upsert_failed', { id: row.id, error: err.message })
    }
  }

  /** 按时间窗口查询 */
  async query(windowSince: number, windowUntil: number): Promise<MetricsRow[]> {
    try {
      const r = await this.ensureRaw()
      if (!r) return []
      const rows = r.query('SELECT * FROM guardrail_metrics WHERE window_since >= ? AND window_until <= ? ORDER BY window_since ASC', [
        windowSince,
        windowUntil,
      ])
      return rows.map(mapRow)
    } catch {
      return []
    }
  }

  /** 获取最新窗口 */
  async getLatest(): Promise<MetricsRow | null> {
    try {
      const r = await this.ensureRaw()
      if (!r) return null
      const rows = r.query('SELECT * FROM guardrail_metrics ORDER BY window_since DESC LIMIT 1')
      if (rows.length === 0) return null
      return mapRow(rows[0])
    } catch {
      return null
    }
  }

  /** 获取上次更新的时间戳（用于增量 build） */
  async getLastUpdateTimestamp(): Promise<number | null> {
    try {
      const r = await this.ensureRaw()
      if (!r) return null
      const rows = r.query('SELECT MAX(updated_at) as max_ts FROM guardrail_metrics')
      if (rows.length === 0 || rows[0].max_ts === null) return null
      return rows[0].max_ts as number
    } catch {
      return null
    }
  }

  /**
   * 删除 updated_at < cutoff 的 metrics 行。
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
        r.run('DELETE FROM guardrail_metrics WHERE updated_at < ? LIMIT ?', [cutoff, batchSize])
        const rows = r.query('SELECT changes() AS c', [])
        deleted = (rows[0]?.c as number) ?? 0
        totalDeleted += deleted
      }
    } catch (err: any) {
      log('WARN', 'metrics_store_delete_failed', { cutoff, error: err.message })
    }
    return totalDeleted
  }

  /** 清空所有 metrics 行（用于 rebuild） */
  async clear(): Promise<void> {
    try {
      const r = await this.ensureRaw()
      if (!r) return
      r.run('DELETE FROM guardrail_metrics')
    } catch (err: any) {
      log('WARN', 'metrics_store_clear_failed', { error: err.message })
    }
  }

  /** 全量聚合查询 */
  async getSummary(): Promise<MetricsSummary> {
    try {
      const r = await this.ensureRaw()
      if (!r) return emptySummary()
      const rows = r.query(`
        SELECT
          COALESCE(SUM(checked_count), 0) as total_checked,
          COALESCE(SUM(warning_count), 0) as total_warning,
          COALESCE(SUM(terminated_count), 0) as total_terminated,
          COALESCE(SUM(continue_count), 0) as total_continue,
          COALESCE(SUM(total_signals_healthy), 0) as total_healthy,
          COALESCE(SUM(total_signals_degrading), 0) as total_degrading,
          COALESCE(SUM(total_signals_stalled), 0) as total_stalled,
          COUNT(*) as window_count
        FROM guardrail_metrics
      `)
      if (rows.length === 0) return emptySummary()
      const row = rows[0] as any
      return {
        totalChecked: row.total_checked,
        totalWarning: row.total_warning,
        totalTerminated: row.total_terminated,
        totalContinue: row.total_continue,
        totalSignalsHealthy: row.total_healthy,
        totalSignalsDegrading: row.total_degrading,
        totalSignalsStalled: row.total_stalled,
        windowCount: row.window_count,
      }
    } catch {
      return emptySummary()
    }
  }
}

function emptySummary(): MetricsSummary {
  return {
    totalChecked: 0,
    totalWarning: 0,
    totalTerminated: 0,
    totalContinue: 0,
    totalSignalsHealthy: 0,
    totalSignalsDegrading: 0,
    totalSignalsStalled: 0,
    windowCount: 0,
  }
}

function mapRow(row: any): MetricsRow {
  return {
    id: row.id,
    windowSince: row.window_since,
    windowUntil: row.window_until,
    checkedCount: row.checked_count,
    warningCount: row.warning_count,
    terminatedCount: row.terminated_count,
    continueCount: row.continue_count,
    totalSignalsHealthy: row.total_signals_healthy,
    totalSignalsDegrading: row.total_signals_degrading,
    totalSignalsStalled: row.total_signals_stalled,
    updatedAt: row.updated_at,
  }
}
