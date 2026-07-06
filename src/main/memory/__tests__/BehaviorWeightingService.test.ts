import { describe, it, expect, beforeEach, vi } from 'vitest'
import { BehaviorWeightingService } from '../BehaviorWeightingService'
import type { InteractionRecord } from '../types'

vi.mock('../../logger/Logger', () => ({ log: vi.fn() }))

function makeInteraction(opts: {
  userText: string
  topics: string[]
  timestamp?: number
  offset?: number // minutes ago
}): InteractionRecord {
  const ts = opts.timestamp || (Date.now() - (opts.offset || 0) * 60_000)
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
    const interactions = [
      makeInteraction({ userText: '帮我写代码', topics: ['编程', '调试'] }),
    ]
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
    const interactions = [
      makeInteraction({ userText: '写代码', topics: ['编程'] }),
    ]
    const profile = svc.computeInterestProfile(interactions)
    const boost = svc.getTopicSimilarityBoost([], profile)
    expect(boost).toBe(0)
  })

  it('匹配主题获得 boost', () => {
    const interactions = [
      makeInteraction({ userText: '帮我调试代码', topics: ['编程', '调试'] }),
    ]
    const profile = svc.computeInterestProfile(interactions)
    const boost = svc.getTopicSimilarityBoost(['编程'], profile)
    expect(boost).toBeGreaterThan(0)
  })

  it('不匹配主题 boost 为 0', () => {
    const interactions = [
      makeInteraction({ userText: '写代码', topics: ['编程'] }),
    ]
    const profile = svc.computeInterestProfile(interactions)
    const boost = svc.getTopicSimilarityBoost(['部署'], profile)
    expect(boost).toBe(0)
  })

  it('多主题匹配获得更高 boost', () => {
    const interactions = [
      makeInteraction({ userText: '写代码+测试', topics: ['编程', '测试', '调试'] }),
    ]
    const profile = svc.computeInterestProfile(interactions)
    const singleBoost = svc.getTopicSimilarityBoost(['编程'], profile)
    const multiBoost = svc.getTopicSimilarityBoost(['编程', '测试', '调试'], profile)
    expect(multiBoost).toBeGreaterThan(singleBoost)
  })

  it('getWeightedScore 不超出上限 1.0', () => {
    const interactions = [
      makeInteraction({ userText: '编程', topics: ['编程'] }),
    ]
    const profile = svc.computeInterestProfile(interactions)
    const score = svc.getWeightedScore(0.95, ['编程'], profile)
    expect(score).toBeLessThanOrEqual(1.0)
  })

  it('缓存机制在间隔内返回相同结果', () => {
    // 设置缓存间隔为 10s
    svc.updateConfig({ updateIntervalMs: 10_000 })
    const interactions = [
      makeInteraction({ userText: '编程', topics: ['编程'] }),
    ]
    const p1 = svc.computeInterestProfile(interactions)
    const p2 = svc.computeInterestProfile(interactions)
    expect(p1).toBe(p2) // same reference (cached)
  })

  it('forceRefresh 忽略缓存', () => {
    svc.updateConfig({ updateIntervalMs: 10_000 })
    const interactions = [
      makeInteraction({ userText: '编程', topics: ['编程'] }),
    ]
    const p1 = svc.computeInterestProfile(interactions)
    const p2 = svc.computeInterestProfile(interactions, true)
    expect(p1).not.toBe(p2) // different reference
  })

  it('invalidateCache 清除缓存', () => {
    svc.updateConfig({ updateIntervalMs: 10_000 })
    const interactions = [
      makeInteraction({ userText: '编程', topics: ['编程'] }),
    ]
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
    // 编程和调试应该在前二（出现了两次 vs 部署一次）
    expect(top).toContain('编程')
    expect(top).toContain('调试')
  })

  it('低于 minInterestStrength 的主题不影响 boost', () => {
    svc.updateConfig({ minInterestStrength: 100 }) // 极高阈值
    const interactions = [
      makeInteraction({ userText: '编程', topics: ['编程'] }),
    ]
    const profile = svc.computeInterestProfile(interactions)
    const boost = svc.getTopicSimilarityBoost(['编程'], profile)
    expect(boost).toBe(0)
  })

  it('配置更新后重新计算', () => {
    const interactions = [
      makeInteraction({ userText: '编程', topics: ['编程'] }),
    ]
    const p1 = svc.computeInterestProfile(interactions, true)
    svc.updateConfig({ interestWindowSize: 2 })
    const p2 = svc.computeInterestProfile(interactions, true)
    // 配置更新会清除缓存
    expect(p1).not.toBe(p2)
  })
})
