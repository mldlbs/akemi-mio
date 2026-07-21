/**
 * FailureDatabase — 失败学习数据库操作层
 *
 * 封装对 failure_logs / config_snapshots / improvement_suggestions
 * 三张表的 CRUD 操作，使用 getRawDb() 直接操作 SQLite。
 */
import { log } from '../../logger/Logger'
import { getRawDb } from '../../db/connection'
import type { FailureErrorType, SuggestionType, FailureRateSnapshot, ConfigSnapshotContext } from './types'

// =============================================================================
// 宏定义：表名 & 列名避免魔法字符串
// =============================================================================

const TABLE_FAILURE_LOGS = 'failure_logs'
const TABLE_CONFIG_SNAPSHOTS = 'config_snapshots'
const TABLE_IMPROVEMENT_SUGGESTIONS = 'improvement_suggestions'

// =============================================================================
// FailureDatabase
// =============================================================================

export class FailureDatabase {
  // ══════════════════════════════════════════════
  // DDL — 创建表
  // ══════════════════════════════════════════════

  ensureTables(): void {
    const db = getRawDb()
    db.run(`
      CREATE TABLE IF NOT EXISTS ${TABLE_FAILURE_LOGS} (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        error_type TEXT NOT NULL,
        error_name TEXT NOT NULL,
        error_message TEXT NOT NULL,
        error_detail TEXT,
        tool_state TEXT,
        llm_output TEXT,
        task_description TEXT,
        system_prompt TEXT,
        analyzed INTEGER NOT NULL DEFAULT 0,
        analysis_result TEXT,
        has_suggestion INTEGER NOT NULL DEFAULT 0,
        suggestion_id TEXT,
        created_at INTEGER NOT NULL,
        analyzed_at INTEGER
      )
    `)
    db.run(`CREATE INDEX IF NOT EXISTS idx_failure_logs_created_at ON ${TABLE_FAILURE_LOGS}(created_at)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_failure_logs_analyzed ON ${TABLE_FAILURE_LOGS}(analyzed)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_failure_logs_error_type ON ${TABLE_FAILURE_LOGS}(error_type)`)

    db.run(`
      CREATE TABLE IF NOT EXISTS ${TABLE_CONFIG_SNAPSHOTS} (
        id TEXT PRIMARY KEY,
        snapshot_type TEXT NOT NULL,
        config_key TEXT NOT NULL,
        old_value TEXT NOT NULL,
        new_value TEXT,
        suggestion_id TEXT,
        failure_log_id TEXT,
        rolled_back INTEGER NOT NULL DEFAULT 0,
        rolled_back_at INTEGER,
        created_at INTEGER NOT NULL,
        post_failure_rate REAL,
        pre_failure_rate REAL
      )
    `)
    db.run(`CREATE INDEX IF NOT EXISTS idx_config_snapshots_type ON ${TABLE_CONFIG_SNAPSHOTS}(snapshot_type)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_config_snapshots_rolled ON ${TABLE_CONFIG_SNAPSHOTS}(rolled_back)`)

    db.run(`
      CREATE TABLE IF NOT EXISTS ${TABLE_IMPROVEMENT_SUGGESTIONS} (
        id TEXT PRIMARY KEY,
        suggestion_type TEXT NOT NULL,
        target_name TEXT NOT NULL,
        current_value TEXT NOT NULL,
        suggested_value TEXT NOT NULL,
        rationale TEXT NOT NULL,
        failure_pattern TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        snapshot_id TEXT,
        created_at INTEGER NOT NULL,
        applied_at INTEGER,
        rolled_back_at INTEGER,
        failure_rate_delta REAL
      )
    `)
    db.run(`CREATE INDEX IF NOT EXISTS idx_suggestions_status ON ${TABLE_IMPROVEMENT_SUGGESTIONS}(status)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_suggestions_type ON ${TABLE_IMPROVEMENT_SUGGESTIONS}(suggestion_type)`)

    log('INFO', 'failure_learning_tables_ensured')
  }

  // ══════════════════════════════════════════════
  // 失败日志 CRUD
  // ══════════════════════════════════════════════

