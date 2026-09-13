import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { log } from '../logger/Logger'
import { WORKSPACE } from '../config/index'
import * as schema from './schema'
import { events } from './schema/events'
import { evaluationEvents } from './schema/evaluation_events'
import { runMigrations } from './migration'

// =============================================================================
// sql.js 兼容包装层 — 让 100+ 处 getRawDb() 调用方不改代码
// 底层使用 better-sqlite3（mmap 按需加载）
// =============================================================================

export class CompatStatement {
  private stmt: any
  private _columns: string[] = []
  private _rows: any[] | null = null
  private _rowIndex: number = 0

  /**
   * better-sqlite3 的 columns() **只对返回数据的语句有效**：
   * `prepare('UPDATE ...')` / `prepare('INSERT ...')` 调它会抛
   * `TypeError: The columns() method is only for statements that return data`。
   *
   * 构造期无条件取列名 = 所有写语句的 prepare 直接失败。受害最重的是
   * migrateLegacyEvents()：它在 prepare 抛错后连 DROP TABLE 都走不到，
   * 于是迁移永远失败、表永远不删，每次启动重试一遍，旧事件永远进不了新库。
   * 真实用户库有历史数据时才会触发，dev/测试的空库整段被跳过，所以一直没暴露。
   */
  private static readColumns(stmt: any): string[] {
    try {
      return stmt.columns().map((c: any) => c.name)
    } catch {
      return []
    }
  }

  constructor(stmt: any) {
    this.stmt = stmt
    this._columns = CompatStatement.readColumns(stmt)
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
    if (this._rowIndex >= this._rows!.length) return false
    this._currentRow = this._rows![this._rowIndex]
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
    // better-sqlite3 的 Statement 没有 reset()（sql.js / node:sqlite 才有，
    // step() 与 free() 同样不存在，见上面两处兼容处理）。迁移与分类回填的循环
    // 每一步都调 reset，裸透传会在第一次迭代就抛 TypeError，整段被外层 catch 吞掉。
    //
    // 只重置本地游标，**不要清空 _rows**：写语句的 _rows 是 step() 里兜底得到的
    // 空数组，清掉会让下一次 step() 重新 run() —— 同一条写语句被执行两遍。
    if (typeof this.stmt.reset === 'function') {
      try {
        this.stmt.reset()
      } catch {}
    }
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

export class CompatDatabase {
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

function getDatabaseDirectory(): string {
  return process.env.USER_DATA_DIR ? join(process.env.USER_DATA_DIR, 'databases') : WORKSPACE.databases
}

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
  const dbDir = getDatabaseDirectory()
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
        const { classifyContent } = await import('@akemi-mio/intelligence/agent/ContentClassifier')
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
  initPromise = null
}
