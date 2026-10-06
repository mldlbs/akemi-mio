import { describe, it, expect, vi, beforeEach } from 'vitest'
import { InsightComposer } from '@akemi-mio/intelligence-observer/InsightComposer'
import type { ObserverLlmService } from '@akemi-mio/intelligence-observer/ObserverLlmService'
import type { ObserverStore } from '@akemi-mio/intelligence-observer/ObserverStore'

function makeLlm() {
  return {
    generate: vi.fn().mockResolvedValue({ data: '段落内容'.repeat(200) }), // 800 字，远超 200 字要求
    generateJson: vi.fn().mockResolvedValue({ data: { score: 85, issues: [] } }),
  } as unknown as ObserverLlmService & { generate: ReturnType<typeof vi.fn>; generateJson: ReturnType<typeof vi.fn> }
}

function makeStore() {
  return {
    saveEssay: vi.fn(() => 'path/to/essay.md'),
    saveInsight: vi.fn(),
  } as unknown as ObserverStore & { saveEssay: ReturnType<typeof vi.fn>; saveInsight: ReturnType<typeof vi.fn> }
}

describe('InsightComposer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function compose(llm: any, store: any) {
    const composer = new InsightComposer(llm, store)
    const topic = { topic: 'AI 眼镜', probability: 0.7 }
    const research = { facts: ['事实一'], timeline: [], causalLinks: [], conflicts: [] } as any
    const brains = [
      { brain: 'analyst', content: '分析内容分析内容' },
      { brain: 'curiosity', content: '好奇内容好奇内容' },
      { brain: 'writer', content: '写作者内容写作者' },
    ] as any
    return composer.compose(topic, research, brains, 'neutral')
  }

  it('SECTION_SYSTEM 要求每段先给一句核心判断', async () => {
    const llm = makeLlm()
    const store = makeStore()
    await compose(llm, store)

    expect(llm.generate).toHaveBeenCalled()
    const system = llm.generate.mock.calls[0][1]?.system as string
    expect(system).toContain('每段先用一句话给出核心判断')
  })

  it('模型超长输出按 600 字硬截断，不原样灌进成文', async () => {
    const llm = makeLlm()
    const store = makeStore()
    const insight = await compose(llm, store)

    const llmSections = insight.sections.filter((s) => s.title !== insight.sections[0]?.title || s.content.length > 20)
    for (const s of insight.sections) {
      expect(s.content.length).toBeLessThanOrEqual(600)
    }
    expect(llmSections.length).toBeGreaterThan(0)
  })

  it('成文过质量门后 published，评分明细入 metadata', async () => {
    const llm = makeLlm()
    const store = makeStore()
    const insight = await compose(llm, store)

    expect(insight.metadata.essayStatus).toBe('published')
    expect(insight.metadata.qualityScore).toBe(85)
    expect(store.saveInsight).toHaveBeenCalledWith(insight)
  })
})
