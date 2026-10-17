import { getRawDb, markDirty } from '@akemi-mio/core/db/connection'
import { normalizeFeedbackEvent, type HypothesisFeedbackEvent, type HypothesisFeedbackEventInput } from './FeedbackEvents'

function rowToEvent(obj: any): HypothesisFeedbackEvent {
  const event: HypothesisFeedbackEvent = {
    id: obj.id,
    hypothesisId: obj.hypothesis_id,
    eventType: obj.event_type,
    sourceType: obj.source_type,
    sourceId: obj.source_id,
    occurredAt: Number(obj.occurred_at),
    ingestedAt: Number(obj.ingested_at),
    idempotencyKey: obj.idempotency_key,
    schemaVersion: Number(obj.schema_version ?? 1),
  }
  if (obj.source_version != null) event.sourceVersion = String(obj.source_version)
  if (obj.commit_sha != null) event.commitSha = String(obj.commit_sha)
  if (obj.experiment_run_id != null) event.experimentRunId = String(obj.experiment_run_id)
  if (obj.evidence_ref != null) event.evidenceRef = String(obj.evidence_ref)
  return event
}

export interface DrizzleAppendResult {
  appended: boolean
  deduped: boolean
  event?: HypothesisFeedbackEvent
  quarantine?: { reason: string; raw: unknown }
}

/**
 * DrizzleFeedbackEventStore — 主进程权威侧证据事件写入（P0）
 *
 * SQLite 表 `hypothesis_feedback_events`（migration v51）。
 * INSERT OR IGNORE + UNIQUE(idempotency_key)：重复导入不增样本。
 * 追加写入；纠错用更正事件，不 UPDATE 已有行。
 * accept input（缺 id/key 时由 normalizeFeedbackEvent 补齐），与 JSONL store 人体工学一致。
 */
export class DrizzleFeedbackEventStore {
  append(input: HypothesisFeedbackEvent | HypothesisFeedbackEventInput, now: number = Date.now()): DrizzleAppendResult {
    const normalized = 'idempotencyKey' in input && 'ingestedAt' in input && 'schemaVersion' in input
      ? ({ ok: true, event: input as HypothesisFeedbackEvent } as const)
      : normalizeFeedbackEvent(input, now)
    if (!normalized.ok) {
      return { appended: false, deduped: false, quarantine: { reason: normalized.reason, raw: normalized.raw } }
    }
    const event = normalized.event
    const db = getRawDb()
    const exists = db.exec(`SELECT 1 FROM hypothesis_feedback_events WHERE idempotency_key = ? LIMIT 1`, [event.idempotencyKey])
    if (exists && exists.length > 0 && exists[0].values.length > 0) {
      return { appended: false, deduped: true, event }
    }
    db.run(
      `INSERT OR IGNORE INTO hypothesis_feedback_events
        (id, hypothesis_id, event_type, source_type, source_id, source_version, commit_sha, experiment_run_id, evidence_ref, occurred_at, ingested_at, idempotency_key, schema_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        event.hypothesisId,
        event.eventType,
        event.sourceType,
        event.sourceId,
        event.sourceVersion ?? null,
        event.commitSha ?? null,
        event.experimentRunId ?? null,
        event.evidenceRef ?? null,
        event.occurredAt,
        event.ingestedAt,
        event.idempotencyKey,
        event.schemaVersion,
      ],
    )
    markDirty()
    return { appended: true, deduped: false, event }
  }

  list(options?: { hypothesisId?: string; eventType?: string; limit?: number }): HypothesisFeedbackEvent[] {
    const db = getRawDb()
    let sql = 'SELECT * FROM hypothesis_feedback_events'
    const clauses: string[] = []
    const params: any[] = []
    if (options?.hypothesisId) {
      clauses.push('hypothesis_id = ?')
      params.push(options.hypothesisId)
    }
    if (options?.eventType) {
      clauses.push('event_type = ?')
      params.push(options.eventType)
    }
    if (clauses.length > 0) sql += ' WHERE ' + clauses.join(' AND ')
    sql += ' ORDER BY occurred_at ASC'
    if (options?.limit) sql += ` LIMIT ${options.limit}`
    const result = db.exec(sql, params)
    if (!result || result.length === 0 || result[0].values.length === 0) return []
    const columns = result[0].columns
    return result[0].values.map((values: any[]) => {
      const obj: any = {}
      for (let i = 0; i < columns.length; i++) obj[columns[i]] = values[i]
      return rowToEvent(obj)
    })
  }

  count(): number {
    const db = getRawDb()
    const r = db.exec('SELECT COUNT(*) FROM hypothesis_feedback_events')
    return r && r.length > 0 && r[0].values.length > 0 ? Number(r[0].values[0][0]) : 0
  }

  hasKey(key: string): boolean {
    const db = getRawDb()
    const r = db.exec('SELECT 1 FROM hypothesis_feedback_events WHERE idempotency_key = ? LIMIT 1', [key])
    return !!(r && r.length > 0 && r[0].values.length > 0)
  }
}
