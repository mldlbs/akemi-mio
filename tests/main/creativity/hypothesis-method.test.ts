import { describe, expect, it } from 'vitest'
import { HypothesisGenerator } from '@akemi-mio/creativity/HypothesisGenerator'

const idea = {
  title: '想法标题长度正常',
  idea: '完整因果链条描述：前提 -> 机制 -> 结果，长度超过二十个字符以通过门禁',
  expectedBenefit: '收益',
  risk: '风险',
  novelty: 70,
  feasibility: 60,
  impact: 65,
  relevance: '两个来源通过缓存失效机制协同',
  sourceLabels: ['goal', 'auto'],
}

function capturingChat() {
  const calls: Array<{ system?: string; user: string }> = []
  const chatJson = async (userText: string, opts?: { system?: string }) => {
    calls.push({ system: opts?.system, user: userText })
    return { data: [idea] }
  }
  return { chatJson, calls }
}

const sources = () => [
  { name: 'goal', content: 'g', type: 'knowledge' as const, weight: 0.95, origin: 'goal' },
  { name: 'auto', content: 'a', type: 'feedback' as const, weight: 0.75, origin: 'memory:m1' },
]
const combos = () => [{ id: 'c1', sources: ['goal', 'auto'] as [string, string], description: 'd', createdAt: 1 }]

describe('HypothesisGenerator method threading', () => {
  it('defaults to the rotation technique and tags the hypothesis', async () => {
    const { chatJson, calls } = capturingChat()
    const gen = new HypothesisGenerator(chatJson, 42, 0)
    const out = await gen.generate(combos(), sources())
    expect(calls[0].system).toContain('【本轮创新技法：SCAMPER】')
    expect(out[0].technique).toBe('SCAMPER')
    expect(out[0].status).toBe('draft')
  })

  it('honours rotationSeed so a later seed rotates', async () => {
    const { chatJson, calls } = capturingChat()
    const gen = new HypothesisGenerator(chatJson, 42, 1)
    await gen.generate(combos(), sources())
    expect(calls[0].system).toContain('【本轮创新技法：Analogy】')
  })

  it('an explicit method wins over the rotation', async () => {
    const { chatJson, calls } = capturingChat()
    const gen = new HypothesisGenerator(chatJson, 42, 0)
    const out = await gen.generate(combos(), sources(), false, [], 'Constraint-Inversion')
    expect(calls[0].system).toContain('【本轮创新技法：Constraint-Inversion】')
    expect(out[0].technique).toBe('Constraint-Inversion')
  })

  it('repeated calls advance the rotation within one instance', async () => {
    const { chatJson, calls } = capturingChat()
    const gen = new HypothesisGenerator(chatJson, 42, 0)
    await gen.generate(combos(), sources())
    await gen.generate(combos(), sources())
    expect(calls[0].system).toContain('SCAMPER')
    expect(calls[1].system).toContain('Analogy')
  })
})
