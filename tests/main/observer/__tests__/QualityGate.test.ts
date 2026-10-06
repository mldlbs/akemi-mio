import { describe, it, expect, vi } from 'vitest'
import { QualityGate, MIN_ESSAY_CHARS, QUALITY_PASS_SCORE } from '@akemi-mio/intelligence-observer/QualityGate'
import type { ObserverLlmService } from '@akemi-mio/intelligence-observer/ObserverLlmService'

const LONG_TEXT = [
  '今天的观察从一条日志开始。',
  '我注意到缓存在高峰期反复失效，随后数据库连接数同步上升——',
  '两者的曲线几乎重合，这不是巧合：缓存穿透把压力直接推到了存储层。',
  '我试着把 TTL 从 60 秒调到 300 秒，穿透次数立刻下降了一个数量级。',
  '如果这个推断成立，下周的慢查询告警应该会同步减少；如果不成立，',
  '那说明连接数上涨另有原因，比如连接池本身在抖动。',
].join('')

function makeLlm(impl: { generateJson?: unknown }) {
  return impl as unknown as ObserverLlmService
}

describe('QualityGate', () => {
  it('空文直接离线判负，不消耗 LLM 调用', async () => {
    const generateJson = vi.fn()
    const gate = new QualityGate(makeLlm({ generateJson }))

    const review = await gate.review('   \n  ')
    expect(review.pass).toBe(false)
    expect(review.score).toBe(0)
    expect(review.reviewed).toBe(false)
    expect(review.issues).toContain('empty content')
    expect(generateJson).not.toHaveBeenCalled()
  })

  it(`过短内容（< ${MIN_ESSAY_CHARS} 字符）离线判负`, async () => {
    const generateJson = vi.fn()
    const gate = new QualityGate(makeLlm({ generateJson }))

    const review = await gate.review('太短了')
    expect(review.pass).toBe(false)
    expect(review.reviewed).toBe(false)
    expect(review.issues.some((i) => i.startsWith('too short'))).toBe(true)
    expect(generateJson).not.toHaveBeenCalled()
  })

  it('评审达标 -> pass，分数与问题回传', async () => {
    const gate = new QualityGate(
      makeLlm({
        generateJson: vi.fn().mockResolvedValue({
          data: { score: 85, issues: ['第二段因果略有跳步'] },
        }),
      }),
    )

    const review = await gate.review(LONG_TEXT)
    expect(review.pass).toBe(true)
    expect(review.score).toBe(85)
    expect(review.reviewed).toBe(true)
    expect(review.issues).toContain('第二段因果略有跳步')
  })

  it('评审不达标 -> 拒绝，离线问题合并进 issues', async () => {
    const gate = new QualityGate(
      makeLlm({
        generateJson: vi.fn().mockResolvedValue({
          data: { score: QUALITY_PASS_SCORE - 1, issues: ['全是空话'] },
        }),
      }),
    )

    const review = await gate.review(LONG_TEXT)
    expect(review.pass).toBe(false)
    expect(review.score).toBe(QUALITY_PASS_SCORE - 1)
    expect(review.issues).toContain('全是空话')
  })

  it('评审不可用时保守降级为不通过，绝不虚标', async () => {
    const gate = new QualityGate(
      makeLlm({
        generateJson: vi.fn().mockResolvedValue({ error: 'HTTP 500' }),
      }),
    )

    const review = await gate.review(LONG_TEXT)
    expect(review.pass).toBe(false)
    expect(review.score).toBe(-1)
    expect(review.reviewed).toBe(false)
    expect(review.issues.some((i) => i.includes('review unavailable'))).toBe(true)
  })

  it('越界与缺失分数被 clamp 到安全值', async () => {
    const cases: Array<{ data?: unknown; expected: number }> = [
      { data: { score: 300 }, expected: 100 },
      { data: { score: -5 }, expected: 0 },
      { data: { score: 'eighty' }, expected: 0 },
      { data: {}, expected: 0 },
    ]
    for (const c of cases) {
      const gate = new QualityGate(
        makeLlm({ generateJson: vi.fn().mockResolvedValue({ data: c.data }) }),
      )
      const review = await gate.review(LONG_TEXT)
      expect(review.score).toBe(c.expected)
    }
  })

  it('AI 腔词密集进入离线 issues（随评审一起上报）', async () => {
    const gate = new QualityGate(
      makeLlm({
        generateJson: vi.fn().mockResolvedValue({ data: { score: 75, issues: [] } }),
      }),
    )
    const clichy = '这不仅值得关注，而且引人深思。总之，然而因此综上所述，显而易见不可忽视，从某种意义上说由此可见。'
    const review = await gate.review(clichy + LONG_TEXT)
    expect(review.issues.some((i) => i.includes('AI-cliche density'))).toBe(true)
  })
})