  /** 插入一条失败日志 */
  insertFailureLog(logEntry: {
    id: string
    requestId: string
    errorType: FailureErrorType
    errorName: string
    errorMessage: string
    errorDetail?: string
    toolState?: string
    llmOutput?: string
    taskDescription?: string
    systemPrompt?: string
  }): void {
    const db = getRawDb()
    db.run(
      `INSERT OR IGNORE INTO ${TABLE_FAILURE_LOGS}
       (id, request_id, error_type, error_name, error_message, error_detail,
        tool_state, llm_output, task_description, system_prompt,
        analyzed, has_suggestion, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      [
        logEntry.id,
        logEntry.requestId,
        logEntry.errorType,
        logEntry.errorName,
        logEntry.errorMessage,
        logEntry.errorDetail || null,
        logEntry.toolState || null,
        logEntry.llmOutput || null,
        logEntry.taskDescription || null,
        logEntry.systemPrompt || null,
        Date.now(),
      ],
    )
  }

  /** 获取未分析的失败日志（按时间倒序） */
  getUnanalyzedFailures(limit: number): Array<{
    id: string
    requestId: string
    errorType: string
    errorName: string
    errorMessage: string
    errorDetail: string | null
    toolState: string | null
    llmOutput: string | null
    taskDescription: string | null
    systemPrompt: string | null
    createdAt: number
  }> {
    const db = getRawDb()
    const stmt = db.prepare(
      `SELECT id, request_id, error_type, error_name, error_message, error_detail,
              tool_state, llm_output, task_description, system_prompt, created_at
       FROM ${TABLE_FAILURE_LOGS}
       WHERE analyzed = 0
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    stmt.bind([limit])
    const results: Array<Record<string, any>> = []
    while (stmt.step()) {
      results.push(stmt.getAsObject())
    }
    stmt.free()
    return results.map((r) => ({
      id: String(r.id),
      requestId: String(r.request_id),
      errorType: String(r.error_type),
      errorName: String(r.error_name),
      errorMessage: String(r.error_message),
      errorDetail: r.error_detail ? String(r.error_detail) : null,
      toolState: r.tool_state ? String(r.tool_state) : null,
      llmOutput: r.llm_output ? String(r.llm_output) : null,
      taskDescription: r.task_description ? String(r.task_description) : null,
      systemPrompt: r.system_prompt ? String(r.system_prompt) : null,
      createdAt: Number(r.created_at),
    }))
  }

  /** 获取最近的失败日志（用于统计失败率） */
  getRecentFailures(since: number): number {
    const db = getRawDb()
    const stmt = db.prepare(
      `SELECT COUNT(*) as cnt FROM ${TABLE_FAILURE_LOGS} WHERE created_at >= ?`,
    )
    stmt.bind([since])
    let count = 0
    if (stmt.step()) {
      count = Number(stmt.getAsObject().cnt || 0)
    }
    stmt.free()
    return count
  }

  /** 标记失败日志为已分析 */
  markAnalyzed(id: string, analysisResult: string): void {
    const db = getRawDb()
    db.run(
      `UPDATE ${TABLE_FAILURE_LOGS} SET analyzed = 1, analysis_result = ?, analyzed_at = ? WHERE id = ?`,
      [analysisResult, Date.now(), id],
    )
  }

  /** 标记失败日志已生成建议 */
  markHasSuggestion(id: string, suggestionId: string): void {
    const db = getRawDb()
    db.run(
      `UPDATE ${TABLE_FAILURE_LOGS} SET has_suggestion = 1, suggestion_id = ? WHERE id = ?`,
      [suggestionId, id],
    )
  }

  /** 获取未分析的总数 */
  getUnanalyzedCount(): number {
    const db = getRawDb()
    const stmt = db.prepare(`SELECT COUNT(*) as cnt FROM ${TABLE_FAILURE_LOGS} WHERE analyzed = 0`)
    let count = 0
    if (stmt.step()) {
      count = Number(stmt.getAsObject().cnt || 0)
    }
    stmt.free()
    return count
  }

  // ══════════════════════════════════════════════
  // 配置快照 CRUD
  // ══════════════════════════════════════════════

  /** 创建配置快照 */
  createSnapshot(snapshot: {
    id: string
    snapshotType: string
    configKey: string
    oldValue: string
    newValue: string | null
    suggestionId?: string
    failureLogId?: string
    preFailureRate: number
  }): void {
    const db = getRawDb()
    db.run(
      `INSERT OR IGNORE INTO ${TABLE_CONFIG_SNAPSHOTS}
       (id, snapshot_type, config_key, old_value, new_value,
        suggestion_id, failure_log_id, rolled_back, created_at, pre_failure_rate)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        snapshot.id,
        snapshot.snapshotType,
        snapshot.configKey,
        snapshot.oldValue,
        snapshot.newValue || null,
        snapshot.suggestionId || null,
        snapshot.failureLogId || null,
        Date.now(),
        snapshot.preFailureRate,
      ],
    )
  }

  /** 获取最近未回滚的快照 */
  getLatestUnrolledBackSnapshot(): ConfigSnapshotContext | null {
    const db = getRawDb()
    const stmt = db.prepare(
      `SELECT id, snapshot_type, config_key, old_value, new_value, created_at, pre_failure_rate, post_failure_rate
       FROM ${TABLE_CONFIG_SNAPSHOTS}
       WHERE rolled_back = 0 AND new_value IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    stmt.bind([])
    let result: Record<string, any> | null = null
    if (stmt.step()) {
      result = stmt.getAsObject()
    }
    stmt.free()
    if (!result) return null
    return {
      snapshotId: String(result.id),
      snapshotType: String(result.snapshot_type),
      configKey: String(result.config_key),
      oldValue: String(result.old_value),
      newValue: result.new_value ? String(result.new_value) : null,
      createdAt: Number(result.created_at),
      preFailureRate: Number(result.pre_failure_rate),
      postFailureRate: result.post_failure_rate ? Number(result.post_failure_rate) : null,
    }
  }

  /** 更新快照的 post_failure_rate */
  updateSnapshotPostRate(snapshotId: string, postFailureRate: number): void {
    const db = getRawDb()
    db.run(
      `UPDATE ${TABLE_CONFIG_SNAPSHOTS} SET post_failure_rate = ? WHERE id = ?`,
      [postFailureRate, snapshotId],
    )
  }

  /** 标记快照为已回滚 */
  markSnapshotRolledBack(snapshotId: string): void {
    const db = getRawDb()
    db.run(
      `UPDATE ${TABLE_CONFIG_SNAPSHOTS} SET rolled_back = 1, rolled_back_at = ? WHERE id = ?`,
      [Date.now(), snapshotId],
    )
  }

  /** 通过 snapshotId 获取 old_value */
  getSnapshotOldValue(snapshotId: string): string | null {
    const db = getRawDb()
    const stmt = db.prepare(`SELECT old_value FROM ${TABLE_CONFIG_SNAPSHOTS} WHERE id = ?`)
    stmt.bind([snapshotId])
    let val: string | null = null
    if (stmt.step()) {
      val = String(stmt.getAsObject().old_value || '')
    }
    stmt.free()
    return val
  }

  // ══════════════════════════════════════════════
  // 改进建议 CRUD
  // ══════════════════════════════════════════════

  /** 插入改进建议 */
  insertSuggestion(suggestion: {
    id: string
    suggestionType: string
    targetName: string
    currentValue: string
    suggestedValue: string
    rationale: string
    failurePattern?: string
  }): void {
    const db = getRawDb()
    db.run(
      `INSERT OR IGNORE INTO ${TABLE_IMPROVEMENT_SUGGESTIONS}
       (id, suggestion_type, target_name, current_value, suggested_value,
        rationale, failure_pattern, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [
        suggestion.id,
        suggestion.suggestionType,
        suggestion.targetName,
        suggestion.currentValue,
        suggestion.suggestedValue,
        suggestion.rationale,
        suggestion.failurePattern || null,
        Date.now(),
      ],
    )
  }

  /** 获取待处理的建议 */
  getPendingSuggestions(limit: number): Array<{
    id: string
    suggestionType: string
    targetName: string
    currentValue: string
    suggestedValue: string
    rationale: string
    failurePattern: string | null
    createdAt: number
  }> {
    const db = getRawDb()
    const stmt = db.prepare(
      `SELECT id, suggestion_type, target_name, current_value, suggested_value,
              rationale, failure_pattern, created_at
       FROM ${TABLE_IMPROVEMENT_SUGGESTIONS}
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    stmt.bind([limit])
    const results: Array<Record<string, any>> = []
    while (stmt.step()) {
      results.push(stmt.getAsObject())
    }
    stmt.free()
    return results.map((r) => ({
      id: String(r.id),
      suggestionType: String(r.suggestion_type),
      targetName: String(r.target_name),
      currentValue: String(r.current_value),
      suggestedValue: String(r.suggested_value),
      rationale: String(r.rationale),
      failurePattern: r.failure_pattern ? String(r.failure_pattern) : null,
      createdAt: Number(r.created_at),
    }))
  }

  /** 获取待回滚检查的建议（已应用但未验证效果） */
  getSuggestionsPendingVerification(): Array<{
    id: string
    suggestionType: string
    targetName: string
    snapshotId: string | null
    createdAt: number
  }> {
    const db = getRawDb()
    const stmt = db.prepare(
      `SELECT s.id, s.suggestion_type, s.target_name, s.snapshot_id, s.created_at
       FROM ${TABLE_IMPROVEMENT_SUGGESTIONS} s
       WHERE s.status = 'applied'
       ORDER BY s.created_at DESC
       LIMIT 10`,
    )
    stmt.bind([])
    const results: Array<Record<string, any>> = []
    while (stmt.step()) {
      results.push(stmt.getAsObject())
    }
    stmt.free()
    return results.map((r) => ({
      id: String(r.id),
      suggestionType: String(r.suggestion_type),
      targetName: String(r.target_name),
      snapshotId: r.snapshot_id ? String(r.snapshot_id) : null,
      createdAt: Number(r.created_at),
    }))
  }

  /** 更新建议状态 */
  updateSuggestionStatus(id: string, status: string, snapshotId?: string): void {
    const db = getRawDb()
    if (status === 'applied') {
      db.run(
        `UPDATE ${TABLE_IMPROVEMENT_SUGGESTIONS} SET status = ?, snapshot_id = ?, applied_at = ? WHERE id = ?`,
        [status, snapshotId || null, Date.now(), id],
      )
    } else if (status === 'rollback_applied') {
      db.run(
        `UPDATE ${TABLE_IMPROVEMENT_SUGGESTIONS} SET status = ?, rolled_back_at = ? WHERE id = ?`,
        [status, Date.now(), id],
      )
    } else {
      db.run(
        `UPDATE ${TABLE_IMPROVEMENT_SUGGESTIONS} SET status = ? WHERE id = ?`,
        [status, id],
      )
    }
  }

  /** 更新建议的 failure_rate_delta */
  updateSuggestionFailureDelta(id: string, delta: number): void {
    const db = getRawDb()
    db.run(
      `UPDATE ${TABLE_IMPROVEMENT_SUGGESTIONS} SET failure_rate_delta = ? WHERE id = ?`,
      [delta, id],
    )
  }

  // ══════════════════════════════════════════════
  // 统计
  // ══════════════════════════════════════════════

  /** 计算当前失败率（最近 N 条执行记录中的失败比例） */
  computeCurrentFailureRate(windowSize: number): FailureRateSnapshot {
    const db = getRawDb()
    const stmt = db.prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN analyzed = 1 AND has_suggestion = 1 THEN 1 ELSE 0 END) as failures
       FROM (SELECT analyzed, has_suggestion FROM ${TABLE_FAILURE_LOGS} ORDER BY created_at DESC LIMIT ?)`,
    )
    stmt.bind([windowSize])
    let total = 0
    let failures = 0
    if (stmt.step()) {
      const row = stmt.getAsObject()
      total = Number(row.total || 0)
      failures = Number(row.failures || 0)
    }
    stmt.free()

    return {
      cycleId: `fr_${Date.now()}`,
      timestamp: Date.now(),
      failureCount: failures,
      totalCount: total,
      failureRate: total > 0 ? failures / total : 0,
    }
  }

  /** 获取前一个失败率快照（最近的 config_snapshot.pre_failure_rate） */
  getPreviousFailureRate(): number | null {
    const db = getRawDb()
    const stmt = db.prepare(
      `SELECT pre_failure_rate FROM ${TABLE_CONFIG_SNAPSHOTS} ORDER BY created_at DESC LIMIT 1`,
    )
    stmt.bind([])
    let rate: number | null = null
    if (stmt.step()) {
      const v = stmt.getAsObject().pre_failure_rate
      if (v !== null && v !== undefined) rate = Number(v)
    }
    stmt.free()
    return rate
  }
}

/** 全局单例 */
export const failureDatabase = new FailureDatabase()
