import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { InsightGenerator } from '@akemi-mio/intelligence/insight/InsightGenerator'
import { InsightScorer } from '@akemi-mio/intelligence/insight/InsightScorer'
import type { DetectionContext, RawDetection, Insight } from '@akemi-mio/intelligence/insight/types'

vi.mock('@akemi-mio/core/core/EventBus', () => ({
  eventBus: { emit: vi.fn() },
  EventBus: class MockEventBus {
    on = vi.fn()
    emit = vi.fn()
  },
}))

describe('InsightScorer', () => {
  let scorer: InsightScorer
  let ctx: DetectionContext

  beforeEach(() => {
    scorer = new InsightScorer()
    ctx = {
      memoryEntries: [{ type: 'chat', content: 'hello', createdAt: Date.now() }],
      summaries: ['user likes coding'],
      interactionCount: 50,
      plans: [],
      eventCount: 100,
    }
  })

  describe('score', () => {
    it('根据 novelty/impact/actionability 计算加权得分', () => {
      const detections: RawDetection[] = [
        {
          detector: 'test',
          type: 'hot_topic',
          severity: 'medium',
          title: '测试洞察',
          description: 'desc',
          evidence: ['证据1', '证据2'],
          novelty: 80,
          impact: 70,
          actionability: 50,
        },
      ]
      const results = scorer.score(detections, ctx)
      expect(results).toHaveLength(1)
      // score = 80*0.4 + 70*0.4 + 50*0.2 = 32 + 28 + 10 = 70
      expect(results[0].score).toBe(70)
    })

    it('多个 detection 按得分降序排列', () => {
      const detections: RawDetection[] = [
        {
          detector: 'a',
          type: 'hot_topic',
          severity: 'low',
          title: '低分',
          description: '',
          evidence: [],
          novelty: 10,
          impact: 10,
          actionability: 10,
        },
        {
          detector: 'b',
          type: 'conflict',
          severity: 'high',
          title: '高分',
          description: '',
          evidence: ['e1', 'e2', 'e3'],
          novelty: 90,
          impact: 90,
          actionability: 80,
        },
      ]
      const results = scorer.score(detections, ctx)
      expect(results[0].title).toBe('高分')
      expect(results[1].title).toBe('低分')
    })
  })

  describe('filterLowValue', () => {
    it('过滤掉 score < 20 的洞察', () => {
      const insights: Insight[] = [
        { id: '1', detector: 'a', title: '保留', description: '', evidence: [], score: 85, confidence: 0.9, createdAt: Date.now() },
        { id: '2', detector: 'b', title: '过滤', description: '', evidence: [], score: 15, confidence: 0.3, createdAt: Date.now() },
        { id: '3', detector: 'c', title: '边缘', description: '', evidence: [], score: 20, confidence: 0.5, createdAt: Date.now() },
      ]
      const filtered = scorer.filterLowValue(insights)
      expect(filtered).toHaveLength(2)
      expect(filtered.map((i) => i.title)).toEqual(['保留', '边缘'])
    })
  })

  describe('calculateConfidence', () => {
    it('证据数量和质量影响置信度', () => {
      const highEvidence: RawDetection = {
        detector: 'a',
        type: 'hot_topic',
        severity: 'medium',
        title: 't',
        description: 'd',
        evidence: ['这是一条超过50个字符的详细证据文本内容用于测试置信度计算'],
        novelty: 50,
        impact: 50,
        actionability: 50,
      }
      const lowEvidence: RawDetection = {
        detector: 'a',
        type: 'hot_topic',
        severity: 'medium',
        title: 't',
        description: 'd',
        evidence: ['短'],
        novelty: 50,
        impact: 50,
        actionability: 50,
      }

      const ctxFresh = { ...ctx, interactionCount: 100 }
      const [high] = scorer.score([highEvidence], ctxFresh)
      const [low] = scorer.score([lowEvidence], ctxFresh)

      expect(high.confidence).toBeGreaterThan(low.confidence)
    })

    it('零值 novelty/impact/actionability 得分为 0', () => {
      const detections: RawDetection[] = [
        {
          detector: 'a',
          type: 'conflict',
          severity: 'low',
          title: '零分',
          description: '',
          evidence: ['e'],
          novelty: 0,
          impact: 0,
          actionability: 0,
        },
      ]
      const [result] = scorer.score(detections, ctx)
      expect(result.score).toBe(0)
    })

    it('满分 novelty/impact 得分最高', () => {
      const detections: RawDetection[] = [
        {
          detector: 'a',
          type: 'hot_topic',
          severity: 'high',
          title: '满分',
          description: '',
          evidence: ['e1', 'e2'],
          novelty: 100,
          impact: 100,
          actionability: 100,
        },
      ]
      const [result] = scorer.score(detections, ctx)
      expect(result.score).toBe(100)
    })
  })
})

