import { describe, it, expect } from 'vitest'
import { TemplateLibrary } from '@akemi-mio/creativity/TemplateLibrary'
import type { ConceptCombo, CreativitySource } from '@akemi-mio/creativity/types'

function makeSource(name: string, type: CreativitySource['type'] = 'knowledge'): CreativitySource {
  return { name, content: 'test content', type, weight: 0.8 }
}

function makeCombo(overrides: Partial<ConceptCombo> & { sources: [string, string] }): ConceptCombo {
  return {
    id: 'combo_test',
    description: `${overrides.sources[0]} × ${overrides.sources[1]}`,
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('TemplateLibrary', () => {
  describe('generate', () => {
    it('返回非 null 的 Hypothesis', () => {
      const lib = new TemplateLibrary(42)
      const combo = makeCombo({ sources: ['Memory', 'Agent'] })
      const sources = [makeSource('Memory'), makeSource('Agent', 'behavior')]
      const h = lib.generate(combo, sources)
      expect(h).not.toBeNull()
      expect(h!.id).toMatch(/^hyp_tpl_/)
      expect(h!.status).toBe('draft')
    })

    it('来源名称被填充到标题和 idea 中', () => {
      const lib = new TemplateLibrary(42)
      const combo = makeCombo({ sources: ['TTS引擎', '记忆模块'] })
      const sources = [makeSource('TTS引擎'), makeSource('记忆模块', 'knowledge')]
      const h = lib.generate(combo, sources)
      expect(h!.title).toContain('TTS引擎')
      expect(h!.title).toContain('记忆模块')
      expect(h!.idea).toContain('TTS引擎')
      expect(h!.idea).toContain('记忆模块')
    })

    it('缺失 sources 时返回 null', () => {
      const lib = new TemplateLibrary(42)
      const combo = makeCombo({ sources: ['A', 'B'] })
      const h = lib.generate(combo, [makeSource('A')])
      expect(h).toBeNull()
    })

    it('不同类型组合产生不同标题格式', () => {
      const lib = new TemplateLibrary(42)
      const pairs: [string, string, CreativitySource['type'], CreativitySource['type']][] = [
        ['知识库', '推理引擎', 'knowledge', 'knowledge'],
        ['行为分析', '用户画像', 'behavior', 'insight'],
        ['错误日志', '告警系统', 'failure', 'behavior'],
        ['洞察A', '洞察B', 'insight', 'insight'],
        ['记忆模块', '调度器', 'knowledge', 'behavior'],
      ]
      const titles = new Set<string>()
      for (const [a, b, ta, tb] of pairs) {
        const combo = makeCombo({ sources: [a, b] })
        const sources = [makeSource(a, ta), makeSource(b, tb)]
        const h = lib.generate(combo, sources)
        titles.add(h!.title)
      }
      expect(titles.size).toBeGreaterThanOrEqual(3)
    })

    it('评分始终在 50-100 之间', () => {
      const lib = new TemplateLibrary(42)
      for (let i = 0; i < 20; i++) {
        const combo = makeCombo({ sources: [`S${i}`, `S${i + 1}`] })
        const sources = [makeSource(`S${i}`), makeSource(`S${i + 1}`)]
        const h = lib.generate(combo, sources)!
        expect(h.novelty).toBeGreaterThanOrEqual(50)
        expect(h.novelty).toBeLessThanOrEqual(100)
        expect(h.feasibility).toBeGreaterThanOrEqual(50)
        expect(h.feasibility).toBeLessThanOrEqual(100)
        expect(h.impact).toBeGreaterThanOrEqual(50)
        expect(h.impact).toBeLessThanOrEqual(100)
      }
    })

    it('相同 seed + 相同输入 = 确定性输出', () => {
      const lib1 = new TemplateLibrary(123)
      const lib2 = new TemplateLibrary(123)
      const combo = makeCombo({ sources: ['A', 'B'] })
      const sources = [makeSource('A'), makeSource('B', 'behavior')]
      const a = lib1.generate(combo, sources)!
      const b = lib2.generate(combo, sources)!
      expect(a.title).toBe(b.title)
      expect(a.idea).toBe(b.idea)
      expect(a.novelty).toBe(b.novelty)
      expect(a.feasibility).toBe(b.feasibility)
      expect(a.impact).toBe(b.impact)
    })
  })

  describe('类型感知选择', () => {
    it('failure × failure 模板 novelty 应 >= 50', () => {
      const lib = new TemplateLibrary(42)
      const combo = makeCombo({ sources: ['API超时', '解析错误'] })
      const sources = [makeSource('API超时', 'failure'), makeSource('解析错误', 'failure')]
      const h = lib.generate(combo, sources)!
      expect(h.novelty).toBeGreaterThanOrEqual(50)
    })

    it('insight × knowledge 应产生有意义的内容', () => {
      const lib = new TemplateLibrary(42)
      const combo = makeCombo({ sources: ['设计哲学', '数据库'] })
      const sources = [makeSource('设计哲学', 'insight'), makeSource('数据库', 'knowledge')]
      const h = lib.generate(combo, sources)!
      expect(h.title).toBeTruthy()
      expect(h.expectedBenefit.length).toBeGreaterThan(0)
    })

    it('behavior × insight 应正常产出', () => {
      const lib = new TemplateLibrary(42)
      const combo = makeCombo({ sources: ['用户行为', '性能洞察'] })
      const sources = [makeSource('用户行为', 'behavior'), makeSource('性能洞察', 'insight')]
      const h = lib.generate(combo, sources)!
      expect(h).not.toBeNull()
      expect(h!.risk.length).toBeGreaterThan(0)
    })
  })

  describe('nameFit 二次路由', () => {
    it('有 nameFit 加成的配对路由到不同的模板', () => {
      const lib = new TemplateLibrary(42)
      // ASR × MCP：有 nameFit 加成 (+8)，应偏向 merged 模板
      const combo1 = makeCombo({ sources: ['ASR', 'MCP'] })
      const sources1 = [makeSource('ASR', 'knowledge'), makeSource('MCP', 'knowledge')]
      const h1 = lib.generate(combo1, sources1)!

      // Memory × TTS：无 nameFit 加成，应落到其他模板
      const combo2 = makeCombo({ sources: ['Memory', 'TTS'] })
      const sources2 = [makeSource('Memory', 'knowledge'), makeSource('TTS', 'knowledge')]
      const h2 = lib.generate(combo2, sources2)!

      // 有 nameFit 时标题格式应不同于无加成的配对
      expect(h1.title).not.toBe(h2.title)
    })

    it('无 nameFit 加成的配对不影响基础路由', () => {
      const lib = new TemplateLibrary(42)
      // Agent × Evolution：有 pattern_migration 的 nameFit (+8)
      const combo1 = makeCombo({ sources: ['Agent', 'Evolution'] })
      const sources1 = [makeSource('Agent', 'knowledge'), makeSource('Evolution', 'knowledge')]
      const h1 = lib.generate(combo1, sources1)!

      // 仍应产出有效假设
      expect(h1.title).toBeTruthy()
      expect(h1.idea).toBeTruthy()
      expect(h1.novelty).toBeGreaterThanOrEqual(50)
    })
  })

  describe('边缘情况', () => {
    it('同名不同类型仍可生成', () => {
      const lib = new TemplateLibrary(42)
      const combo = makeCombo({ sources: ['数据', '数据'] })
      const sources = [makeSource('数据', 'knowledge'), makeSource('数据', 'behavior')]
      const h = lib.generate(combo, sources)
      expect(h).not.toBeNull()
    })
  })
})
