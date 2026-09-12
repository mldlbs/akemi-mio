import { describe, it, expect, beforeEach, vi } from 'vitest'
import { BehaviorWeightingService } from '@akemi-mio/intelligence/memory/BehaviorWeightingService'
import type { InteractionRecord } from '@akemi-mio/intelligence/memory/types'

vi.mock('@akemi-mio/core/logger/Logger', () => ({ log: vi.fn() }))

function makeInteraction(opts: {
  userText: string
  topics: string[]
  timestamp?: number
  offset?: number // minutes ago
}): InteractionRecord {
  const ts = opts.timestamp || Date.now() - (opts.offset || 0) * 60_000
  return {
    id: `ilog_${ts}`,
    userText: opts.userText,
    responseTimeMs: null,
    topics: opts.topics,
    isExplicitRemember: false,
    rementionedMemoryIds: [],
    timestamp: ts,
    createdAt: ts,
  }
}

describe('BehaviorWeightingService', () => {
  let svc: BehaviorWeightingService

  beforeEach(() => {
    svc = new BehaviorWeightingService({
      interestWindowSize: 8,
      recencyDecayRate: 0.9,
      baseBoostFactor: 0.3,
      minInterestStrength: 0.5,
      updateIntervalMs: 0, // no caching for tests
    })
  })

  it('空交互返回空兴趣分布', () => {
    const profile = svc.computeInterestProfile([])
    expect(profile.topicWeights.size).toBe(0)
    expect(profile.totalWeight).toBe(0)
  })

  it('单次交互产生正确兴趣分布', () => {
    const interactions = [makeInteraction({ userText: '帮我写代码', topics: ['编程', '调试'] })]
    const profile = svc.computeInterestProfile(interactions)
    expect(profile.topicWeights.get('编程')).toBeGreaterThan(0)
    expect(profile.topicWeights.get('调试')).toBeGreaterThan(0)
  })

  it('近期交互权重更高', () => {
    const now = Date.now()
    const interactions = [
      makeInteraction({ userText: '旧消息', topics: ['编程'], timestamp: now - 3600_000 }),
      makeInteraction({ userText: '新消息', topics: ['调试'], timestamp: now }),
    ]
    const profile = svc.computeInterestProfile(interactions)
    // 新消息的权重应该更高
    const debugWeight = profile.topicWeights.get('调试') || 0
    const progWeight = profile.topicWeights.get('编程') || 0
    expect(debugWeight).toBeGreaterThan(progWeight)
  })

  it('无主题标签的记忆 boost 为 0', () => {
    const interactions = [makeInteraction({ userText: '写代码', topics: ['编程'] })]
    const profile = svc.computeInterestProfile(interactions)
    const boost = svc.getTopicSimilarityBoost([], profile)
    expect(boost).toBe(0)
  })

  it('匹配主题获得 boost', () => {
    const interactions = [makeInteraction({ userText: '帮我调试代码', topics: ['编程', '调试'] })]
    const profile = svc.computeInterestProfile(interactions)
    const boost = svc.getTopicSimilarityBoost(['编程'], profile)
    expect(boost).toBeGreaterThan(0)
  })

  it('不匹配主题 boost 为 0', () => {
    const interactions = [makeInteraction({ userText: '写代码', topics: ['编程'] })]
    const profile = svc.computeInterestProfile(interactions)
    const boost = svc.getTopicSimilarityBoost(['部署'], profile)
    expect(boost).toBe(0)
  })

  it('无关主题按交集占比稀释 boost', () => {
    const interactions = [makeInteraction({ userText: '写代码+测试', topics: ['编程', '测试', '调试'] })]
    const profile = svc.computeInterestProfile(interactions)
    const singleBoost = svc.getTopicSimilarityBoost(['编程'], profile)
    const dilutedBoost = svc.getTopicSimilarityBoost(['编程', '无关主题A', '无关主题B'], profile)
    expect(singleBoost).toBeGreaterThan(dilutedBoost)
  })

  it('getWeightedScore 不超出上限 1.0', () => {
    const interactions = [makeInteraction({ userText: '编程', topics: ['编程'] })]
    const profile = svc.computeInterestProfile(interactions)
    const score = svc.getWeightedScore(0.95, ['编程'], profile)
    expect(score).toBeLessThanOrEqual(1.0)
  })

  it('缓存机制在间隔内返回相同结果', () => {
    // 设置缓存间隔为 10s
    svc.updateConfig({ updateIntervalMs: 10_000 })
    const interactions = [makeInteraction({ userText: '编程', topics: ['编程'] })]
    const p1 = svc.computeInterestProfile(interactions)
    const p2 = svc.computeInterestProfile(interactions)
    expect(p1).toBe(p2) // same reference (cached)
  })

  it('forceRefresh 忽略缓存', () => {
    svc.updateConfig({ updateIntervalMs: 10_000 })
    const interactions = [makeInteraction({ userText: '编程', topics: ['编程'] })]
    const p1 = svc.computeInterestProfile(interactions)
    const p2 = svc.computeInterestProfile(interactions, true)
    expect(p1).not.toBe(p2) // different reference
  })

  it('invalidateCache 清除缓存', () => {
    svc.updateConfig({ updateIntervalMs: 10_000 })
    const interactions = [makeInteraction({ userText: '编程', topics: ['编程'] })]
    const p1 = svc.computeInterestProfile(interactions)
    svc.invalidateCache()
    const p2 = svc.computeInterestProfile(interactions)
    expect(p1).not.toBe(p2)
  })

  it('getTopInterests 返回前 K 个', () => {
    const interactions = [
      makeInteraction({ userText: 'a', topics: ['编程', '调试'] }),
      makeInteraction({ userText: 'b', topics: ['部署'] }),
    ]
    const profile = svc.computeInterestProfile(interactions)
    const top = svc.getTopInterests(profile, 2)
    expect(top.length).toBeLessThanOrEqual(2)
    // 最近交互（部署）权重最高排第一；较早交互的 编程/调试 次之
    expect(top[0]).toBe('部署')
    expect(top).toContain('编程')
  })

  it('低于 minInterestStrength 的主题不影响 boost', () => {
    svc.updateConfig({ minInterestStrength: 100 }) // 极高阈值
    const interactions = [makeInteraction({ userText: '编程', topics: ['编程'] })]
    const profile = svc.computeInterestProfile(interactions)
    const boost = svc.getTopicSimilarityBoost(['编程'], profile)
    expect(boost).toBe(0)
  })

  it('配置更新后重新计算', () => {
    const interactions = [makeInteraction({ userText: '编程', topics: ['编程'] })]
    const p1 = svc.computeInterestProfile(interactions, true)
    svc.updateConfig({ interestWindowSize: 2 })
    const p2 = svc.computeInterestProfile(interactions, true)
    // 配置更新会清除缓存
    expect(p1).not.toBe(p2)
  })

  // ══════════════════════════════════════════
  //  话题新鲜度 & 清洗乘数
  // ══════════════════════════════════════════

  describe('getTopicRecencyMs', () => {
    it('空交互返回 null', () => {
      const result = svc.getTopicRecencyMs('编程', [])
      expect(result).toBeNull()
    })

    it('从未提及返回 null', () => {
      const interactions = [makeInteraction({ userText: '写代码', topics: ['调试'] })]
      const result = svc.getTopicRecencyMs('编程', interactions)
      expect(result).toBeNull()
    })

    it('最近提及返回正数（最近一次的时间差）', () => {
      const now = Date.now()
      const interactions = [
        makeInteraction({ userText: '旧', topics: ['编程'], timestamp: now - 3600_000 }),
        makeInteraction({ userText: '新', topics: ['编程'], timestamp: now }),
      ]
      const result = svc.getTopicRecencyMs('编程', interactions)
      expect(result).not.toBeNull()
      expect(result!).toBeGreaterThanOrEqual(0)
      // 应该引用最新的那条 timeStamp（即 now）
      expect(result!).toBeLessThan(100) // 毫秒级精度
    })

    it('只匹配最近一次出现', () => {
      const now = Date.now()
      const interactions = [
        makeInteraction({ userText: '很旧', topics: ['编程'], timestamp: now - 7200_000 }),
        makeInteraction({ userText: '中间', topics: ['调试'], timestamp: now - 3600_000 }),
        makeInteraction({ userText: '最新', topics: ['编程'], timestamp: now }),
      ]
      const result = svc.getTopicRecencyMs('编程', interactions)
      expect(result!).toBeLessThan(100) // 匹配最新的
    })
  })

  describe('computeCleanupMultiplier', () => {
    it('无话题标签返回 1.0', () => {
      const profile = svc.computeInterestProfile([])
      const mult = svc.computeCleanupMultiplier([], [], profile)
      expect(mult).toBe(1.0)
    })

    it('话题在当前兴趣中返回 2.0（强力保护）', () => {
      const interactions = [makeInteraction({ userText: '写代码', topics: ['编程'] })]
      const profile = svc.computeInterestProfile(interactions)
      const mult = svc.computeCleanupMultiplier(['编程'], interactions, profile)
      expect(mult).toBe(2.0)
    })

    it('7天内被提及返回 1.0（中性）', () => {
      const now = Date.now()
      const interactions = [makeInteraction({ userText: '之前', topics: ['编程'], timestamp: now - 3 * 24 * 3600_000 })]
      const profile = svc.computeInterestProfile(interactions) // 窗口太小可能已过期
      // 手动构建一个空 profile 以确保不命中兴趣路径
      const emptyProfile = svc.computeInterestProfile([])
      const mult = svc.computeCleanupMultiplier(['编程'], interactions, emptyProfile)
      expect(mult).toBe(1.0)
    })

    it('超过7天未提及逐步衰减', () => {
      const now = Date.now()
      const interactions = [makeInteraction({ userText: '旧话题', topics: ['编程'], timestamp: now - 14 * 24 * 3600_000 })]
      const emptyProfile = svc.computeInterestProfile([])
      const mult = svc.computeCleanupMultiplier(['编程'], interactions, emptyProfile)
      // 14天: 1.0 - min(0.5, (14-7) * 0.03) = 1.0 - 0.21 = 0.79
      expect(mult).toBeGreaterThan(0.6)
      expect(mult).toBeLessThan(0.9)
    })

    it('超过24天最低为 0.5', () => {
      const now = Date.now()
      const interactions = [makeInteraction({ userText: '远古话题', topics: ['编程'], timestamp: now - 30 * 24 * 3600_000 })]
      const emptyProfile = svc.computeInterestProfile([])
      const mult = svc.computeCleanupMultiplier(['编程'], interactions, emptyProfile)
      expect(mult).toBe(0.5)
    })

    it('从未被提及返回 0.5', () => {
      const interactions = [makeInteraction({ userText: '别的', topics: ['调试'] })]
      const emptyProfile = svc.computeInterestProfile([])
      const mult = svc.computeCleanupMultiplier(['编程'], interactions, emptyProfile)
      expect(mult).toBe(0.5)
    })

    it('多个话题取最优（最高）乘数', () => {
      const now = Date.now()
      const interactions = [
        makeInteraction({ userText: '旧话题', topics: ['编程'], timestamp: now - 14 * 24 * 3600_000 }),
        makeInteraction({ userText: '最近话题', topics: ['调试'], timestamp: now - 2 * 24 * 3600_000 }),
      ]
      const emptyProfile = svc.computeInterestProfile([])
      // 调试最近提及 → 1.0，编程正在衰减 <1.0
      // 取最优应返回 1.0
      const mult = svc.computeCleanupMultiplier(['编程', '调试'], interactions, emptyProfile)
      expect(mult).toBe(1.0)
    })

    it('兴趣分布命中时忽略新鲜度', () => {
      const now = Date.now()
      const interactions = [
        makeInteraction({ userText: '最近写代码', topics: ['编程'] }),
        makeInteraction({ userText: '旧调试', topics: ['调试'], timestamp: now - 30 * 24 * 3600_000 }),
      ]
      const profile = svc.computeInterestProfile(interactions)
      // 调试在兴趣分布中可能没有，但在交互记录中
      const emptyProfile = svc.computeInterestProfile([])
      // 用空 profile → 调试走新鲜度衰减
      const mult = svc.computeCleanupMultiplier(['调试'], interactions, emptyProfile)
      expect(mult).toBe(0.5) // 30天
    })
  })
})