describe('InsightGenerator', () => {
  let chatJson: ReturnType<typeof vi.fn>
  let generator: InsightGenerator
  let ctx: DetectionContext

  beforeEach(() => {
    chatJson = vi.fn()
    generator = new InsightGenerator({ chatJson: chatJson as any })
    ctx = {
      memoryEntries: [{ type: 'chat', content: '我喜欢编程', createdAt: Date.now() }],
      summaries: ['用户经常询问 AI 相关问题'],
      interactionCount: 30,
      plans: [{ title: '测试', status: 'active', updatedAt: Date.now(), steps: [{ status: 'done' }], createdAt: Date.now() }],
      eventCount: 60,
    }
  })

  it('无内存和摘要时返回空数组', async () => {
    const emptyCtx: DetectionContext = { memoryEntries: [], summaries: [], interactionCount: 0, plans: [], eventCount: 0 }
    const results = await generator.generate(emptyCtx)
    expect(results).toEqual([])
  })

  it('LLM 成功返回时，生成带分数的洞察', async () => {
    chatJson.mockResolvedValue({
      data: [
        {
          title: '用户对 AI 编程感兴趣',
          description: '从对话中发现用户频繁询问 AI 编程相关话题',
          detector: 'conflict',
          evidence: ['用户问了 5 次 AI 问题'],
          novelty: 70,
          impact: 80,
          actionability: 60,
          severity: 'medium',
        },
      ],
    })

    const results = await generator.generate(ctx)
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('用户对 AI 编程感兴趣')
    expect(results[0].score).toBeGreaterThan(0)
    expect(results[0].confidence).toBeGreaterThan(0)
  })

  it('LLM 报错时返回空数组', async () => {
    chatJson.mockResolvedValue({ error: 'API 错误' })
    const results = await generator.generate(ctx)
    expect(results).toEqual([])
  })

  it('LLM 返回空数组时返回空数组', async () => {
    chatJson.mockResolvedValue({ data: [] })
    const results = await generator.generate(ctx)
    expect(results).toEqual([])
  })

  it('LLM 抛异常时优雅降级', async () => {
    chatJson.mockRejectedValue(new Error('网络错误'))
    const results = await generator.generate(ctx)
    expect(results).toEqual([])
  })

  it('LLM 返回非数组数据时返回空数组', async () => {
    chatJson.mockResolvedValue({ data: { title: 'not an array' } })
    const results = await generator.generate(ctx)
    expect(results).toEqual([])
  })

  it('LLM 返回多条结果时全部参与评分和过滤', async () => {
    chatJson.mockResolvedValue({
      data: [
        {
          title: '高分洞察',
          description: 'a',
          detector: 'conflict',
          severity: 'high',
          evidence: ['e1', 'e2', 'e3'],
          novelty: 90,
          impact: 85,
          actionability: 80,
        },
        {
          title: '低分洞察',
          description: 'b',
          detector: 'hot_topic',
          severity: 'low',
          evidence: [],
          novelty: 10,
          impact: 10,
          actionability: 10,
        },
        {
          title: '边缘洞察',
          description: 'c',
          detector: 'conflict',
          severity: 'medium',
          evidence: ['e1'],
          novelty: 50,
          impact: 40,
          actionability: 30,
        },
      ],
    })
    const results = await generator.generate(ctx)
    // 低分洞察 score = 10*0.4+10*0.4+10*0.2 = 10 < 20 被过滤
    expect(results).toHaveLength(2)
    expect(results[0].title).toBe('高分洞察')
    expect(results[0].score).toBeGreaterThan(80)
  })

  it('generate 应触发 analysis.started 事件', async () => {
    const { eventBus } = await import('@akemi-mio/core/core/EventBus')
    chatJson.mockResolvedValue({ data: [] })
    await generator.generate(ctx)
    expect(eventBus.emit).toHaveBeenCalledWith('insight.analysis.started', {})
  })

  it('LLM 有返回时触发 candidate.generated 事件', async () => {
    const { eventBus } = await import('@akemi-mio/core/core/EventBus')
    chatJson.mockResolvedValue({
      data: [
        {
          title: 't',
          description: 'd',
          detector: 'conflict',
          severity: 'medium',
          evidence: ['e1'],
          novelty: 50,
          impact: 50,
          actionability: 50,
        },
      ],
    })
    await generator.generate(ctx)
    expect(eventBus.emit).toHaveBeenCalledWith('insight.candidate.generated', { count: 1 })
  })
})
