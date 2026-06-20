import { log } from '../logger/Logger'
import type { SummaryEntry } from './types'
import { getRawDb, markDirty } from '../db/connection'

let idCounter = 0

const MAX_SUMMARIES = 50

export class SummaryMemory {
  private entries: SummaryEntry[] = []
  private dirty = false

  constructor() {
    this.load()
  }

  private load(): void {
    try {
      const db = getRawDb()
      const result = db.exec('SELECT * FROM memory_summaries ORDER BY created_at ASC')
      if (result && result.length > 0) {
        const columns = result[0].columns
        this.entries = result[0].values.map((v: any[]) => {
          const obj: any = {}
          for (let i = 0; i < columns.length; i++) obj[columns[i]] = v[i]
          return {
            id: obj.id,
            summary: obj.summary,
            turnStart: obj.turn_start,
            turnEnd: obj.turn_end,
            createdAt: obj.created_at,
          } as SummaryEntry
        })
      }
      log('INFO', 'summary_loaded', { count: this.entries.length })
    } catch (err) {
      log('WARN', 'summary_load_failed', { error: String(err) })
    }
  }

  addSummary(summary: string, turnStart: number, turnEnd: number): void {
    const id = `sum_${Date.now()}_${++idCounter}`
    this.entries.push({ id, summary, turnStart, turnEnd, createdAt: Date.now() })
    if (this.entries.length > MAX_SUMMARIES) this.entries = this.entries.slice(-MAX_SUMMARIES)
    this.dirty = true
    this.saveToDb(id, summary, turnStart, turnEnd)
    log('INFO', 'summary_added', { turnStart, turnEnd })
  }

  getRecent(limit = 5): string[] {
    return this.entries.slice(-limit).map((e) => e.summary)
  }

  getAll(): SummaryEntry[] {
    return [...this.entries]
  }

  flush(): void {
    if (!this.dirty) return
    this.flushToDb()
    this.dirty = false
  }

  private saveToDb(id: string, summary: string, turnStart: number, turnEnd: number): void {
    try {
      const db = getRawDb()
      db.run('INSERT OR IGNORE INTO memory_summaries (id, summary, turn_start, turn_end, created_at) VALUES (?, ?, ?, ?, ?)', [
        id,
        summary,
        turnStart,
        turnEnd,
        Date.now(),
      ])
      markDirty()
    } catch (err) {
      log('WARN', 'summary_db_write_failed', { error: String(err) })
    }
  }

  private flushToDb(): void {
    try {
      const db = getRawDb()
      db.run('BEGIN')
      db.run('DELETE FROM memory_summaries')
      for (const e of this.entries) {
        db.run('INSERT INTO memory_summaries (id, summary, turn_start, turn_end, created_at) VALUES (?, ?, ?, ?, ?)', [
          e.id,
          e.summary,
          e.turnStart,
          e.turnEnd,
          e.createdAt,
        ])
      }
      db.run('COMMIT')
      markDirty()
      log('INFO', 'summary_flushed', { count: this.entries.length })
    } catch (err) {
      try {
        getRawDb().run('ROLLBACK')
      } catch {}
      log('ERROR', 'summary_flush_failed', { error: String(err) })
    }
  }
}
