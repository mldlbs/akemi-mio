import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

import { runMigrations } from '@akemi-mio/core/db/migration'

function wrap(db: Database.Database) {
  return {
    run(sql: string, params?: any[]) {
      const statements = sql.includes(';') && !params ? sql.split(';').map((value) => value.trim()).filter(Boolean) : [sql]
      for (const statement of statements) db.prepare(statement).run(params || [])
    },
    exec(sql: string) {
      const statement = db.prepare(sql)
      const columns = statement.columns().map((column) => column.name)
      const rows = statement.all() as Record<string, unknown>[]
      return rows.length ? [{ columns, values: rows.map((row) => columns.map((column) => row[column])) }] : []
    },
    prepare(sql: string) {
      const rows = db.prepare(sql).all() as Record<string, unknown>[]
      let index = 0
      return {
        bind() {},
        step: () => index < rows.length,
        getAsObject: () => rows[index++],
        reset: () => { index = 0 },
        free() {},
      }
    },
  }
}

describe('migration v48: hypothesis metadata', () => {
  it('adds every column used by DrizzleIdeaStore', () => {
    const db = new Database(':memory:')

    runMigrations(wrap(db) as any)

    const columns = db.prepare('PRAGMA table_info(hypotheses)').all().map((column: any) => column.name)
    expect(columns).toEqual(
      expect.arrayContaining(['source_details', 'implemented_commit_sha', 'implemented_at', 'implementation_note']),
    )
    db.close()
  })
})
