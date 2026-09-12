import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { WorldTrendProvider } from '@akemi-mio/creativity/WorldTrendProvider'

function tmpDir(): string {
  const d = join(tmpdir(), `wtr-test-${Date.now()}`)
  mkdirSync(d, { recursive: true })
  return d
}

describe('WorldTrendProvider', () => {
  let dir: string
  let provider: WorldTrendProvider

  beforeEach(() => {
    dir = tmpDir()
    // Use a fixed seed for deterministic behavior
    provider = new WorldTrendProvider(dir, 42)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('getTrends', () => {
    it('trends 目录不存在时返回空数组', () => {
      expect(provider.getTrends()).toEqual([])
    })

    it('observations 目录不存在时返回空数组（有 signals 但无法解析为片段）', () => {
      const trendsDir = join(dir, 'trends')
      mkdirSync(trendsDir, { recursive: true })
      writeFileSync(
        join(trendsDir, '2024-01-01.json'),
        JSON.stringify({
          signals: [
            {
              keyword: '趋势A',
              score: 0.9,
              occurrenceCount: 10,
              recentObservationIds: ['obs-1'],
              source: 'weibo',
            },
          ],
        }),
        'utf-8',
      )
      expect(provider.getTrends()).toEqual([])
    })

    it('从 trends 和 observations 生成 [source] content 格式的观察片段', () => {
      const trendsDir = join(dir, 'trends')
      mkdirSync(trendsDir, { recursive: true })
      writeFileSync(
        join(trendsDir, '2024-01-01.json'),
        JSON.stringify({
          signals: [
            {
              keyword: '高考',
              score: 0.95,
              occurrenceCount: 100,
              recentObservationIds: ['obs-1', 'obs-2'],
              source: 'weibo',
            },
            {
              keyword: 'AI',
              score: 0.8,
              occurrenceCount: 80,
              recentObservationIds: ['obs-3'],
              source: 'zhihu',
            },
          ],
        }),
        'utf-8',
      )

      const obsDir = join(dir, 'observations')
      mkdirSync(obsDir, { recursive: true })
      writeFileSync(
        join(obsDir, '2024-01-01.json'),
        JSON.stringify({
          observations: [
            { id: 'obs-1', content: '考生查分时全家屏住呼吸', source: 'weibo' },
            { id: 'obs-2', content: '高考改革新方案公布', source: 'weibo' },
            { id: 'obs-3', content: 'GPT-5 即将发布', source: 'zhihu' },
          ],
        }),
        'utf-8',
      )

      const trends = provider.getTrends()
      // Returns 3-5 snippets (deterministic with seed 42: 3 items → count = 3)
      expect(trends.length).toBeGreaterThanOrEqual(3)
      expect(trends.length).toBeLessThanOrEqual(5)
      for (const t of trends) {
        expect(t).toMatch(/^\[.+\] .+/)
      }
    })

    it('resetConsumed 清空已消费记录后返回相同结果', () => {
      const trendsDir = join(dir, 'trends')
      mkdirSync(trendsDir, { recursive: true })
      const signals = Array.from({ length: 30 }, (_, i) => ({
        keyword: `趋势${i}`,
        score: 1 - i * 0.03,
        occurrenceCount: 100 - i,
        recentObservationIds: [`obs-${i}`],
        source: 'test',
      }))
      writeFileSync(join(trendsDir, '2024-01-01.json'), JSON.stringify({ signals }), 'utf-8')

      const obsDir = join(dir, 'observations')
      mkdirSync(obsDir, { recursive: true })
      const observations = Array.from({ length: 30 }, (_, i) => ({
        id: `obs-${i}`,
        content: `观察内容${i}`,
        source: 'test',
      }))
      writeFileSync(join(obsDir, '2024-01-01.json'), JSON.stringify({ observations }), 'utf-8')

      const first = provider.getTrends()
      expect(first.length).toBeGreaterThan(0)

      // With same seed and reset, second call should produce identical results
      provider.resetConsumed()
      const second = provider.getTrends()
      expect(second).toEqual(first)
    })

    it('trends JSON 解析失败时抛出异常', () => {
      const trendsDir = join(dir, 'trends')
      mkdirSync(trendsDir, { recursive: true })
      writeFileSync(join(trendsDir, '2024-01-01.json'), 'invalid json', 'utf-8')
      expect(() => provider.getTrends()).toThrow()
    })

    it('observations JSON 解析失败时抛出异常', () => {
      const trendsDir = join(dir, 'trends')
      mkdirSync(trendsDir, { recursive: true })
      writeFileSync(
        join(trendsDir, '2024-01-01.json'),
        JSON.stringify({
          signals: [
            {
              keyword: '高考',
              score: 0.9,
              occurrenceCount: 10,
              recentObservationIds: ['obs-1'],
              source: 'weibo',
            },
          ],
        }),
        'utf-8',
      )

      const obsDir = join(dir, 'observations')
      mkdirSync(obsDir, { recursive: true })
      writeFileSync(join(obsDir, '2024-01-01.json'), 'invalid json', 'utf-8')

      expect(() => provider.getTrends()).toThrow()
    })
  })

  describe('getTrendSignals', () => {
    it('空目录返回空数组', () => {
      expect(provider.getTrendSignals()).toEqual([])
    })

    it('返回结构化的趋势信号，去重并过滤低分（score < 0.3）', () => {
      const trendsDir = join(dir, 'trends')
      mkdirSync(trendsDir, { recursive: true })
      writeFileSync(
        join(trendsDir, '2024-01-01.json'),
        JSON.stringify({
          signals: [
            {
              keyword: '高考',
              score: 0.95,
              occurrenceCount: 100,
              recentObservationIds: ['obs-1', 'obs-2'],
              source: 'weibo',
            },
            {
              keyword: '高考', // duplicate keyword — should be deduped
              score: 0.5,
              occurrenceCount: 50,
              recentObservationIds: ['obs-3'],
              source: 'zhihu',
            },
            {
              keyword: '低分信号',
              score: 0.1, // below 0.3 threshold — should be filtered
              occurrenceCount: 5,
              recentObservationIds: ['obs-4'],
              source: 'test',
            },
          ],
        }),
        'utf-8',
      )

      const obsDir = join(dir, 'observations')
      mkdirSync(obsDir, { recursive: true })
      writeFileSync(
        join(obsDir, '2024-01-01.json'),
        JSON.stringify({
          observations: [
            { id: 'obs-1', content: '考生查分', source: 'weibo' },
            { id: 'obs-2', content: '高考改革', source: 'weibo' },
          ],
        }),
        'utf-8',
      )

      const signals = provider.getTrendSignals(3, 20)
      expect(signals.length).toBe(1)
      expect(signals[0].keyword).toBe('高考')
      expect(signals[0].score).toBe(0.95)
      expect(signals[0].snippets.length).toBeGreaterThan(0)
      // Snippets should be in [source] content format
      for (const s of signals[0].snippets) {
        expect(s).toMatch(/^\[.+\] .+/)
      }
    })
  })

  describe('getInsights', () => {
    it('insights 目录不存在时返回空数组', () => {
      expect(provider.getInsights()).toEqual([])
    })

    it('读取最近 5 条 insight 并格式化为 "昨日研究: topic"', () => {
      const insightsDir = join(dir, 'insights')
      mkdirSync(insightsDir, { recursive: true })
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(insightsDir, `2024-01-${String(i + 1).padStart(2, '0')}.json`), JSON.stringify({ topic: `洞察${i}` }), 'utf-8')
      }
      const insights = provider.getInsights()
      expect(insights).toHaveLength(5)
      // Reverse order: newest file first
      expect(insights[0]).toBe('昨日研究: 洞察4')
      expect(insights[1]).toBe('昨日研究: 洞察3')
      expect(insights[2]).toBe('昨日研究: 洞察2')
      expect(insights[3]).toBe('昨日研究: 洞察1')
      expect(insights[4]).toBe('昨日研究: 洞察0')
    })

    it('topic 为空或长度 ≤2 时被跳过', () => {
      const insightsDir = join(dir, 'insights')
      mkdirSync(insightsDir, { recursive: true })
      writeFileSync(
        join(insightsDir, '2024-01-01.json'),
        JSON.stringify({ topic: 'AB' }), // length = 2, should be skipped
        'utf-8',
      )
      writeFileSync(join(insightsDir, '2024-01-02.json'), JSON.stringify({ topic: '有效的话题' }), 'utf-8')
      writeFileSync(
        join(insightsDir, '2024-01-03.json'),
        JSON.stringify({}), // no topic
        'utf-8',
      )
      const insights = provider.getInsights()
      expect(insights).toHaveLength(1)
      expect(insights[0]).toBe('昨日研究: 有效的话题')
    })

    it('JSON 解析失败时返回空数组（容错）', () => {
      const insightsDir = join(dir, 'insights')
      mkdirSync(insightsDir, { recursive: true })
      writeFileSync(join(insightsDir, 'invalid.json'), 'not json', 'utf-8')
      expect(provider.getInsights()).toEqual([])
    })
  })
})
