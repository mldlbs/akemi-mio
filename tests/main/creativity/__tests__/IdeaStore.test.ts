import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { IdeaStore } from '@akemi-mio/creativity/IdeaStore'
import type { Hypothesis } from '@akemi-mio/creativity/types'

function makeHyp(partial: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id: 'h1',
    title: '点子',
    idea: '内容',
    expectedBenefit: '',
    risk: '',
    sourceLabels: [],
    novelty: 50,
    feasibility: 50,
    impact: 50,
    status: 'draft',
    createdAt: Date.now(),
    ...partial,
  }
}

let dir: string
let store: IdeaStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'idea-store-'))
  store = new IdeaStore(join(dir, 'creativity.json'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('IdeaStore 发酵方法', () => {
  it('getFermentableHypotheses 只返回 draft 并按综合分降序', () => {
    store.addHypothesis(makeHyp({ id: 'd1', status: 'draft', novelty: 60, feasibility: 60, impact: 60 }))
    store.addHypothesis(makeHyp({ id: 'a1', status: 'active' }))
    store.addHypothesis(makeHyp({ id: 'd2', status: 'draft', novelty: 80, feasibility: 80, impact: 80 }))
    const list = store.getFermentableHypotheses()
    expect(list.map((h) => h.id)).toEqual(['d2', 'd1'])
  })

  it('updateHypothesisFermentation 合并 patch 并持久化', () => {
    store.addHypothesis(makeHyp({ id: 'd1', status: 'draft' }))
    const ok = store.updateHypothesisFermentation('d1', {
      status: 'active',
      fermentCount: 2,
      lastFermentedAt: 123,
      fermentLog: [{ at: 123, verdict: 'keep', reason: 'ok' }],
      novelty: 77,
    })
    expect(ok).toBe(true)
    const reloaded = new IdeaStore(join(dir, 'creativity.json')).getHypotheses()
    const h = reloaded.find((x) => x.id === 'd1')!
    expect(h.status).toBe('active')
    expect(h.fermentCount).toBe(2)
    expect(h.novelty).toBe(77)
    expect(h.fermentLog?.[0].verdict).toBe('keep')
  })

  it('updateHypothesisFermentation 对不存在的 id 返回 false', () => {
    expect(store.updateHypothesisFermentation('nope', { status: 'active' })).toBe(false)
  })
})
