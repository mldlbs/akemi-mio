import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MetaController } from '../MetaController'

describe('MetaController 压力测试', () => {
  let mc: MetaController
  let mockSummary: any
  let mockDecisions: any
  let mockMemory: any

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    mockSummary = { addSummary: vi.fn(), getAll: vi.fn(() => []) }
    mockDecisions = { record: vi.fn(), query: vi.fn(() => []), updateOutcome: vi.fn() }
    mockMemory = { flush: vi.fn(), addEntry: vi.fn() }
    mc = new MetaController()
    mc.setDeps({ summary: mockSummary as any, decisions: mockDecisions as any, memory: mockMemory as any })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const makeCtx = (o = {}) => ({
    userMessage: '你好',
    assistantReply: '嗨',
    tokenUsed: 50,
    tokenBudget: 1000,
    planActive: false,
    agentId: 'chat',
    ...o,
  })

  it('5000 次 onInteractionEnd 统计正确', () => {
    for (let i = 0; i < 5000; i++) mc.onInteractionEnd(makeCtx({ tokenUsed: 50 + (i % 10) * 100, planActive: i % 7 === 0 }))
    const stats = mc.getStats()
    expect(stats.totalInteractions).toBe(5000)
    expect(stats.summariesCreated).toBeGreaterThan(900)
    expect(stats.decisionsLogged).toBe(5000)
  })

  it('5000 次 recordMemoryQuery 后 hitRate 稳定', () => {
    for (let i = 0; i < 5000; i++) mc.recordMemoryQuery(i % 4 !== 0)
    const stats = mc.getStats()
    expect(stats.totalQueries).toBeGreaterThan(0)
    expect(stats.hitQueries).toBeGreaterThan(0)
    expect(stats.memoryHitRate).toBeGreaterThan(0.5)
    expect(stats.memoryHitRate).toBeLessThan(0.9)
  })

  it('1000 次 backgroundOptimization 不崩溃', async () => {
    for (let i = 0; i < 1000; i++) {
      vi.advanceTimersByTime(31 * 60 * 1000 + 1000)
      await mc.backgroundOptimization()
    }
    expect(mc.getStats().consolidationsRun).toBe(1000)
    expect(mockMemory.flush).toHaveBeenCalledTimes(1000)
  })

  it('混合操作 100 轮', async () => {
    for (let round = 0; round < 100; round++) {
      for (let i = 0; i < 50; i++) {
        mc.onInteractionEnd(makeCtx({ tokenUsed: 100 + i * 10, planActive: i % 5 === 0 }))
        mc.recordMemoryQuery(i % 3 !== 0)
      }
      vi.advanceTimersByTime(31 * 60 * 1000 + 1000)
      await mc.backgroundOptimization()
    }
    expect(mc.getStats().totalInteractions).toBe(5000)
    expect(mc.getStats().consolidationsRun).toBe(100)
    expect(mc.getPolicy().summaryFrequency).toBeGreaterThanOrEqual(2)
    expect(mc.getPolicy().summaryFrequency).toBeLessThanOrEqual(15)
  })

  it('高频 interaction 不触发 summary (token 比例很低)', () => {
    for (let i = 0; i < 1000; i++) mc.onInteractionEnd(makeCtx({ tokenUsed: 10, tokenBudget: 10000, planActive: false }))
    // summaryFrequency=5, 1000/5 = 200 次摘要
    expect(mockSummary.addSummary).toHaveBeenCalledTimes(200)
  })

  it('token 比例持续超过阈值持续触发摘要', () => {
    for (let i = 0; i < 20; i++) mc.onInteractionEnd(makeCtx({ tokenUsed: 800, tokenBudget: 1000, planActive: false }))
    // 每次 token 比例 0.8 > 0.7，每次都触发
    expect(mockSummary.addSummary).toHaveBeenCalledTimes(20)
  })

  it('planActive 比例影响决策类别', () => {
    for (let i = 0; i < 100; i++) mc.onInteractionEnd(makeCtx({ tokenUsed: 10, tokenBudget: 1000, planActive: i % 2 === 0 }))
    const planRouteCalls = mockDecisions.record.mock.calls.filter((c: any) => c[0].category === 'plan_route').length
    const toolSelectCalls = mockDecisions.record.mock.calls.filter((c: any) => c[0].category === 'tool_select').length
    expect(planRouteCalls).toBe(50)
    expect(toolSelectCalls).toBe(50)
  })

  it('100 次 adaptation 后 frequency 不越界', () => {
    for (let i = 0; i < 15; i++) mc.recordMemoryQuery(true)
    mc.recordMemoryQuery(false) // hitRate = 15/16 > 0.8
    for (let i = 0; i < 2000; i++) mc.onInteractionEnd(makeCtx({ tokenUsed: 10, tokenBudget: 1000 }))
    const freq = mc.getPolicy().summaryFrequency
    expect(freq).toBeGreaterThanOrEqual(2)
    expect(freq).toBeLessThanOrEqual(15)
  })
})
