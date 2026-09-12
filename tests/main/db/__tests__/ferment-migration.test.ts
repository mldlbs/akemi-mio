import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@akemi-mio/core/db/migration'

type RawDb = Database.Database

/** 构造与 CompatDatabase 行为对齐的最小适配器（run/exec/prepare） */
function wrap(db: RawDb) {
  return {
    run: (sql: string, params?: any[]) => {
      // 与 CompatDatabase.run 一致：无参数时按 ';' 拆分多语句
      const stmts =
        sql.includes(';') && !params
          ? sql
              .split(';')
              .map((s) => s.trim())
              .filter(Boolean)
          : [sql]
      for (const s of stmts) {
        if (s) db.prepare(s).run(params || [])
      }
    },
    exec: (sql: string) => {
      const stmt = db.prepare(sql)
      const columns = stmt.columns().map((c: any) => c.name)
      const rows = stmt.all()
      return rows.length > 0 ? [{ columns, values: rows.map((r: any) => columns.map((c: string) => r[c])) }] : []
    },
    prepare: (sql: string) => {
      const stmt = db.prepare(sql)
      const rows = stmt.all()
      let index = 0
      return {
        bind: () => {},
        step: () => index < rows.length,
        getAsObject: () => rows[index++] as Record<string, any>,
        reset: () => {
          index = 0
        },
        free: () => {},
      }
    },
  }
}

function createHypotheses(db: RawDb, withFermentColumns: boolean): void {
  const base = [
    'id TEXT PRIMARY KEY',
    'title TEXT',
    'idea TEXT',
    'expected_benefit TEXT',
    'risk TEXT',
    'source_labels TEXT',
    'novelty INTEGER',
    'feasibility INTEGER',
    'impact INTEGER',
    'status TEXT',
    'created_at INTEGER',
  ]
  if (withFermentColumns) {
    base.push('ferment_count INTEGER NOT NULL DEFAULT 0', 'last_fermented_at INTEGER', 'ferment_log TEXT', 'merged_into TEXT')
  }
  db.exec(`CREATE TABLE hypotheses (${base.join(', ')})`)
}

/** 模拟已记录 v1..v44 的 _migrations（v44 曾因版本号撞车未真正加列） */
function recordMigrationsUpTo44(db: RawDb): void {
  db.exec('CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)')
  const stmt = db.prepare('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)')
  for (let v = 1; v <= 44; v++) stmt.run(v, Date.now())
}

describe('migration v47: hypotheses 发酵字段', () => {
  it('v44 撞车库（已记 v44 但无发酵列）：补上全部发酵字段', () => {
    const db = new Database(':memory:')
    createHypotheses(db, false)
    recordMigrationsUpTo44(db)

    runMigrations(wrap(db) as any)

    const columns = db
      .prepare('PRAGMA table_info(hypotheses)')
      .all()
      .map((c: any) => c.name)
    expect(columns).toEqual(expect.arrayContaining(['ferment_count', 'last_fermented_at', 'ferment_log', 'merged_into']))
    db.close()
  })

  it('新库（v44 已真正加列）：v47 幂等跳过，不报错', () => {
    const db = new Database(':memory:')
    createHypotheses(db, true)
    recordMigrationsUpTo44(db)

    expect(() => runMigrations(wrap(db) as any)).not.toThrow()

    const columns = db
      .prepare('PRAGMA table_info(hypotheses)')
      .all()
      .map((c: any) => c.name)
    expect(columns).toEqual(expect.arrayContaining(['ferment_count', 'last_fermented_at', 'ferment_log', 'merged_into']))
    db.close()
  })

  it('全新空库：全量迁移含 v47 一次跑通', () => {
    const db = new Database(':memory:')

    expect(() => runMigrations(wrap(db) as any)).not.toThrow()

    const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='hypotheses'").get()
    expect(hasTable).toBeTruthy()
    const columns = db
      .prepare('PRAGMA table_info(hypotheses)')
      .all()
      .map((c: any) => c.name)
    expect(columns).toEqual(expect.arrayContaining(['ferment_count', 'last_fermented_at', 'ferment_log', 'merged_into']))
    db.close()
  })
})
