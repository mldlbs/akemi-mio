import { describe, expect, it } from 'vitest'
import { formatPipelineBriefing } from '@akemi-mio/messaging/telegram/radar/RadarBriefingFormatter'

function makeBody() {
  return {
    reports: [{ date: '2026-08-11', total_signals: 165, high_value: 63 }],
    signals: [
      {
        id: 1,
        problem:
          'Developers need a simple way to authorize Google APIs from service accounts without fiddling with environment variables and complex scopes.',
        score: 10,
        classification: 'workflow',
        theme: 'dev_productivity',
        opportunity_class: 'Devtool',
        market_pull: 9,
        urgency: 9,
        buyer_clarity: 8,
        recurring_value: 10,
        execution_ease: 7,
        replacement_intent: 6,
        icp: 'Backend teams at B2B SaaS companies',
        gap: 'No purpose-built solution for service-account auth setup',
        pricing: '$99/mo team plan',
        mvp_suggestion: 'A CLI that generates scoped service accounts with zero config',
      },
    ],
    opportunities: [
      {
        title: 'Developers need a simple, reliable way to authorize Google APIs and list domain user accounts from service accounts',
        type: 'feature_request',
        appearances: 30,
        consecutive_days: 1,
        avg_score: 5,
      },
    ],
    themes: [{ theme: 'ai_infrastructure', count: 1153, trend_score: 10 }],
  }
}

describe('formatPipelineBriefing', () => {
  it('renders each signal with full content (no truncation)', () => {
    const msg = formatPipelineBriefing(makeBody(), { keywords: [] })
    expect(msg).toContain('Developers need a simple way to authorize Google APIs')
    expect(msg).toContain('目标用户: Backend teams at B2B SaaS companies')
    expect(msg).toContain('市场差距: No purpose-built solution for service-account auth setup')
    expect(msg).toContain('定价: $99/mo team plan')
    expect(msg).toContain('MVP建议: A CLI that generates scoped service accounts with zero config')
    expect(msg).toContain('持续追踪')
    expect(msg).toContain('主题覆盖')
    expect(msg).toContain('今日 165 信号')
  })

  it('filters signals by rule keywords', () => {
    const msg = formatPipelineBriefing(makeBody(), { keywords: ['Google APIs'] })
    expect(msg).toContain('Developers need a simple way to authorize Google APIs')
    // 关键词不命中时回退展示全量 Top，保证推送不落空
    const miss = formatPipelineBriefing(makeBody(), { keywords: ['不存在的关键词'] })
    expect(miss).toContain('Developers need a simple way to authorize Google APIs')
  })

  it('caps message length to stay within telegram limit', () => {
    const body = makeBody()
    body.signals = Array.from({ length: 10 }, (_, i) => ({
      id: i,
      problem: `Signal ${i}: ` + 'x'.repeat(200),
      score: 10 - i,
      classification: 'workflow',
      theme: 'dev_productivity',
      icp: 'y'.repeat(120),
      gap: 'z'.repeat(120),
      pricing: 'p'.repeat(80),
      mvp_suggestion: 'm'.repeat(200),
    }))
    const msg = formatPipelineBriefing(body, { keywords: [] })
    expect(msg.length).toBeLessThanOrEqual(4096)
    // 超长时自动减少详细信号条数，而不是截断内容
    expect(msg).not.toContain('已截断')
  })

  it('shows empty state when no data', () => {
    const msg = formatPipelineBriefing({ reports: [], signals: [], opportunities: [], themes: [] }, { keywords: [] })
    expect(msg).toContain('今日暂无信号数据')
  })
})
