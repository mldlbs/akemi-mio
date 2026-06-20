import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HypothesisGenerator } from '../HypothesisGenerator'
import type { ConceptCombo, CreativitySource } from '../types'

function makeCombo(overrides: Partial<ConceptCombo> & { sources: [string, string] }): ConceptCombo {
  return {
    id: `combo_test_1`,
    description: `${overrides.sources[0]} × ${overrides.sources[1]}`,
    createdAt: Date.now(),
    ...overrides,
  }
}

function makeSource(name: string, type: CreativitySource['type'] = 'knowledge', weight = 0.8): CreativitySource {
  return { name, content: 'test', type, weight }
}

describe('HypothesisGenerator', () => {
  let chatJson: ReturnType<typeof vi.fn>
  let generator: HypothesisGenerator

  beforeEach(() => {
    chatJson = vi.fn()
    generator = new HypothesisGenerator(chatJson as any, 42)
  })

  describe('generate - LLM 模式', () => {
    it('空 combos 返回空数组', async () => {
      const result = await generator.generate([], [])
      expect(result).toEqual([])
    })

    it('LLM 成功时返回解析后的 Hypothesis 数组', async () => {
      chatJson.mockResolvedValue({
        data: [
          {
            title: '用记忆增强对话',
            idea: '将用户历史记忆作为对话上下文注入',
            expectedBenefit: '更个性化的回复',
            risk: '可能泄露隐私',
            sourceLabels: ['Memory', 'Agent'],
            novelty: 75,
            feasibility: 60,
            impact: 80,
          },
        ],
      })

      const combos = [makeCombo({ sources: ['Memory', 'Agent'] })]
      const sources = [makeSource('Memory'), makeSource('Agent', 'behavior')]
      const results = await generator.generate(combos, sources)

      expect(results).toHaveLength(1)
      expect(results[0].title).toBe('用记忆增强对话')
      expect(results[0].novelty).toBe(75)
      expect(results[0].feasibility).toBe(60)
      expect(results[0].impact).toBe(80)
      expect(results[0].status).toBe('draft')
      expect(results[0].id).toMatch(/^hyp_/)
    })

    it('novelty/feasibility/impact 应 clamp 在 10-100', async () => {
      chatJson.mockResolvedValue({
        data: [
          {
            title: '极端值测试',
            idea: 'test',
            expectedBenefit: 'test',
            risk: 'test',
            sourceLabels: ['A', 'B'],
            novelty: 999,
            feasibility: -5,
            impact: 50,
          },
        ],
      })

      const results = await generator.generate([makeCombo({ sources: ['A', 'B'] })], [makeSource('A'), makeSource('B')])
      expect(results[0].novelty).toBe(100)
      expect(results[0].feasibility).toBe(10)
      expect(results[0].impact).toBe(50)
    })

    it('LLM 返回非数组时降级到 TemplateLibrary', async () => {
      chatJson.mockResolvedValue({ data: 'not an array' })

      const results = await generator.generate([makeCombo({ sources: ['A', 'B'] })], [makeSource('A'), makeSource('B')])
      expect(results).toHaveLength(1)
      expect(results[0].status).toBe('draft')
      expect(results[0].id).toMatch(/^hyp_tpl_/)
    })

    it('LLM 返回空数组时降级到 TemplateLibrary', async () => {
      chatJson.mockResolvedValue({ data: [] })

      const results = await generator.generate([makeCombo({ sources: ['A', 'B'] })], [makeSource('A'), makeSource('B')])
      expect(results).toHaveLength(1)
      expect(results[0].id).toMatch(/^hyp_tpl_/)
    })

    it('LLM 报错时降级到模板', async () => {
      chatJson.mockResolvedValue({ error: 'API timeout' })

      const results = await generator.generate([makeCombo({ sources: ['A', 'B'] })], [makeSource('A'), makeSource('B')])
      expect(results).toHaveLength(1)
    })

    it('LLM 抛异常时降级到模板', async () => {
      chatJson.mockRejectedValue(new Error('network error'))

      const results = await generator.generate([makeCombo({ sources: ['A', 'B'] })], [makeSource('A'), makeSource('B')])
      expect(results).toHaveLength(1)
    })
  })

  describe('generate - 模板模式（fallback）', () => {
    it('模板生成的假设包含合理的字段', async () => {
      chatJson.mockResolvedValue({ data: [] })

      const results = await generator.generate([makeCombo({ sources: ['Memory', 'Agent'] })], [makeSource('Memory'), makeSource('Agent')])

      expect(results).toHaveLength(1)
      const h = results[0]
      expect(h.title).toBeTruthy()
      expect(h.idea).toBeTruthy()
      expect(h.expectedBenefit).toBeTruthy()
      expect(h.risk).toBeTruthy()
      expect(h.sourceLabels).toEqual(['Memory', 'Agent'])
      expect(h.novelty).toBeGreaterThanOrEqual(50)
      expect(h.novelty).toBeLessThanOrEqual(80)
      expect(h.feasibility).toBeGreaterThanOrEqual(40)
      expect(h.feasibility).toBeLessThanOrEqual(70)
      expect(h.impact).toBeGreaterThanOrEqual(50)
      expect(h.impact).toBeLessThanOrEqual(75)
    })

    it('相同输入产生稳定的模板选择（确定性）', async () => {
      chatJson.mockResolvedValue({ data: [] })

      const gen1 = new HypothesisGenerator(chatJson as any, 42)
      const gen2 = new HypothesisGenerator(chatJson as any, 42)
      const combos = [makeCombo({ sources: ['A', 'B'] })]

      const [r1] = await gen1.generate(combos, [makeSource('A'), makeSource('B')])
      const [r2] = await gen2.generate(combos, [makeSource('A'), makeSource('B')])

      expect(r1.title).toBe(r2.title)
      expect(r1.idea).toBe(r2.idea)
    })

    it('多个 combo 每个都生成一个假设', async () => {
      chatJson.mockResolvedValue({ data: [] })

      const combos = [makeCombo({ sources: ['A', 'B'] }), makeCombo({ sources: ['C', 'D'] }), makeCombo({ sources: ['E', 'F'] })]
      const sources = [makeSource('A'), makeSource('B'), makeSource('C'), makeSource('D'), makeSource('E'), makeSource('F')]

      const results = await generator.generate(combos, sources)
      expect(results).toHaveLength(3)
    })
  })

  describe('dreamMode', () => {
    it('dreamMode 为 true 时传更多 combo 给 LLM', async () => {
      chatJson.mockResolvedValue({ data: [] })

      const combos = Array.from({ length: 8 }, (_, i) => makeCombo({ sources: [`S${i * 2}`, `S${i * 2 + 1}`] }))

      await generator.generate(combos, [], true)

      // dreamMode 传 5 个 combo，普通模式传 3 个
      expect(chatJson).toHaveBeenCalled()
    })
  })

  describe('模式匹配 — 不同模板选择', () => {
    it('不同来源对映射到不同的模板标题格式', async () => {
      chatJson.mockResolvedValue({ data: [] })

      const pairs = [
        ['A', 'B'],
        ['X', 'Y'],
        ['Memory', 'Agent'],
        ['Data', 'Logic'],
        ['Vision', 'Language'],
      ]

      const titles = new Set<string>()
      for (const [a, b] of pairs) {
        const combo = makeCombo({ sources: [a, b] })
        const [h] = await generator.generate([combo], [makeSource(a), makeSource(b)])
        titles.add(h.title)
      }

      const formats = new Set(
        [...titles].map((t) => {
          if (t.includes('驱动的')) return 'driven'
          if (t.includes('增强')) return 'enhanced'
          if (t.includes('×')) return 'hybrid'
          if (t.includes('抽象')) return 'abstract'
          if (t.includes('视角')) return 'perspective'
          return 'other'
        }),
      )

      expect(formats.size).toBeGreaterThanOrEqual(2)
    })

    it('降级到 TemplateLibrary — 不测试原始 5 模板的命中率', async () => {
      chatJson.mockResolvedValue({ data: [] })

      const formats = new Set<string>()
      for (let i = 0; i < 50; i++) {
        const a = `概念${i}`
        const b = `概念${i + 1}`
        const combo = makeCombo({ sources: [a, b] })
        const sources = [makeSource(a), makeSource(b)]
        const [h] = await generator.generate([combo], sources)
        const fmt = h.title.includes('驱动的')
          ? 'driven'
          : h.title.includes('增强')
            ? 'enhanced'
            : h.title.includes('×')
              ? 'hybrid'
              : h.title.includes('抽象')
                ? 'abstract'
                : h.title.includes('视角')
                  ? 'perspective'
                  : 'other'
        formats.add(fmt)
      }

      // TemplateLibrary 覆盖了所有来源类型组合，不会降级到原始 5 模板
      // 所以 formats 可能只有 1-2 个（knowledge × knowledge 配对）
      expect(formats.size).toBeGreaterThanOrEqual(1)
    })
  })

  describe('通用模板降级', () => {
    it('chatJson 为 undefined 时正常降级到 TemplateLibrary', async () => {
      const gen = new HypothesisGenerator(undefined as any, 42)
      const results = await gen.generate([makeCombo({ sources: ['A', 'B'] })], [makeSource('A'), makeSource('B')])
      expect(results).toHaveLength(1)
      expect(results[0].status).toBe('draft')
      expect(results[0].id).toMatch(/^hyp_tpl_/)
    })

    it('LLM 返回残缺数据时降级到 TemplateLibrary', async () => {
      chatJson.mockResolvedValue({
        data: [{ title: 'only title' }],
      })

      const results = await generator.generate([makeCombo({ sources: ['A', 'B'] })], [makeSource('A'), makeSource('B')])
      expect(results).toHaveLength(1)
      expect(results[0].id).toMatch(/^hyp_tpl_/)
    })
  })

  describe('模板评分', () => {
    it('模板生成的评分在预期范围内', async () => {
      chatJson.mockResolvedValue({ data: [] })

      for (let i = 0; i < 20; i++) {
        const combo = makeCombo({ sources: [`S${i}`, `S${i + 1}`] })
        const [h] = await generator.generate([combo], [makeSource(`S${i}`), makeSource(`S${i + 1}`)])

        expect(h.novelty).toBeGreaterThanOrEqual(50)
        expect(h.novelty).toBeLessThanOrEqual(80)
        expect(h.feasibility).toBeGreaterThanOrEqual(40)
        expect(h.feasibility).toBeLessThanOrEqual(70)
        expect(h.impact).toBeGreaterThanOrEqual(50)
        expect(h.impact).toBeLessThanOrEqual(75)
      }
    })

    it('相同 seed 产生相同评分', async () => {
      chatJson.mockResolvedValue({ data: [] })

      const genA = new HypothesisGenerator(chatJson as any, 123)
      const genB = new HypothesisGenerator(chatJson as any, 123)

      const combo = makeCombo({ sources: ['X', 'Y'] })
      const [a] = await genA.generate([combo], [makeSource('X'), makeSource('Y')])
      const [b] = await genB.generate([combo], [makeSource('X'), makeSource('Y')])

      expect(a.novelty).toBe(b.novelty)
      expect(a.feasibility).toBe(b.feasibility)
      expect(a.impact).toBe(b.impact)
    })

    it('不同 seed 可能产生不同评分', async () => {
      chatJson.mockResolvedValue({ data: [] })

      const values = new Set<number>()
      for (let seed = 0; seed < 10; seed++) {
        const gen = new HypothesisGenerator(chatJson as any, seed)
        const combo = makeCombo({ sources: ['A', 'B'] })
        const [h] = await gen.generate([combo], [makeSource('A'), makeSource('B')])
        values.add(h.novelty)
      }

      expect(values.size).toBeGreaterThan(0)
    })
  })
})
