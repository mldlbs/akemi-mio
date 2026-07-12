import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { join, dirname } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { log } from '../logger/Logger'
import { WORKSPACE } from '../config'
import * as schema from './schema'
import { events } from './schema/events'
import { evaluationEvents } from './schema/evaluation_events'
import { runMigrations } from './migration'

// =============================================================================
// sql.js 兼容包装层 — 让 100+ 处 getRawDb() 调用方不改代码
// 底层使用 better-sqlite3（mmap 按需加载）
// =============================================================================

class CompatStatement {
  private stmt: any
  private _columns: string[] = []
  private _rows: any[] | null = null
  private _rowIndex: number = 0

  constructor(stmt: any) {
    this._columns = stmt.columns().map((c: any) => c.name)
    this.stmt = stmt
  }

  bind(params: any[]): this {
    if (params && params.length > 0) {
      try {
        this.stmt.bind(...params)
      } catch {}
    }
    return this
  }
  step(): boolean {
    if (this._rows === null) {
      try {
        this._rows = this.stmt.all()
      } catch {
        try {
          this.stmt.run()
        } catch {}
        this._rows = []
      }
      this._rowIndex = 0
    }
    if (this._rowIndex >= this._rows.length) return false
    this._currentRow = this._rows[this._rowIndex]
    this._rowIndex++
    return true
  }
  private _currentRow: any = null
  getAsObject(): Record<string, any> {
    return this._currentRow || {}
  }
  get(): any[] {
    if (!this._currentRow) return []
    return this._columns.map((c: string) => this._currentRow[c])
  }
  reset(): void {
    this.stmt.reset()
    this._currentRow = null
    this._rowIndex = 0
  }
  free(): void {
    try {
      this.stmt.finalize()
      this._rows = null
      this._currentRow = null
    } catch {}
  }
}

class CompatDatabase {
  private db: any
  constructor(db: any) {
    this.db = db
  }

  run(sql: string, params?: any[]): void {
    const stmts =
      sql.includes(';') && !params
        ? sql
            .split(';')
            .map((s) => s.trim())
            .filter(Boolean)
        : [sql]
    for (const s of stmts) {
      if (s) this.db.prepare(s).run(params || [])
    }
  }

  prepare(sql: string): CompatStatement {
    return new CompatStatement(this.db.prepare(sql))
  }

  exec(sql: string, params?: any[]): Array<{ columns: string[]; values: any[][] }> {
    const isSelect = sql.trim().toUpperCase().startsWith('SELECT')
    if (!isSelect) {
      this.db.exec(sql)
      return []
    }
    try {
      const stmt = this.db.prepare(sql)
      const columns = stmt.columns().map((c: any) => c.name)
      const rows = params ? stmt.all(...params) : stmt.all()
      const values = rows.map((r: any) => columns.map((c: string) => r[c]))
      return values.length > 0 ? [{ columns, values }] : []
    } catch {
      return []
    }
  }

  close(): void {
    this.db.close()
  }

  getRowsModified(): number {
    return this.db.changes
  }
}

// =============================================================================
// 全局实例
// =============================================================================

let mainDb: CompatDatabase | null = null
let mainNativeDb: any = null
let mainDrizzle: BetterSQLite3Database<typeof schema> | null = null

let eventDb: CompatDatabase | null = null
let eventNativeDb: any = null
let eventDrizzle: BetterSQLite3Database<{ events: typeof events; evaluationEvents: typeof evaluationEvents }> | null = null

let initializing = false
let initPromise: Promise<void> | null = null

// =============================================================================
// 初始化
// =============================================================================

