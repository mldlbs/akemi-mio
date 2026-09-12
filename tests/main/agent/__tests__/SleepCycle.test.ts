import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SleepCycle } from '@akemi-mio/intelligence/agent/SleepCycle'

describe('SleepCycle', () => {
  let cycle: SleepCycle
  let mockMemory: any
  let mockAnalyzer: any
  let mockMeta: any

  beforeEach(() => {
    mockMemory = { getEntries: vi.fn(() => []), flush: vi.fn() }
    mockAnalyzer = { persistHotPatterns: vi.fn(() => 0) }
    mockMeta = { backgroundOptimization: vi.fn().mockResolvedValue(undefined) }
    cycle = new SleepCycle()
    cycle.setDeps(mockMemory, mockAnalyzer)
    cycle.setMetaController(mockMeta)
  })

  it('繁忙时跳过', async () => {
    await cycle.run(() => true)
    expect(mockMeta.backgroundOptimization).not.toHaveBeenCalled()
    expect(mockMemory.flush).not.toHaveBeenCalled()
  })

  it('空闲时执行三个任务', async () => {
    mockMemory.getEntries.mockReturnValue([
      { id: '1', type: 'user_fact', content: '测试', confidence: 0.8, tier: 'ephemeral', reinforceCount: 0 },
    ])
    await cycle.run(() => false)
    expect(mockMeta.backgroundOptimization).toHaveBeenCalled()
    expect(mockMemory.flush).toHaveBeenCalled()
    expect(mockAnalyzer.persistHotPatterns).toHaveBeenCalled()
  })

  it('空 entries 跳过 consolidation', async () => {
    mockMemory.getEntries.mockReturnValue([])
    await cycle.run(() => false)
    expect(mockMemory.flush).not.toHaveBeenCalled()
  })

  it('有重复条目时合并', async () => {
    mockMemory.getEntries.mockReturnValue([
      { id: '1', type: 'user_fact', content: '喜欢咖啡', confidence: 0.8, tier: 'ephemeral', reinforceCount: 0 },
      { id: '2', type: 'user_fact', content: '喜欢咖啡', confidence: 0.6, tier: 'ephemeral', reinforceCount: 0 },
    ])
    await cycle.run(() => false)
    expect(mockMemory.flush).toHaveBeenCalled()
  })

  it('permanent 条目即使低置信也不被清理', async () => {
    mockMemory.getEntries.mockReturnValue([
      { id: '1', type: 'user_fact', content: '永久', confidence: 0.1, tier: 'permanent', reinforceCount: 0 },
    ])
    await cycle.run(() => false)
    expect(mockMemory.flush).toHaveBeenCalled()
  })

  it('mineFailurePatterns 抛异常不影响整体', async () => {
    mockAnalyzer.persistHotPatterns.mockImplementation(() => {
      throw new Error('oops')
    })
    await expect(cycle.run(() => false)).resolves.toBeUndefined()
  })

  it('未设 deps 时不抛异常', async () => {
    const c = new SleepCycle()
    await expect(c.run(() => false)).resolves.toBeUndefined()
  })

  it('未设 metaController 时不抛异常', async () => {
    const c = new SleepCycle()
    c.setDeps(mockMemory, mockAnalyzer)
    await expect(c.run(() => false)).resolves.toBeUndefined()
  })
})
