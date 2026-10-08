import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { buildAutoSources, topUpSources, trendSources } = require('../../../packages/mio-cli/server/creativity-sources.js')
const { sourcesFromInsights } = require('../../../packages/mio-cli/server/creativity-engine.js')

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'mio-auto-src-'))
  writeFileSync(join(dataDir, 'memory.jsonl'), [
    JSON.stringify({ id: 'mem_d1', timestamp: '2026-10-06T01:00:00.000Z', kind: 'decision', content: '决定用本地模型兜底', project: 'p', scope: 'project' }),
    JSON.stringify({ id: 'mem_n1', timestamp: '2026-10-06T02:00:00.000Z', kind: 'note', content: '一条普通笔记' }),
    JSON.stringify({ id: 'mem_a1', timestamp: '2026-10-06T03:00:00.000Z', kind: 'decision', content: '已归档决策', archived: true }),
    JSON.stringify({ id: 'mem_t1', timestamp: '2026-10-06T04:00:00.000Z', kind: 'trivia', content: '不是 decision/note' }),
  ].join('\n') + '\n')
  writeFileSync(join(dataDir, 'traces.jsonl'), [
    JSON.stringify({ trace_id: 't1', event_type: 'task_outcome', outcome: 'success', payload: { summary: '任务完成' }, timestamp: '2026-10-06T05:00:00.000Z' }),
    JSON.stringify({ trace_id: 't2', event_type: 'error', payload: { message: 'boom' }, timestamp: '2026-10-06T06:00:00.000Z' }),
  ].join('\n') + '\n')
  mkdirSync(join(dataDir, 'creativity'), { recursive: true })
  writeFileSync(join(dataDir, 'creativity', 'creativity-hypotheses.jsonl'), [
    JSON.stringify({ id: 'hyp_a', title: '旧假设A', idea: '旧想法内容', risk: 'r', status: 'active', createdAt: Date.now() }),
    JSON.stringify({ id: 'hyp_r', title: '被拒假设R', idea: '被拒想法', risk: 'r', status: 'rejected', createdAt: Date.now() }),
    JSON.stringify({ id: 'hyp_d', title: '草稿不该出现', idea: 'd', risk: 'r', status: 'draft', createdAt: Date.now() }),
  ].join('\n') + '\n')
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

describe('buildAutoSources', () => {
  it('collects local domains with required provenance fields', () => {
    const sources = buildAutoSources({ dataDir })
    const byOrigin = new Map(sources.map((s: any) => [s.origin, s]))
    expect(byOrigin.get('memory:mem_d1').type).toBe('feedback')
    expect(byOrigin.get('memory:mem_d1').timestamp).toBe('2026-10-06T01:00:00.000Z')
    expect(byOrigin.has('memory:mem_a1')).toBe(false)   // archived skipped
    expect(byOrigin.has('memory:mem_t1')).toBe(false)   // wrong kind skipped
    expect(byOrigin.get('trace:t1').type).toBe('behavior')
    expect(byOrigin.get('trace:t2').type).toBe('failure')
    expect(byOrigin.get('hypothesis:hyp_a').type).toBe('knowledge')
    expect(byOrigin.get('hypothesis:hyp_r').type).toBe('failure')
    expect(byOrigin.has('hypothesis:hyp_d')).toBe(false) // drafts not offered as evidence
    for (const s of sources) expect(s.weight).toBeGreaterThan(0.7) // IdeaGenerator temp contract
  })

  it('returns an empty list for an empty store', () => {
    const empty = mkdtempSync(join(tmpdir(), 'mio-auto-empty-'))
    try {
      expect(buildAutoSources({ dataDir: empty })).toEqual([])
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('merges insight and trend sources when the caller passes them', () => {
    const sources = buildAutoSources({
      dataDir,
      insights: [{ id: 'ins_1', title: 'LLM 延迟偏高', description: '近三天 p95 上升', score: 80, createdAt: '2026-10-05T00:00:00.000Z' }],
      trends: [{ date: '2026-10-06', summary: '本地推理趋势上升' }],
    })
    const byOrigin = new Map(sources.map((s: any) => [s.origin, s]))
    expect(byOrigin.get('insight:ins_1').type).toBe('insight')
    expect(byOrigin.get('observer-trends:2026-10-06').type).toBe('provocation')
  })
})

describe('topUpSources', () => {
  it('keeps explicit sources untouched when there are already two', () => {
    const explicit = [{ name: 'a', content: '1' }, { name: 'b', content: '2' }]
    expect(topUpSources(explicit, [{ name: 'c', content: '3' }])).toEqual(explicit)
  })

  it('tops a single explicit source up to two, explicit first', () => {
    const out = topUpSources([{ name: 'only', content: 'x' }], [{ name: 'auto1', content: 'y' }, { name: 'auto2', content: 'z' }])
    expect(out.length).toBeGreaterThanOrEqual(2)
    expect(out[0].name).toBe('only')
  })

  it('never injects an auto source that duplicates an explicit name', () => {
    const out = topUpSources([{ name: 'same' }], [{ name: 'same' }, { name: 'other' }])
    expect(out.map((s: any) => s.name)).toEqual(['same', 'other'])
  })

  it('tolerates undefined inputs', () => {
    expect(topUpSources(undefined, undefined)).toEqual([])
  })
})

describe('trendSources', () => {
  it('maps trend reports to provocation sources', () => {
    const out = trendSources([{ date: '2026-10-06', summary: 's' }, { title: 'T', themes: ['a', 'b'] }])
    expect(out[0]).toMatchObject({ type: 'provocation', origin: 'observer-trends:2026-10-06' })
    expect(out[1].content).toContain('a; b')
  })
})

describe('sourcesFromInsights origin fields', () => {
  it('carries origin/originId/timestamp', () => {
    const [s] = sourcesFromInsights([{ id: 'ins_9', title: 't', description: 'd', score: 10, createdAt: '2026-10-05T00:00:00.000Z' }])
    expect(s.origin).toBe('insight:ins_9')
    expect(s.originId).toBe('ins_9')
    expect(s.timestamp).toBe('2026-10-05T00:00:00.000Z')
    expect(s.weight).toBeGreaterThan(0.7)
  })
})
