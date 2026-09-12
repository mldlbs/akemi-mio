import { describe, it, expect, vi } from 'vitest'
import { CreativityCollector } from '@akemi-mio/evolution/automation/CreativityCollector'
import type { Hypothesis } from '@akemi-mio/creativity/types'

function makeHyp(partial: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id: 'h1',
    title: '点子',
    idea: '这是一个足够完整的候选想法，包含明确价值、实施方向和可验证结果。',
    expectedBenefit: '',
    risk: '',
    sourceLabels: [],
    novelty: 70,
    feasibility: 70,
    impact: 70,
    status: 'active',
    createdAt: Date.now(),
    ...partial,
  }
}

describe('CreativityCollector', () => {
  it('只采集 status=active 的假设', async () => {
    const store = {
      getHypotheses: vi.fn(() => [makeHyp({ id: 'd1', status: 'draft' }), makeHyp({ id: 'a1', status: 'active' })]),
    }
    const collector = new CreativityCollector(store as any)
    const problems = await collector.collect()
    expect(problems.map((p) => p.id)).toEqual(['feature:a1'])
  })

  it('无 active 时返回空数组', async () => {
    const store = {
      getHypotheses: vi.fn(() => [makeHyp({ id: 'd1', status: 'draft' })]),
    }
    const collector = new CreativityCollector(store as any)
    expect(await collector.collect()).toEqual([])
  })
})
