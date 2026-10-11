import { describe, expect, it } from 'vitest'
import { deriveMechanismGraph, relationsToEdges, isMechanismHypothesis } from '@akemi-mio/creativity/MechanismGraph'

describe('MechanismGraph v0 derived read model (P1, D2/D3/A6)', () => {
  it('aggregates by (agent, capabilityId, outcome) and counts occurrences', () => {
    const graph = deriveMechanismGraph([
      { agent: 'opencode', outcome: 'success', payload: { capabilityId: 'browser.automation' } },
      { agent: 'opencode', outcome: 'success', payload: { capabilityId: 'browser.automation' } },
      { agent: 'codex', outcome: 'failure', payload: { capabilityId: 'browser.automation' } },
    ])
    expect(graph.eventCount).toBe(3)
    expect(graph.edges).toHaveLength(2)
    expect(graph.edges[0]).toMatchObject({
      agent: 'opencode',
      capabilityId: 'browser.automation',
      outcome: 'success',
      count: 2,
    })
    expect(graph.edges[1]).toMatchObject({ agent: 'codex', outcome: 'failure', count: 1 })
  })

  it('skips events without a capabilityId in payload', () => {
    const graph = deriveMechanismGraph([
      { agent: 'opencode', outcome: 'success', payload: {} },
      { agent: 'opencode', outcome: 'success', payload: { capabilityId: 'publishing' } },
      { outcome: 'success', payload: { capabilityId: 'publishing' } },
    ])
    expect(graph.eventCount).toBe(2)
    // agent 缺省落 unknown，与 opencode 分属不同边
    expect(graph.edges).toHaveLength(2)
    expect(graph.edges.map((e) => e.agent).sort()).toEqual(['opencode', 'unknown'])
  })

  it('maps identity inference to high confidence and pure inferred to low (A6)', () => {
    const graph = deriveMechanismGraph([
      { agent: 'a', outcome: 'ok', payload: { capabilityId: 'cap.x', inference: 'identity' } },
      { agent: 'a', outcome: 'ok', payload: { capabilityId: 'cap.x', inference: 'inferred' } },
      { agent: 'b', outcome: 'ok', payload: { capabilityId: 'cap.y' } },
    ])
    const byAgent = new Map(graph.edges.map((e) => [e.agent, e]))
    expect(byAgent.get('a')!.confidence).toBe('high')
    expect(byAgent.get('a')!.inferences).toEqual(expect.arrayContaining(['identity', 'inferred']))
    expect(byAgent.get('b')!.confidence).toBe('low')
    expect(byAgent.get('b')!.inferences).toEqual(['inferred'])
  })

  it('defaults missing agent/outcome to unknown', () => {
    const graph = deriveMechanismGraph([{ payload: { capabilityId: 'cap.z' } }])
    expect(graph.edges[0]).toMatchObject({ agent: 'unknown', outcome: 'unknown' })
  })

  it('sorts edges by count desc then key asc', () => {
    const graph = deriveMechanismGraph([
      { agent: 'z', outcome: 'ok', payload: { capabilityId: 'cap' } },
      { agent: 'a', outcome: 'ok', payload: { capabilityId: 'cap' } },
      { agent: 'z', outcome: 'ok', payload: { capabilityId: 'cap' } },
    ])
    expect(graph.edges.map((e) => e.agent)).toEqual(['z', 'a'])
  })

  it('relationsToEdges projects proposedRelations with confidence from inference', () => {
    const edges = relationsToEdges('h-1', [
      { from: 'reading', to: 'summary.quality', effect: 'improves', inference: 'identity' },
      { from: 'reading', to: 'latency', effect: 'worsens' },
    ])
    expect(edges).toHaveLength(2)
    expect(edges[0].confidence).toBe('high')
    expect(edges[1].confidence).toBe('low')
    expect(edges[1].inferences).toEqual(['inferred'])
  })

  it('isMechanismHypothesis: proposedRelations present and non-empty → mechanism, else ordinary', () => {
    expect(isMechanismHypothesis({ proposedRelations: [{ from: 'a', to: 'b', effect: 'e' }] })).toBe(true)
    expect(isMechanismHypothesis({ proposedRelations: [] })).toBe(false)
    expect(isMechanismHypothesis({})).toBe(false)
  })
})
