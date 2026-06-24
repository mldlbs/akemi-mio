import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDatabase, closeDatabase, getRawDb } from '../connection'
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'

vi.mock('../../logger/Logger', () => ({ log: vi.fn() }))

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((sorted.length * p) / 100) - 1
  return sorted[Math.max(0, idx)]
}

function report(label: string, samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  const p50 = percentile(sorted, 50)
  const p95 = percentile(sorted, 95)
  const p99 = percentile(sorted, 99)
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length
  console.table([{ label, avg: avg.toFixed(3), p50, p95, p99, min: sorted[0], max: sorted[sorted.length - 1], count: samples.length }])
}

describe('DB Benchmark', () => {
  beforeEach(async () => {
    const dbPath = join(process.cwd(), 'akemi-mio.db')
    if (existsSync(dbPath)) unlinkSync(dbPath)
    process.env.USER_DATA_DIR = process.cwd()
    await initDatabase()
  })

  afterEach(() => {
    closeDatabase()
    const dbPath = join(process.cwd(), 'akemi-mio.db')
    if (existsSync(dbPath)) unlinkSync(dbPath)
  })

  it('INSERT 单条延迟', () => {
    const db = getRawDb()
    const samples: number[] = []
    for (let i = 0; i < 1000; i++) {
      const t0 = performance.now()
      db.run('INSERT INTO agent_events (id, timestamp, event_type, agent_id, source, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        `bench_${i}`,
        Date.now(),
        'tool_invoked',
        'bench',
        'system',
        '{}',
        Date.now(),
      ])
      samples.push(performance.now() - t0)
    }
    report('INSERT single row', samples)
    expect(samples.length).toBe(1000)
  })

  it('SELECT by PK 延迟', () => {
    const db = getRawDb()
    for (let i = 0; i < 1000; i++) {
      db.run('INSERT INTO agent_events (id, timestamp, event_type, agent_id, source, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        `sel_${i}`,
        Date.now(),
        'tool_failed',
        'bench',
        'system',
        '{}',
        Date.now(),
      ])
    }
    const samples: number[] = []
    for (let i = 0; i < 1000; i++) {
      const t0 = performance.now()
      const r = db.exec(`SELECT * FROM agent_events WHERE id = 'sel_${i}'`)
      samples.push(performance.now() - t0)
      expect(r[0]?.values.length).toBe(1)
    }
    report('SELECT by PK', samples)
  })

  it('批量 INSERT 100 条延迟', () => {
    const db = getRawDb()
    const runCount = 10
    const samples: number[] = []
    let idCounter = 0
    for (let r = 0; r < runCount; r++) {
      const t0 = performance.now()
      db.run('BEGIN')
      for (let i = 0; i < 100; i++) {
        const id = `batch_${r}_${i}`
        idCounter++
        db.run('INSERT INTO agent_events (id, timestamp, event_type, agent_id, source, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
          id,
          Date.now(),
          'tool_invoked',
          'bench',
          'system',
          '{}',
          Date.now(),
        ])
      }
      db.run('COMMIT')
      samples.push(performance.now() - t0)
    }
    report('INSERT 100 in transaction', samples)
    expect(idCounter).toBe(1000)
  })

  it('索引扫描延迟（10000 行表上 SELECT by event_type）', () => {
    const db = getRawDb()
    const types = ['tool_invoked', 'tool_completed', 'tool_failed', 'error', 'input_received']
    for (let i = 0; i < 10000; i++) {
      db.run('INSERT INTO agent_events (id, timestamp, event_type, agent_id, source, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        `scan_${i}`,
        Date.now(),
        types[i % types.length],
        'bench',
        'system',
        '{}',
        Date.now(),
      ])
    }
    const samples: number[] = []
    for (const t of types) {
      const t0 = performance.now()
      const r = db.exec(`SELECT COUNT(*) AS c FROM agent_events WHERE event_type = '${t}'`)
      samples.push(performance.now() - t0)
      expect(Number(r[0]?.values[0]?.[0] || 0)).toBe(2000)
    }
    report('SELECT by indexed column', samples)
  })

  it('8 并发 reader 不崩溃', async () => {
    const db = getRawDb()
    for (let i = 0; i < 500; i++) {
      db.run('INSERT INTO agent_events (id, timestamp, event_type, agent_id, source, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        `con_${i}`,
        Date.now(),
        'tool_invoked',
        'bench',
        'system',
        '{}',
        Date.now(),
      ])
    }

    const readers = Array.from({ length: 8 }, (_, idx) => async () => {
      const reads: number[] = []
      for (let i = 0; i < 50; i++) {
        const t0 = performance.now()
        db.exec('SELECT COUNT(*) AS c FROM agent_events')
        reads.push(performance.now() - t0)
      }
      return reads
    })

    const results = await Promise.all(readers.map((fn) => fn()))
    const all = results.flat()
    report('8 concurrent readers', all)
    expect(all.length).toBe(400)
  })
})
