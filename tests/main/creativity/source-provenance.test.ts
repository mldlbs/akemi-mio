import { describe, expect, it } from 'vitest'
import type { CreativitySource, Hypothesis } from '@akemi-mio/creativity/types'

describe('creativity source provenance fields', () => {
  it('accepts origin/originId/confidence/timestamp', () => {
    const s: CreativitySource = {
      name: 'decision: use local model',
      content: '…',
      type: 'feedback',
      weight: 0.75,
      origin: 'memory:mem_1',
      originId: 'mem_1',
      confidence: 0.9,
      timestamp: '2026-10-07T00:00:00.000Z',
    }
    expect(s.origin).toBe('memory:mem_1')
  })

  it('keeps legacy sources legal without the new fields', () => {
    const s: CreativitySource = { name: 'a', content: 'b', type: 'knowledge', weight: 0.5 }
    expect(s.origin).toBeUndefined()
  })

  it('records the rotation technique on a hypothesis', () => {
    const h = { id: 'hyp_1', title: 't', idea: 'i', expectedBenefit: '', risk: '', sourceLabels: [], novelty: 50, feasibility: 50, impact: 50, status: 'draft', createdAt: 1 } as Hypothesis
    h.technique = 'SCAMPER'
    expect(h.technique).toBe('SCAMPER')
  })

  it('records idea.generate provenance on a hypothesis', () => {
    const h = { id: 'hyp_2', title: 't', idea: 'i', expectedBenefit: '', risk: '', sourceLabels: [], novelty: 50, feasibility: 50, impact: 50, status: 'draft', createdAt: 1 } as Hypothesis
    h.provenance = {
      strategy: 'stable',
      technique: 'SCAMPER',
      relatedMemoryIds: ['mem_1'],
      sources: [{ name: 'goal: lower MCP latency', type: 'knowledge', origin: 'goal', timestamp: '2026-10-07T00:00:00.000Z' }],
      generatedAt: '2026-10-07T00:00:00.000Z',
    }
    expect(h.provenance.strategy).toBe('stable')
    expect(h.provenance.technique).toBe('SCAMPER')
  })
})
