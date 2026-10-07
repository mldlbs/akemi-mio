import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MultiBrainModel } from '@akemi-mio/intelligence-observer/MultiBrainModel'
import type { ObserverLlmService } from '@akemi-mio/intelligence-observer/ObserverLlmService'

function makeResearch() {
  return {
    facts: ['事实一'],
    timeline: [],
    causalLinks: [],
    conflicts: Array.from({ length: 8 }, (_, i) => ({ partyA: `甲${i}`, partyB: `乙${i}`, nature: `冲突${i}`, evidence: 'e' })),
  } as any
}

function makeLlm(impl?: (prompt: string, opts?: any) => any) {
  return {
    generate: vi.fn().mockImplementation(async (prompt: string, opts?: any) => (impl ? impl(prompt, opts) : { data: '内容'.repeat(150) })),
  } as unknown as ObserverLlmService & { generate: ReturnType<typeof vi.fn> }
}

describe('MultiBrainModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('perception 提示只列素材事实，不再问「观察到什么模式」（M6）', async () => {
    const llm = makeLlm()
    const model = new MultiBrainModel(llm)
    await model.process(makeResearch(), 'neutral')

    const call = llm.generate.mock.calls.find((c: any[]) => String(c[1]?.system).includes('感知脑'))
    expect(call).toBeTruthy()
    expect(call![0]).toContain('不得新增任何外部信息')
    expect(call![0]).not.toContain('你观察到了什么模式')
  })

  it('analyst 提示要求「因为→所以」因果链（M6）', async () => {
    const llm = makeLlm()
    const model = new MultiBrainModel(llm)
    await model.process(makeResearch(), 'neutral')

    const call = llm.generate.mock.calls.find((c: any[]) => String(c[1]?.system).includes('分析脑'))
    expect(call).toBeTruthy()
    expect(call![0]).toContain('因为→所以')
  })

  it('冲突在研究摘要里最多 5 条（M6）', async () => {
    const model = new MultiBrainModel(makeLlm())
    const summary = (model as any).buildResearchSummary(makeResearch())
    expect(summary.match(/ vs /g)).toHaveLength(5)
  })

  it('全脑失败时回退内容打标且 confidence 取低值（M6）', async () => {
    const llm = makeLlm(() => ({ error: 'timeout' }))
    const model = new MultiBrainModel(llm)
    const outputs = await model.process(makeResearch(), 'neutral')

    expect(outputs).toHaveLength(4)
    for (const o of outputs) {
      expect(o.content).toContain('回退的研究摘要')
      expect(o.confidence).toBeLessThanOrEqual(0.3)
    }
  })

  it('confidence 按输出长度推导而非硬编码 0.7（M6）', async () => {
    const llm = makeLlm(() => ({ data: '短' }))
    const model = new MultiBrainModel(llm)
    const outputs = await model.process(makeResearch(), 'neutral')

    for (const o of outputs) {
      expect(o.confidence).toBeLessThan(0.7)
    }
  })

  it('正常长输出的 confidence 高于失败回退（M6 推导分层）', async () => {
    const llmOk = makeLlm()
    const ok = await new MultiBrainModel(llmOk).process(makeResearch(), 'neutral')
    const llmFail = makeLlm(() => ({ error: 'x' }))
    const failed = await new MultiBrainModel(llmFail).process(makeResearch(), 'neutral')

    expect(ok[0].confidence).toBeGreaterThan(failed[0].confidence)
  })
})
