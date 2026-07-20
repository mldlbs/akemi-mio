/**
 * SqliteCheckpointManager — CheckpointManager 的 SQLite 生产实现。
 *
 * 复用 MockCheckpointManager 已验证的语义契约，
 * 使用 getRawDb() 持久化到 checkpoint_store 表。
 *
 * 不改变 CheckpointManager 接口。
 */

import { getRawDb, markDirty } from '../db/connection'
import type { Checkpoint, CheckpointId, ValidationResult } from './CheckpointTypes'
import type { CheckpointManager, CheckpointContext } from './CheckpointManager'

let idCounter = 0

export class SqliteCheckpointManager implements CheckpointManager {
  async create(context: CheckpointContext): Promise<Checkpoint> {
    const id = `cp_${Date.now()}_${++idCounter}`
    return {
      id,
      taskId: context.taskId,
      schemaVersion: '1.0',
      runtimeCompatibility: { min: '2.0', max: '2.x' },
      taskState: {
        name: context.taskName,
        metadata: context.taskMetadata,
        createdAt: context.taskCreatedAt,
      },
      executionState: {
        workerId: context.executionState?.workerId ?? 'unknown',
        goal: context.executionState?.goal ?? 'unknown',
        step: context.executionState?.step ?? 0,
        lastSafePoint: context.executionState?.lastSafePoint ?? 'before_llm',
        conversationContext: { type: 'reference' as const, messageCount: 0, refId: '', tokenEstimate: 0 },
        pendingToolCalls: [],
      },
      createdAt: Date.now(),
    }
  }

  async save(checkpoint: Checkpoint): Promise<void> {
    const db = getRawDb()
    const data = JSON.stringify(checkpoint)
    const now = Date.now()
    db.run(
      `INSERT INTO checkpoint_store (id, data, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      [checkpoint.id, data, now, now],
    )
    markDirty()
  }

  async load(id: CheckpointId): Promise<Checkpoint> {
    const db = getRawDb()
    const stmt = db.prepare('SELECT data FROM checkpoint_store WHERE id = ?')
    stmt.bind([id])
    if (!stmt.step()) {
      stmt.free()
      throw new Error(`checkpoint not found: ${id}`)
    }
    const row = stmt.getAsObject() as any
    stmt.free()
    return JSON.parse(row.data) as Checkpoint
  }

  validate(checkpoint: Checkpoint): ValidationResult {
    const errors: string[] = []
    const warnings: string[] = []

    if (!checkpoint.schemaVersion) errors.push('schemaVersion is required')
    if (!checkpoint.runtimeCompatibility?.min) errors.push('runtimeCompatibility.min is required')
    if (!checkpoint.taskState?.name) errors.push('taskState.name is required')
    if (!checkpoint.executionState?.workerId) errors.push('executionState.workerId is required')
    if (!checkpoint.id) errors.push('id is required')

    return { ok: errors.length === 0, errors, warnings }
  }

  /** 清空所有 checkpoint（测试用） */
  clear(): void {
    const db = getRawDb()
    db.run('DELETE FROM checkpoint_store')
    markDirty()
  }
}
