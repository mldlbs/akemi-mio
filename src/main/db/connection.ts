import initSqlJs, { Database as SqlJsDatabase } from 'sql.js'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { log } from '../logger/Logger'
import { WORKSPACE_ROOT } from '../config'
import * as schema from './schema'
import { runMigrations } from './migration'

let db: SqliteRemoteDatabase<typeof schema> | null = null
let sqlite: SqlJsDatabase | null = null
let dbPath = ''
let saveTimer: ReturnType<typeof setInterval> | null = null
let dirty = false
let initializing = false

async function proxyCallback(sql: string, params: any[], method: 'run' | 'get' | 'all' | 'values'): Promise<{ rows: any[] }> {
  if (!sqlite) throw new Error('Database not initialized')

  const convertedSql = sql.replace(/\$\d+/g, '?')

  try {
    if (method === 'run') {
      sqlite.run(convertedSql, params)
      return { rows: [] }
    }

    const stmt = sqlite.prepare(convertedSql)
    stmt.bind(params)

    if (method === 'get') {
      const row = stmt.step() ? stmt.getAsObject() : null
      stmt.free()
      return { rows: row ? [row] : [] }
    }

    if (method === 'values') {
      const rows: any[][] = []
      while (stmt.step()) {
        rows.push(stmt.get())
      }
      stmt.free()
      return { rows }
    }

    const rows: any[] = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject())
    }
    stmt.free()
    return { rows }
  } catch (err: any) {
    log('ERROR', 'db_query_error', { sql: convertedSql.slice(0, 100), error: String(err) })
    throw err
  }
}

export async function initDatabase(): Promise<void> {
  if (db) return
  if (initializing) {
    // Wait until the concurrent initialization finishes
    while (initializing) {
      await new Promise((r) => setTimeout(r, 50))
    }
    return
  }
  initializing = true
  dbPath = join(WORKSPACE_ROOT, 'akemi-mio.db')
  log('INFO', 'db_init', { path: dbPath })

  const SQL = await initSqlJs()
  if (existsSync(dbPath)) {
    const buffer = readFileSync(dbPath)
    sqlite = new SQL.Database(buffer)
  } else {
    sqlite = new SQL.Database()
  }

  sqlite.run('PRAGMA journal_mode = WAL')
  sqlite.run('PRAGMA foreign_keys = ON')

  db = drizzle<typeof schema>(proxyCallback, { schema })

  runMigrations(sqlite)

  saveTimer = setInterval(() => {
    if (dirty && sqlite) {
      const data = sqlite.export()
      writeFileSync(dbPath, Buffer.from(data))
      dirty = false
    }
  }, 10000)

  log('INFO', 'db_ready')
  initializing = false
}

export function getDatabase(): SqliteRemoteDatabase<typeof schema> {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.')
  return db
}

export function markDirty(): void {
  dirty = true
}

export function flushDatabase(): void {
  if (!sqlite || !dbPath) return
  const data = sqlite.export()
  writeFileSync(dbPath, Buffer.from(data))
  dirty = false
  log('INFO', 'db_flushed', { size: data.length })
}

export function closeDatabase(): void {
  if (saveTimer) {
    clearInterval(saveTimer)
    saveTimer = null
  }
  if (sqlite) {
    flushDatabase()
    sqlite.close()
    sqlite = null
    db = null
  }
}

export function getRawDb(): SqlJsDatabase {
  if (!sqlite) throw new Error('Database not initialized')
  return sqlite
}
