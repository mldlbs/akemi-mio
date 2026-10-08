import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { CreativityEngine } = require('../../../packages/mio-cli/server/creativity-engine.js')

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'mio-sort-vitest-'))
  const dir = join(dataDir, 'creativity')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'creativity-hypotheses.jsonl'), [
    JSON.stringify({ id: 'h1', title: 'Low novelty idea', idea: 'boring distinct text one', novelty: 20, feasibility: 50, impact: 50, status: 'active', createdAt: 1 }),
    JSON.stringify({ id: 'h2', title: 'High novelty idea', idea: 'exciting unrelated text two', novelty: 90, feasibility: 50, impact: 50, status: 'active', createdAt: 2 }),
  ].join('\n') + '\n')
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

describe('creativity list sort=novelty', () => {
  it('orders by noveltyScore descending and keeps it distinct from score', async () => {
    const engine = new CreativityEngine(join(dataDir, 'creativity'), async () => ({ data: [] }))
    const rows = engine.list({ sort: 'novelty' })
    expect(rows.map((r: any) => r.id)).toEqual(['h2', 'h1'])
    expect(typeof rows[0].noveltyScore).toBe('number')
    expect(rows[0].noveltyScore).not.toBe(rows[0].score)
  })

  it('default listing is unchanged (newest 20, no noveltyScore)', async () => {
    const engine = new CreativityEngine(join(dataDir, 'creativity'), async () => ({ data: [] }))
    const rows = engine.list({})
    expect(rows.length).toBe(2)
    expect(rows[0].noveltyScore).toBeUndefined()
    // plan typo: says toBe(160) but the comment math (20 + 50 + 50) and the
    // legacy quality sum both give 120 — see plan Task 9 Step 3 deviation note
    expect(rows[0].score).toBe(120) // 20 + 50 + 50 — legacy quality sum untouched
  })
})
