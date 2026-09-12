import { describe, it, expect } from 'vitest'
import { SourceAggregator } from '@akemi-mio/creativity/SourceAggregator'

describe('SourceAggregator', () => {
  it('跨域采样：至少覆盖 minDomains 个域', () => {
    const agg = new SourceAggregator(4, 3)
    agg.addProvider({ domain: 'module', name: 'm', collect: () => [{ name: 'Memory', content: 'a', type: 'knowledge', weight: 0.9 }] })
    agg.addProvider({
      domain: 'behavior',
      name: 'b',
      collect: () => [{ name: 'UserBehavior', content: 'b', type: 'behavior', weight: 0.7 }],
    })
    agg.addProvider({ domain: 'failure', name: 'f', collect: () => [{ name: '失败:x', content: 'c', type: 'failure', weight: 0.6 }] })
    const out = agg.build()
    expect(out.length).toBe(3)
  })

  it('每域限流 maxPerDomain 且同域去重', () => {
    const agg = new SourceAggregator(2, 1)
    agg.addProvider({
      domain: 'module',
      name: 'm',
      collect: () => [
        { name: 'A', content: '1', type: 'knowledge', weight: 0.5 },
        { name: 'A', content: 'dup', type: 'knowledge', weight: 0.5 },
        { name: 'B', content: '2', type: 'knowledge', weight: 0.9 },
        { name: 'C', content: '3', type: 'knowledge', weight: 0.7 },
      ],
    })
    const out = agg.build()
    expect(out.length).toBe(2)
    expect(out.map((s) => s.name)).toEqual(['B', 'C'])
  })

  it('provider 抛错时跳过并继续其他域', () => {
    const agg = new SourceAggregator(4, 2)
    agg.addProvider({
      domain: 'module',
      name: 'bad',
      collect: () => {
        throw new Error('boom')
      },
    })
    agg.addProvider({ domain: 'behavior', name: 'good', collect: () => [{ name: 'B', content: 'x', type: 'behavior', weight: 0.7 }] })
    agg.addProvider({ domain: 'failure', name: 'f2', collect: () => [{ name: 'F', content: 'y', type: 'failure', weight: 0.6 }] })
    const out = agg.build()
    expect(out.length).toBe(2)
  })
})
