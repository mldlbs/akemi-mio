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
        const hasTopics = columns.includes('topics')
        this.entries = result[0].values.map((v: any[]) => {
          const obj: any = {}
          for (let i = 0; i < columns.length; i++) obj[columns[i]] = v[i]
          return {
            id: obj.id,
            summary: obj.summary,
            turnStart: obj.turn_start,
            turnEnd: obj.turn_end,
            topics: hasTopics ? this.parseJsonField(obj.topics, []) : [],
            decisions: hasTopics ? this.parseJsonField(obj.decisions, []) : [],
            keyEntities: hasTopics ? this.parseJsonField(obj.key_entities, []) : [],
            createdAt: obj.created_at,
          } as SummaryEntry
        })
      }
      log('INFO', 'summary_loaded', { count: this.entries.length })
    } catch (err) {
      log('WARN', 'summary_load_failed', { error: String(err) })
    }
  }

  private parseJsonField(val: any, fallback: any): any {
    if (val === null || val === undefined) return fallback
    if (Array.isArray(val)) return val
    try {
      return JSON.parse(val)
    } catch {
      return typeof val === 'string' ? [val] : fallback
    }
  }

  addSummary(
    summary: string,
    turnStart: number,
    turnEnd: number,
    options?: { topics?: string[]; decisions?: string[]; keyEntities?: string[] },
  ): void {
    const id = `sum_${Date.now()}_${++idCounter}`
    const entry: SummaryEntry = {
      id,
      summary,
      turnStart,
      turnEnd,
      topics: options?.topics || [],
      decisions: options?.decisions || [],
      keyEntities: options?.keyEntities || [],
      createdAt: Date.now(),
    }
    this.entries.push(entry)
    if (this.entries.length > MAX_SUMMARIES) this.entries = this.entries.slice(-MAX_SUMMARIES)
    this.dirty = true
    this.saveToDb(entry)
    log('INFO', 'summary_added', { turnStart, turnEnd, topics: entry.topics.length })
  }

  getRecent(limit = 5): string[] {
    return this.entries.slice(-limit).map((e) => e.summary)
  }

  getRecentFull(limit = 5): SummaryEntry[] {
    return this.entries.slice(-limit)
  }

  getAll(): SummaryEntry[] {
    return [...this.entries]
  }

  flush(): void {
    if (!this.dirty) return
    this.flushToDb()
    this.dirty = false
  }

  private saveToDb(entry: SummaryEntry): void {
    try {
      const db = getRawDb()
      const info = db.exec('PRAGMA table_info(memory_summaries)')
      const columns = info?.[0]?.values?.map((v: any) => v[1]) || []
      const hasTopics = columns.includes('topics')

      if (hasTopics) {
        db.run(
          `INSERT OR IGNORE INTO memory_summaries (id, summary, turn_start, turn_end, topics, decisions, key_entities, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            entry.id,
            entry.summary,
            entry.turnStart,
            entry.turnEnd,
            JSON.stringify(entry.topics),
            JSON.stringify(entry.decisions),
            JSON.stringify(entry.keyEntities),
            entry.createdAt,
          ],
        )
      } else {
        try {
          db.run("ALTER TABLE memory_summaries ADD COLUMN topics TEXT NOT NULL DEFAULT '[]'")
          db.run("ALTER TABLE memory_summaries ADD COLUMN decisions TEXT NOT NULL DEFAULT '[]'")
          db.run("ALTER TABLE memory_summaries ADD COLUMN key_entities TEXT NOT NULL DEFAULT '[]'")
          markDirty()
          db.run(
            `INSERT OR IGNORE INTO memory_summaries (id, summary, turn_start, turn_end, topics, decisions, key_entities, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              entry.id,
              entry.summary,
              entry.turnStart,
              entry.turnEnd,
              JSON.stringify(entry.topics),
              JSON.stringify(entry.decisions),
              JSON.stringify(entry.keyEntities),
              entry.createdAt,
            ],
          )
        } catch {
          db.run('INSERT OR IGNORE INTO memory_summaries (id, summary, turn_start, turn_end, created_at) VALUES (?, ?, ?, ?, ?)', [
            entry.id,
            entry.summary,
            entry.turnStart,
            entry.turnEnd,
            entry.createdAt,
          ])
        }
      }
      markDirty()
    } catch (err) {
      log('WARN', 'summary_db_write_failed', { error: String(err) })
    }
  }

  private flushToDb(): void {
    try {
      const db = getRawDb()
      const info = db.exec('PRAGMA table_info(memory_summaries)')
      const columns = info?.[0]?.values?.map((v: any) => v[1]) || []
      const hasTopics = columns.includes('topics')

      db.run('BEGIN')
      db.run('DELETE FROM memory_summaries')
      for (const e of this.entries) {
        if (hasTopics) {
          db.run(
            `INSERT INTO memory_summaries (id, summary, turn_start, turn_end, topics, decisions, key_entities, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              e.id,
              e.summary,
              e.turnStart,
              e.turnEnd,
              JSON.stringify(e.topics),
              JSON.stringify(e.decisions),
              JSON.stringify(e.keyEntities),
              e.createdAt,
            ],
          )
        } else {
          db.run('INSERT INTO memory_summaries (id, summary, turn_start, turn_end, created_at) VALUES (?, ?, ?, ?, ?)', [
            e.id,
            e.summary,
            e.turnStart,
            e.turnEnd,
            e.createdAt,
          ])
        }
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
