/**
 * RetentionScheduler — ADR-005 R1-A: Hot Storage Retention
 *
 * 协调者角色。将 evaluation_events 归档委托给 EventArchiver，
 * 对 guardrail_decisions 和 guardrail_metrics 执行直接 DELETE。
 *
 * 不变量 R1-I2：保留是软限制。超出目标时不崩溃、不降级。
 */
import { log } from '../../logger/Logger'
import type { EvaluationRepository } from './types'
import { EventArchiver, type ArchiveOptions, type ArchiveResult } from './EventArchiver'
import { GuardrailDecisionStore } from './GuardrailDecisionStore'
import { GuardrailMetricsStore } from './GuardrailMetricsStore'
import { HOT_RETENTION, RETENTION_BATCH_SIZE } from './RetentionConfig'

export interface RetentionResult {
  tableName: string
  cutoffTimestamp: number
  deletedCount: number
  durationMs: number
  error?: string
}

export interface RetentionCycleResult {
  archive: ArchiveResult[]
  retention: RetentionResult[]
}

type RawDb = {
  run: (sql: string, params?: any[]) => void
  query: (sql: string, params?: any[]) => Record<string, any>[]
}

export class RetentionScheduler {
  constructor(
    private archiver: EventArchiver,
    private rawDb: RawDb,
    private eventStore: EvaluationRepository,
    private decisionStore: GuardrailDecisionStore,
    private metricsStore: GuardrailMetricsStore,
    private workspaceRoot?: string,
  ) {}

  /**
   * 运行一次完整的归档 + 保留周期：
   * 1. 归档 evaluation_events（NDJSON gzip）
   * 2. 删除过期 guardrail_decisions
   * 3. 删除过期 guardrail_metrics
   */
  async runCycle(options?: ArchiveOptions): Promise<RetentionCycleResult> {
    const now = Date.now()
    const archiveResult = await this.archiveEvents(options)

    const retentionResults: RetentionResult[] = []

    // 清理 guardrail_decisions（7d）
    const decisionsCutoff = now - HOT_RETENTION.GUARDRAIL_DECISIONS
    const drResult = await this.deleteDecisions(decisionsCutoff)
    retentionResults.push(drResult)

    // 清理 guardrail_metrics（90d）
    const metricsCutoff = now - HOT_RETENTION.GUARDRAIL_METRICS
    const mrResult = await this.deleteMetrics(metricsCutoff)
    retentionResults.push(mrResult)

    return {
      archive: archiveResult,
      retention: retentionResults,
    }
  }

  private async archiveEvents(options?: ArchiveOptions): Promise<ArchiveResult[]> {
    try {
      const cutoff = options?.cutoff ?? Date.now() - HOT_RETENTION.EVALUATION_EVENTS
      return await this.archiver.archiveAll({ ...options, cutoff })
    } catch (err: any) {
      log('WARN', 'retention_archive_failed', { error: err.message })
      return []
    }
  }

  private async deleteDecisions(cutoff: number): Promise<RetentionResult> {
    const start = Date.now()
    try {
      const count = await this.deleteOlderThanRaw('guardrail_decisions', 'decided_at', cutoff)
      if (count > 0) {
        log('INFO', 'retention_decisions_deleted', { cutoff, count })
      }
      return {
        tableName: 'guardrail_decisions',
        cutoffTimestamp: cutoff,
        deletedCount: count,
        durationMs: Date.now() - start,
      }
    } catch (err: any) {
      return {
        tableName: 'guardrail_decisions',
        cutoffTimestamp: cutoff,
        deletedCount: 0,
        durationMs: Date.now() - start,
        error: err.message,
      }
    }
  }

  private async deleteMetrics(cutoff: number): Promise<RetentionResult> {
    const start = Date.now()
    try {
      const count = await this.deleteOlderThanRaw('guardrail_metrics', 'updated_at', cutoff)
      if (count > 0) {
        log('INFO', 'retention_metrics_deleted', { cutoff, count })
      }
      return {
        tableName: 'guardrail_metrics',
        cutoffTimestamp: cutoff,
        deletedCount: count,
        durationMs: Date.now() - start,
      }
    } catch (err: any) {
      return {
        tableName: 'guardrail_metrics',
        cutoffTimestamp: cutoff,
        deletedCount: 0,
        durationMs: Date.now() - start,
        error: err.message,
      }
    }
  }

  /** 通用分批 DELETE 辅助方法 */
  private async deleteOlderThanRaw(table: string, timeCol: string, cutoff: number): Promise<number> {
    let totalDeleted = 0
    let deleted = RETENTION_BATCH_SIZE

    while (deleted === RETENTION_BATCH_SIZE) {
      this.rawDb.run(`DELETE FROM ${table} WHERE ${timeCol} < ? LIMIT ?`, [cutoff, RETENTION_BATCH_SIZE])
      const rows = this.rawDb.query('SELECT changes() AS c', [])
      deleted = (rows[0]?.c as number) ?? 0
      totalDeleted += deleted
      try {
        const { markDirty } = await import('../../db/connection')
        markDirty()
      } catch {
        /* 静默 */
      }
      await new Promise((resolve) => setImmediate(resolve))
    }

    return totalDeleted
  }
}
