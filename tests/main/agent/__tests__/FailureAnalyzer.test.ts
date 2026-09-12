import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FailureAnalyzer } from '@akemi-mio/intelligence/agent/FailureAnalyzer'

describe('FailureAnalyzer', () => {
  let analyzer: FailureAnalyzer
  let mockEngineering: any

  beforeEach(() => {
    mockEngineering = { store: vi.fn() }
    analyzer = new FailureAnalyzer(mockEngineering as any)
  })

  it('启动时订阅 EventBus', () => {
    const bus = { on: vi.fn(() => () => {}) }
    const a = new FailureAnalyzer(undefined, bus as any)
    a.start()
    expect(bus.on).toHaveBeenCalledWith('agent.tool.failed', expect.any(Function))
    expect(bus.on).toHaveBeenCalledWith('agent.error', expect.any(Function))
  })

  it('stop 取消订阅', () => {
    const bus = { on: vi.fn(() => vi.fn()) }
    const a = new FailureAnalyzer(undefined, bus as any)
    a.start()
    const unsubs = bus.on.mock.results.map((r: any) => r.value)
    a.stop()
    for (const u of unsubs) expect(u).toHaveBeenCalled()
  })

  it('record 写入失败记录和模式', () => {
    analyzer.record({ type: 'tool', name: 'read_file', error: 'ETIMEOUT', context: 'tool_execution', timestamp: Date.now() })

    const hot = analyzer.getHotPatterns()
    expect(hot).toHaveLength(0) // count >= 2 才返回
    expect(analyzer.getStats().total).toBe(1)
    expect(analyzer.getStats().patterns).toBe(1)
  })

  it('相同错误聚合为同一模式', () => {
    const now = Date.now()
    analyzer.record({ type: 'tool', name: 'read_file', error: 'ETIMEOUT', context: '', timestamp: now })
    analyzer.record({ type: 'tool', name: 'read_file', error: 'ETIMEOUT', context: '', timestamp: now })

    const hot = analyzer.getHotPatterns()
    expect(hot).toHaveLength(1)
    expect(hot[0].count).toBe(2)
    expect(hot[0].names.has('read_file')).toBe(true)
  })

  it('getHotPatterns 按衰减权重排序', () => {
    const old = Date.now() - 48 * 60 * 60 * 1000
    analyzer.record({ type: 'tool', name: 'old_error', error: 'STALE', context: '', timestamp: old })
    analyzer.record({ type: 'tool', name: 'old_error', error: 'STALE', context: '', timestamp: old })

    const recent = Date.now()
    analyzer.record({ type: 'tool', name: 'fresh_error', error: 'FRESH', context: '', timestamp: recent })
    analyzer.record({ type: 'tool', name: 'fresh_error', error: 'FRESH', context: '', timestamp: recent })

    const hot = analyzer.getHotPatterns(5)
    expect(hot[0].fingerprint).toContain('FRESH')
  })

  it('persistHotPatterns 写入 EngineeringMemory', () => {
    const now = Date.now()
    for (let i = 0; i < 3; i++) {
      analyzer.record({ type: 'tool', name: 'write_file', error: 'EPERM', context: '', timestamp: now })
    }

    const saved = analyzer.persistHotPatterns()
    expect(saved).toBeGreaterThan(0)
    expect(mockEngineering.store).toHaveBeenCalled()
    const call = mockEngineering.store.mock.calls[0][0]
    expect(call.type).toBe('failure_pattern')
    expect(call.source).toBe('failure_analyzer')
  })

  it('getFormattedContext 空时返回空', () => {
    expect(analyzer.getFormattedContext()).toBe('')
  })

  it('getFormattedContext 包含热点模式', () => {
    const now = Date.now()
    for (let i = 0; i < 3; i++) {
      analyzer.record({ type: 'tool', name: 'search', error: 'NOT_FOUND', context: '', timestamp: now })
    }

    const ctx = analyzer.getFormattedContext()
    expect(ctx).toContain('search')
    expect(ctx).toContain('3次')
  })
})