export async function initDatabase(): Promise<void> {
  if (mainDb && eventDb) return
  if (initPromise) return initPromise
  if (initializing) {
    while (initializing) {
      await new Promise((r) => setTimeout(r, 5))
    }
    return
  }

  initializing = true
  const dbDir = WORKSPACE.databases
  const mainPath = join(dbDir, 'main.db')
  const eventPath = join(dbDir, 'events.db')
  log('INFO', 'db_init', { main: mainPath, events: eventPath })

  initPromise = (async () => {
    mkdirSync(dbDir, { recursive: true })

    mainNativeDb = new Database(mainPath, { readonly: false, fileMustExist: false })
    mainNativeDb.pragma('journal_mode = WAL')
    mainNativeDb.pragma('foreign_keys = ON')
    mainNativeDb.pragma('synchronous = NORMAL')
    mainNativeDb.pragma('cache_size = -64000')
    mainDb = new CompatDatabase(mainNativeDb)
    mainDrizzle = drizzle<typeof schema>(mainNativeDb, { schema })
    runMigrations(mainDb)

    eventNativeDb = new Database(eventPath, { readonly: false, fileMustExist: false })
    eventNativeDb.pragma('journal_mode = WAL')
    eventNativeDb.pragma('synchronous = NORMAL')
    eventNativeDb.pragma('cache_size = -64000')
    eventDb = new CompatDatabase(eventNativeDb)
    eventDrizzle = drizzle<{ events: typeof events; evaluationEvents: typeof evaluationEvents }>(eventNativeDb, {
      schema: { events, evaluationEvents },
    })
    eventDb.run(
      `CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, payload TEXT NOT NULL, source TEXT, trace_id TEXT, timestamp INTEGER NOT NULL)`,
    )
    eventDb.run(`CREATE INDEX IF NOT EXISTS idx_events_channel_ts ON events(channel, timestamp)`)
    eventDb.run(
      `CREATE TABLE IF NOT EXISTS evaluation_events (id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, trace_id TEXT NOT NULL, session_id TEXT NOT NULL, source TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, parent_event_id TEXT, seq INTEGER)`,
    )
    eventDb.run(`CREATE INDEX IF NOT EXISTS idx_ev_timestamp ON evaluation_events(timestamp)`)
    eventDb.run(`CREATE INDEX IF NOT EXISTS idx_ev_trace_ts ON evaluation_events(trace_id, timestamp)`)
    eventDb.run(`CREATE INDEX IF NOT EXISTS idx_ev_seq ON evaluation_events(seq)`)

    await migrateLegacyEvents()

    try {
      const rows = mainDb.exec(
        `SELECT id, content, session_id FROM messages WHERE role = 'user' AND category = 'chat' ORDER BY created_at ASC`,
      )
      if (rows.length && rows[0].values.length) {
        const { classifyContent } = await import('../agent/ContentClassifier')
        const cols = rows[0].columns
        const idIdx = cols.indexOf('id')
        const contentIdx = cols.indexOf('content')
        const sessionIdx = cols.indexOf('session_id')
        const stmt1 = mainDb.prepare('UPDATE messages SET category = ? WHERE id = ?')
        const stmt2 = mainDb.prepare('UPDATE messages SET category = ? WHERE session_id = ? AND role = ? AND category = ?')
        for (const row of rows[0].values) {
          const content = String(row[contentIdx] || '')
          const cat = classifyContent(content)
          if (cat !== 'chat') {
            const id = String(row[idIdx])
            stmt1.bind([cat, id])
            stmt1.step()
            stmt1.reset()
            const sessionId = row[sessionIdx] as string | null
            if (sessionId) {
              stmt2.bind([cat, sessionId, 'assistant', 'chat'])
              stmt2.step()
              stmt2.reset()
            }
          }
        }
        stmt1.free()
        stmt2.free()
      }
    } catch (err) {
      log('ERROR', 'db_backfill_categories_failed', { error: String(err) })
    }

    log('INFO', 'db_ready', { mainSize: getFileSize(mainPath), eventsSize: getFileSize(eventPath) })
    initializing = false
  })()

  return initPromise
}

async function migrateLegacyEvents(): Promise<void> {
  const oldRows = mainDb!.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
  if (!oldRows.length || !oldRows[0].values.length) return
  log('INFO', 'db_legacy_events_migration_start')

  try {
    const src = mainDb!.exec('SELECT * FROM events ORDER BY id')
    if (src.length && src[0].values.length) {
      const cols = src[0].columns
      const stmt = eventDb!.prepare(`INSERT OR IGNORE INTO events (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      for (const row of src[0].values) {
        stmt.bind(row)
        stmt.step()
        stmt.reset()
      }
      stmt.free()
      log('INFO', 'db_legacy_events_migrated', { count: src[0].values.length })
    }
    const evalRows = mainDb!.exec('SELECT * FROM evaluation_events ORDER BY timestamp')
    if (evalRows.length && evalRows[0].values.length) {
      const cols = evalRows[0].columns
      const stmt = eventDb!.prepare(`INSERT OR IGNORE INTO evaluation_events (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      for (const row of evalRows[0].values) {
        stmt.bind(row)
        stmt.step()
        stmt.reset()
      }
      stmt.free()
      log('INFO', 'db_legacy_eval_events_migrated', { count: evalRows[0].values.length })
    }
    mainDb!.run('DROP TABLE IF EXISTS events')
    mainDb!.run('DROP TABLE IF EXISTS evaluation_events')
    log('INFO', 'db_legacy_events_migration_done')
  } catch (err: any) {
    log('WARN', 'db_legacy_events_migration_failed', { error: String(err) })
  }
}

function getFileSize(p: string): string {
  try {
    const { statSync } = require('fs')
    return (statSync(p).size / 1048576).toFixed(1) + 'MB'
  } catch {
    return '?'
  }
}

export function getDatabase(): BetterSQLite3Database<typeof schema> {
  if (!mainDrizzle) throw new Error('Database not initialized')
  return mainDrizzle
}
export function getEventDatabase(): BetterSQLite3Database<{ events: typeof events; evaluationEvents: typeof evaluationEvents }> {
  if (!eventDrizzle) throw new Error('Database not initialized')
  return eventDrizzle
}
export function getRawDb(): CompatDatabase {
  if (!mainDb) throw new Error('Database not initialized')
  return mainDb
}
export function getEventRawDb(): CompatDatabase {
  if (!eventDb) throw new Error('Database not initialized')
  return eventDb
}
export function markDirty(): void {}
export function flushDatabase(): void {}

export function closeDatabase(): void {
  if (eventNativeDb) {
    try {
      eventNativeDb.close()
    } catch {}
    eventNativeDb = null
    eventDb = null
    eventDrizzle = null
  }
  if (mainNativeDb) {
    try {
      mainNativeDb.close()
    } catch {}
    mainNativeDb = null
    mainDb = null
    mainDrizzle = null
  }
}
