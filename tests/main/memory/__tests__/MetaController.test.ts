import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MetaController, DEFAULT_POLICY } from '@akemi-mio/intelligence/memory/MetaController'

describe('MetaController', () => {
  let mc: MetaController
  let mockSummary: any
  let mockDecisions: any
  let mockMemory: any

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000) // 保证 now - lastConsolidation 足够小
    mockSummary = { addSummary: vi.fn(), getAll: vi.fn(() => []) }
    mockDecisions = { record: vi.fn(), query: vi.fn(() => []), updateOutcome: vi.fn() }
    mockMemory = { flush: vi.fn(), addEntry: vi.fn() }
    mc = new MetaController()
    mc.setDeps({ summary: mockSummary as any, decisions: mockDecisions as any, memory: mockMemory as any })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ─── constructor ───

  it('默认 policy 与 DEFAULT_POLICY 一致', () => {
    const m = new MetaController()
    const p = m.getPolicy()
    expect(p.summaryFrequency).toBe(DEFAULT_POLICY.summaryFrequency)
    expect(p.summaryTokenThreshold).toBe(DEFAULT_POLICY.summaryTokenThreshold)
    expect(p.decisionLogChance).toBe(DEFAULT_POLICY.decisionLogChance)
    expect(p.consolidationInterval).toBe(DEFAULT_POLICY.consolidationInterval)
  })

  it('partial policy 合并覆盖', () => {
    const m = new MetaController({ summaryFrequency: 10 })
    expect(m.getPolicy().summaryFrequency).toBe(10)
    expect(m.getPolicy().decisionLogChance).toBe(1.0)
  })

  it('初始 stats 全零', () => {
    const s = mc.getStats()
    expect(s.totalInteractions).toBe(0)
    expect(s.summariesCreated).toBe(0)
    expect(s.decisionsLogged).toBe(0)
    expect(s.consolidationsRun).toBe(0)
  })

  // ─── setDeps / getter ───

  it('setDeps 后 getPolicy/getStats 可访问', () => {
    expect(mc.getPolicy()).toBeDefined()
    expect(mc.getStats()).toBeDefined()
  })

  // ─── onInteractionEnd ───

  const makeCtx = (overrides = {}) => ({
    userMessage: '你好',
    assistantReply: '嗨',
    tokenUsed: 100,
    tokenBudget: 200,
    planActive: false,
    agentId: 'chat',
    ...overrides,
  })

  it('每次调用递增 totalInteractions', () => {
    mc.onInteractionEnd(makeCtx())
    expect(mc.getStats().totalInteractions).toBe(1)
    mc.onInteractionEnd(makeCtx())
    expect(mc.getStats().totalInteractions).toBe(2)
  })

  it('达到 summaryFrequency 时触发摘要', () => {
    for (let i = 0; i < 5; i++) {
      mc.onInteractionEnd(makeCtx({ tokenUsed: 10, tokenBudget: 1000 }))
    }
    expect(mockSummary.addSummary).toHaveBeenCalled()
    expect(mc.getStats().summariesCreated).toBe(1)
  })

  it('token 比例超过阈值时触发摘要（即使未达频率）', () => {
    mc.onInteractionEnd(makeCtx({ tokenUsed: 180, tokenBudget: 200 }))
    expect(mockSummary.addSummary).toHaveBeenCalled()
  })

  it('低频且低 token 时不触发摘要', () => {
    mc.onInteractionEnd(makeCtx({ tokenUsed: 50, tokenBudget: 1000 }))
    expect(mockSummary.addSummary).not.toHaveBeenCalled()
  })

  it('decisionLogChance=1.0 时每次记录决策', () => {
    for (let i = 0; i < 3; i++) {
      mc.onInteractionEnd(makeCtx({ tokenUsed: 0, tokenBudget: 0 }))
    }
    expect(mockDecisions.record).toHaveBeenCalledTimes(3)
    expect(mc.getStats().decisionsLogged).toBe(3)
  })

  it('planActive=true 时记录 plan_route 决策', () => {
    mc.onInteractionEnd(makeCtx({ planActive: true, tokenUsed: 0, tokenBudget: 0 }))
    expect(mockDecisions.record).toHaveBeenCalledWith(expect.objectContaining({ category: 'plan_route' }))
  })

  it('planActive=false 时记录 tool_select 决策', () => {
    mc.onInteractionEnd(makeCtx({ planActive: false, tokenUsed: 0, tokenBudget: 0 }))
    expect(mockDecisions.record).toHaveBeenCalledWith(expect.objectContaining({ category: 'tool_select' }))
  })

  it('每 10 次交互触发 adaptPolicy（不抛异常）', () => {
    for (let i = 0; i < 10; i++) {
      mc.onInteractionEnd(makeCtx({ tokenUsed: 0, tokenBudget: 0 }))
    }
    expect(mc.getStats().totalInteractions).toBe(10)
  })

  // ─── 摘要内容 ───

  it('摘要内容包含用户消息和回复', () => {
    mc.onInteractionEnd(
      makeCtx({ userMessage: '测试消息', assistantReply: '测试回复', planActive: false, tokenUsed: 200, tokenBudget: 200 }),
    )
    expect(mockSummary.addSummary).toHaveBeenCalledWith(
      expect.stringContaining('测试消息'),
      expect.any(Number),
      expect.any(Number),
      expect.objectContaining({ topics: [] }),
    )
  })

  // ─── backgroundOptimization ───

  it('未到 consolidationInterval 时不做优化', async () => {
    // 确保时间是 0 纪元之后
    vi.setSystemTime(1000)
    await mc.backgroundOptimization()
    expect(mockMemory.flush).not.toHaveBeenCalled()
    expect(mc.getStats().consolidationsRun).toBe(0)
  })

  it('到 consolidationInterval 后执行优化', async () => {
    vi.advanceTimersByTime(31 * 60 * 1000 + 1000)
    await mc.backgroundOptimization()
    expect(mockMemory.flush).toHaveBeenCalled()
    expect(mc.getStats().consolidationsRun).toBe(1)
  })

  it('足够条目时触发 consolidateSummaries', async () => {
    mockSummary.getAll.mockReturnValue(
      Array.from({ length: 12 }, (_, i) => ({
        topics: [`topic${i}`],
        decisions: [],
        turnStart: i * 1000,
        turnEnd: (i + 1) * 1000,
      })),
    )
    vi.advanceTimersByTime(31 * 60 * 1000 + 1000)
    await mc.backgroundOptimization()
    expect(mockMemory.flush).toHaveBeenCalled()
  })

  // ─── recordMemoryQuery ───

  it('recordMemoryQuery 命中后增加 hitQueries', () => {
    mc.recordMemoryQuery(true)
    expect(mc.getStats().hitQueries).toBe(1)
    expect(mc.getStats().totalQueries).toBe(1)
  })

  it('recordMemoryQuery 未命中只增加 totalQueries', () => {
    mc.recordMemoryQuery(false)
    expect(mc.getStats().hitQueries).toBe(0)
    expect(mc.getStats().totalQueries).toBe(1)
  })

  it('memoryHitRate 正确计算', () => {
    mc.recordMemoryQuery(true)
    mc.recordMemoryQuery(true)
    mc.recordMemoryQuery(false)
    expect(mc.getStats().memoryHitRate).toBeCloseTo(2 / 3, 2)
  })

  // ─── 无 deps 时不抛异常 ───

  it('未调用 setDeps 时 onInteractionEnd 不抛异常', () => {
    const m = new MetaController()
    expect(() =>
      m.onInteractionEnd({ userMessage: 'hi', assistantReply: 'hello', tokenUsed: 10, tokenBudget: 100, planActive: false, agentId: 'a' }),
    ).not.toThrow()
  })

  it('未调用 setDeps 时 backgroundOptimization 不抛异常', async () => {
    const m = new MetaController()
    vi.advanceTimersByTime(31 * 60 * 1000)
    await expect(m.backgroundOptimization()).resolves.toBeUndefined()
  })
})
