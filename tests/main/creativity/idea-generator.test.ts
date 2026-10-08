import { describe, expect, it } from 'vitest'
import { IdeaGenerator } from '@akemi-mio/creativity/IdeaGenerator'

const idea = {
  title: '把 grounding 记忆接入生成回路',
  idea: '前提：记忆库已有相似决策；机制：作为约束注入配对；结果：避免重复踩坑，链条完整超过二十字符',
  expectedBenefit: '复用历史决策',
  risk: '记忆过时',
  novelty: 72,
  feasibility: 61,
  impact: 66,
  relevance: 'goal 与历史决策通过约束注入机制协同',
  sourceLabels: ['goal', 'decision: use local model'],
}

function stubChat() {
  const calls: Array<{ system?: string }> = []
  const chatJson = async (_u: string, opts?: { system?: string }) => {
    calls.push({ system: opts?.system })
    return { data: [idea] }
  }
  return { chatJson, calls }
}

const goalSources = () => [
  { name: 'goal', content: 'reduce MCP latency', type: 'knowledge' as const, weight: 0.95, origin: 'goal' },
  { name: 'decision: use local model', content: '本地模型推理', type: 'feedback' as const, weight: 0.75, origin: 'memory:m1', timestamp: '2026-10-07T00:00:00.000Z' },
]

describe('IdeaGenerator goal-driven flow', () => {
  it('returns gated ideas with experiment + technique, from a stub LLM', async () => {
    const { chatJson, calls } = stubChat()
    const gen = new IdeaGenerator(chatJson, 0.5, undefined, 0)
    const ideas = await gen.generateIdeas(goalSources(), 3, 'explore', [])
    expect(ideas.length).toBe(1)
    expect(ideas[0].hypothesis.status).toBe('draft')
    expect(ideas[0].hypothesis.technique).toBe('SCAMPER')
    expect(ideas[0].experiment).toBeTruthy()
    expect(ideas[0].experiment!.steps.length).toBeGreaterThan(0)
    expect(calls[0].system).toContain('【本轮创新技法：SCAMPER】')
  })

  it('rotationSeed propagates from the IdeaGenerator constructor', async () => {
    const { chatJson, calls } = stubChat()
    const gen = new IdeaGenerator(chatJson, 0.5, undefined, 3)
    await gen.generateIdeas(goalSources(), 3, 'explore', [])
    expect(calls[0].system).toContain('【本轮创新技法：Random-Stimulus】')
  })

  it('needs at least two sources', async () => {
    const { chatJson } = stubChat()
    const gen = new IdeaGenerator(chatJson, 0.5, undefined, 0)
    const ideas = await gen.generateIdeas([goalSources()[0]], 3, 'explore', [])
    expect(ideas).toEqual([])
  })

  it('drops ideas below the novelty/feasibility gates', async () => {
    const { chatJson } = stubChat()
    const gen = new IdeaGenerator(chatJson, 0.5, undefined, 0)
    const ideas = await gen.generateIdeas(goalSources(), 3, 'explore', [])
    // stub novelty 72 / feasibility 61 clear both gates
    expect(ideas.length).toBeGreaterThan(0)
    const weak = await new IdeaGenerator(async () => ({ data: [{ ...idea, feasibility: 10 }] }), 0.5, undefined, 0)
      .generateIdeas(goalSources(), 3, 'explore', [])
    expect(weak).toEqual([])
  })
})
