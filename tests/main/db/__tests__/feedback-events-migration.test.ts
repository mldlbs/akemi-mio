import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

import { MIGRATIONS, runMigrations } from '@akemi-mio/core/db/migration'

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
        reset: () => {
          index = 0
        },
        free() {},
      }
    },
  }
}

describe('migration v51: hypothesis_feedback_events (正向反馈闭环 P0)', () => {
  it('migration versions are strictly unique (v44 撞车教训的前向钉)', () => {
    const versions = MIGRATIONS.map((m) => m.version)
    expect(new Set(versions).size).toBe(versions.length)
    expect(versions).toContain(51)
    const sorted = [...versions].sort((a, b) => a - b)
    expect(versions).toEqual(sorted)
  })

  it('creates the evidence table with idempotency_key UNIQUE and append-only shape', () => {
    const db = new Database(':memory:')
    runMigrations(wrap(db) as any)

    const columns = db.prepare('PRAGMA table_info(hypothesis_feedback_events)').all().map((c: any) => c.name)
    expect(columns).toEqual(
      expect.arrayContaining([
        'id',
        'hypothesis_id',
        'event_type',
        'source_type',
        'source_id',
        'source_version',
        'commit_sha',
        'experiment_run_id',
        'evidence_ref',
        'occurred_at',
        'ingested_at',
        'idempotency_key',
        'schema_version',
      ]),
    )

    const insert = db.prepare(`
      INSERT INTO hypothesis_feedback_events
        (id, hypothesis_id, event_type, source_type, source_id, occurred_at, ingested_at, idempotency_key, schema_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insert.run('e1', 'h-1', 'validated', 'experiment', 'ferment:h-1:1', 1, 2, 'k1', 1)
    // 同 idempotencyKey 第二次插入必须被唯一约束拒绝（重复导入不增样本）
    expect(() => insert.run('e2', 'h-1', 'validated', 'experiment', 'ferment:h-1:1', 1, 3, 'k1', 1)).toThrow()
    // 非法 event_type 被 CHECK 拒绝
    expect(() => insert.run('e3', 'h-1', 'promoted', 'experiment', 's', 1, 2, 'k2', 1)).toThrow()

    const rows = db.prepare('SELECT COUNT(*) AS n FROM hypothesis_feedback_events').get() as { n: number }
    expect(rows.n).toBe(1)
  })
})

describe('migration v52: experiment_runs (正向反馈闭环 P2)', () => {
  it('creates the table with feedback attribution columns', () => {
    const db = new Database(':memory:')
    runMigrations(wrap(db) as any)

    const columns = db.prepare('PRAGMA table_info(experiment_runs)').all().map((c: any) => c.name)
    expect(columns).toEqual(
      expect.arrayContaining([
        'id',
        'hypothesis_id',
        'assignment',
        'outcome',
        'metrics',
        'evidence_ids',
        'feedback_snapshot_version',
        'baseline_version',
        'candidate_version',
        'test_results',
        'regression_results',
        'decision',
      ]),
    )

    const insert = db.prepare(`
      INSERT INTO experiment_runs
        (id, assignment, outcome, metrics, evidence_ids, created_at, feedback_snapshot_version)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    insert.run('run-1', 'candidate', 'success', '{}', '[]', 1, 'snap_abc')
    // 非法 assignment 被 CHECK 拒绝
    expect(() => insert.run('run-2', 'bogus', 'success', '{}', '[]', 1, null)).toThrow()

    const versions = MIGRATIONS.map((m) => m.version)
    expect(versions).toContain(52)
    expect(new Set(versions).size).toBe(versions.length)
  })
})

describe('migration v53: hypotheses.provenance (正向反馈闭环归因断链修复)', () => {
  it('adds the provenance column idempotently and keeps versions unique', () => {
    const db = new Database(':memory:')
    runMigrations(wrap(db) as any)

    const columns = db.prepare('PRAGMA table_info(hypotheses)').all().map((c: any) => c.name)
    expect(columns).toContain('provenance')

    // 已有假设行不受影响；provenance 可空
    const insert = db.prepare(`
      INSERT INTO hypotheses (id, title, idea, expected_benefit, risk, source_labels, novelty, feasibility, impact, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insert.run('h1', 't', 'i', 'b', 'r', '["A","B"]', 60, 60, 60, 'active', 1)
    const row = db.prepare('SELECT provenance FROM hypotheses WHERE id = ?').get('h1') as any
    expect(row.provenance).toBeNull()

    const versions = MIGRATIONS.map((m) => m.version)
    expect(versions).toContain(53)
    expect(new Set(versions).size).toBe(versions.length)
  })
})
