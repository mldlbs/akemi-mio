/**
 * CheckpointTracker — R2-B: Projection Replay Checkpoint
 *
 * 职责：
 * - 记录 projection 最后一次成功处理的 seq
 * - 从中断处恢复（断点续传）
 *
 * 不变量 R2-I2：
 * Checkpoint 表不是 Event-sourced。丢失意味着全量重建，不是数据丢失。
 */

import { log } from '../../logger/Logger'

type RawDb = {
  run: (sql: string, params?: any[]) => void
  query: (sql: string, params?: any[]) => Record<string, any>[]
}

export type CheckpointStatus = 'idle' | 'running' | 'failed'

export class CheckpointTracker {
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

  /** 读取指定 projection 的 checkpoint。不存在时返回 null（应从头构建）。 */
  async loadCheckpoint(projectionName: string): Promise<{ lastSeq: number; status: CheckpointStatus } | null> {
    try {
      const r = await this.ensureRaw()
      if (!r) return null
      const rows = r.query('SELECT last_seq, status FROM projection_checkpoints WHERE projection_name = ?', [projectionName])
      if (rows.length === 0) return null
      return { lastSeq: Number(rows[0].last_seq), status: rows[0].status as CheckpointStatus }
    } catch {
      return null
    }
  }

  /** 标记 checkpoint 开始。返回成功与否（表不存在时静默失败）。 */
  async beginCheckpoint(projectionName: string, fromSeq: number): Promise<void> {
    try {
      const r = await this.ensureRaw()
      if (!r) return
      r.run(
        `INSERT OR REPLACE INTO projection_checkpoints (projection_name, last_seq, last_updated_at, status)
         VALUES (?, ?, ?, 'running')`,
        [projectionName, fromSeq, Date.now()],
      )
    } catch {
      // checkpoint 表不存在时静默失败
    }
  }

  /** 更新 checkpoint seq（构建中周期性调用）。 */
  async updateCheckpoint(projectionName: string, lastSeq: number): Promise<void> {
    try {
      const r = await this.ensureRaw()
      if (!r) return
      r.run(`UPDATE projection_checkpoints SET last_seq = ?, last_updated_at = ? WHERE projection_name = ?`, [
        lastSeq,
        Date.now(),
        projectionName,
      ])
    } catch {
      // 静默
    }
  }

  /** 标记 checkpoint 完成。 */
  async completeCheckpoint(projectionName: string, lastSeq: number): Promise<void> {
    try {
      const r = await this.ensureRaw()
      if (!r) return
      r.run(
        `INSERT OR REPLACE INTO projection_checkpoints (projection_name, last_seq, last_updated_at, status)
         VALUES (?, ?, ?, 'idle')`,
        [projectionName, lastSeq, Date.now()],
      )
    } catch {
      // 静默
    }
  }

  /** 标记 checkpoint 失败。 */
  async failCheckpoint(projectionName: string, lastSeq: number, error: string): Promise<void> {
    try {
      const r = await this.ensureRaw()
      if (!r) return
      r.run(
        `INSERT OR REPLACE INTO projection_checkpoints (projection_name, last_seq, last_updated_at, status, error)
         VALUES (?, ?, ?, 'failed', ?)`,
        [projectionName, lastSeq, Date.now(), error.slice(0, 500)],
      )
    } catch {
      // 静默
    }
  }

  /** 删除 checkpoint（触发全量重建）。 */
  async clearCheckpoint(projectionName: string): Promise<void> {
    try {
      const r = await this.ensureRaw()
      if (!r) return
      r.run('DELETE FROM projection_checkpoints WHERE projection_name = ?', [projectionName])
    } catch {
      // 静默
    }
  }
}
