import { describe, expect, it } from 'vitest'
import { buildCreativityPrompt, buildSystemPrompt, pickTechnique, TECHNIQUE_CYCLE } from '@akemi-mio/creativity/CreativityPrompt'

describe('technique rotation', () => {
  it('cycles the five 0.5.2 techniques', () => {
    expect(TECHNIQUE_CYCLE).toEqual(['SCAMPER', 'Analogy', 'First-Principles', 'Random-Stimulus', 'Constraint-Inversion'])
    expect(pickTechnique(0)).toBe('SCAMPER')
    expect(pickTechnique(1)).toBe('Analogy')
    expect(pickTechnique(5)).toBe('SCAMPER')
    expect(pickTechnique(-1)).toBe('Constraint-Inversion')
  })

  it('every technique has a description in the system prompt', () => {
    for (const technique of TECHNIQUE_CYCLE) {
      const prompt = buildSystemPrompt(technique)
      expect(prompt).toContain(`【本轮创新技法：${technique}】`)
      expect(prompt.length).toBeGreaterThan(500)
    }
    expect(buildSystemPrompt()).not.toContain('【本轮创新技法')
  })
})

describe('grouped source presentation', () => {
  const sources = [
    { name: 'decision: use local model', content: '内容A', type: 'knowledge' as const, weight: 0.8, origin: 'memory:mem_1' },
    { name: 'trace: error in collect', content: '内容B', type: 'failure' as const, weight: 0.7, origin: 'trace:t_1', timestamp: '2026-10-07T00:00:00.000Z' },
    { name: 'insight: LLM latency', content: '内容C', type: 'insight' as const, weight: 0.7, origin: 'insight:i_1' },
    { name: 'decision: adopt X', content: '内容D', type: 'knowledge' as const, weight: 0.75, origin: 'memory:mem_2' },
  ]

  it('groups sources under evidence-class headers, prefixed per line', () => {
    const prompt = buildCreativityPrompt(sources, [{ sources: ['decision: use local model', 'trace: error in collect'], description: 'x' }])
    expect(prompt).toContain('【fact · knowledge】')
    expect(prompt).toContain('【failure · failure】')
    expect(prompt).toContain('【observation · insight】')
    expect(prompt).toContain('- [fact] decision: use local model (memory:mem_1): 内容A')
    expect(prompt).toContain('- [failure] trace: error in collect (trace:t_1 @2026-10-07T00:00:00.000Z): 内容B')
    // failure group must not leak knowledge sources
    const failureGroup = prompt.split('【failure · failure】')[1]?.split('【')[0] ?? ''
    expect(failureGroup).not.toContain('decision: adopt X')
    // stable order: fact group comes before failure group
    expect(prompt.indexOf('【fact · knowledge】')).toBeLessThan(prompt.indexOf('【failure · failure】'))
  })

  it('keeps the combo block intact', () => {
    const prompt = buildCreativityPrompt(sources, [{ sources: ['decision: use local model', 'trace: error in collect'], description: '协同机制' }])
    expect(prompt).toContain('【推荐配对组合】')
    expect(prompt).toContain('decision: use local model × trace: error in collect — 协同机制')
  })
})
