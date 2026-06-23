import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ModelHealthTracker } from '../ModelHealthTracker'
import { eventBus } from '../../core/EventBus'

vi.mock('../../logger/Logger', () => ({ log: vi.fn() }))

function resetEvents() {
  eventBus.removeAll()
}

describe('ModelHealthTracker', () => {
  beforeEach(() => {
    resetEvents()
  })

  it('start → getHealth 返回 100（无事件）', () => {
    const t = new ModelHealthTracker()
    t.start()
    const h = t.getHealth()
    expect(h.score).toBe(100)
    expect(h.totalToolCalls).toBe(0)
    t.stop()
  })

  it('start → stop 生命周期不报错', () => {
    const t = new ModelHealthTracker()
    t.start()
    t.stop()
    expect(true).toBe(true)
  })

  it('100% 完成 → score=100', () => {
    const t = new ModelHealthTracker()
    t.start()
    for (let i = 0; i < 10; i++) {
      eventBus.emit('agent.tool.completed' as any, { tool: 'test', result: 'ok' })
    }
    const h = t.getHealth()
    expect(h.successCount).toBe(10)
    expect(h.score).toBe(100)
    t.stop()
  })

  it('50% 失败 → score=50', () => {
    const t = new ModelHealthTracker()
    t.start()
    for (let i = 0; i < 5; i++) {
      eventBus.emit('agent.tool.completed' as any, { tool: 't', result: 'ok' })
      eventBus.emit('agent.tool.failed' as any, { tool: 't', error: 'err' })
    }
    const h = t.getHealth()
    expect(h.successCount).toBe(5)
    expect(h.failureCount).toBe(5)
    expect(h.totalToolCalls).toBe(10)
    expect(h.score).toBe(50)
    t.stop()
  })

  it('errorBreakdown 记录分类事件', () => {
    const t = new ModelHealthTracker()
    t.start()
    eventBus.emit('recovery.error.classified' as any, { category: 'RETRYABLE' })
    eventBus.emit('recovery.error.classified' as any, { category: 'RETRYABLE' })
    eventBus.emit('recovery.error.classified' as any, { category: 'FATAL' })
    const h = t.getHealth()
    expect(h.errorBreakdown['RETRYABLE']).toBe(2)
    expect(h.errorBreakdown['FATAL']).toBe(1)
    t.stop()
  })

  it('多样性惩罚降低 score', () => {
    const t = new ModelHealthTracker()
    t.start()
    for (let i = 0; i < 10; i++) {
      eventBus.emit('agent.tool.completed' as any, { tool: 't', result: 'ok' })
    }
    eventBus.emit('recovery.error.classified' as any, { category: 'A' })
    eventBus.emit('recovery.error.classified' as any, { category: 'B' })
    eventBus.emit('recovery.error.classified' as any, { category: 'C' })
    // score = 100 * (1 - min(1, 3 * 0.15)) = 100 * 0.55 = 55
    const h = t.getHealth()
    expect(h.score).toBe(55)
    t.stop()
  })

  it('double start guard → 只订阅一次', () => {
    const t = new ModelHealthTracker()
    t.start()
    t.start()
    eventBus.emit('agent.tool.completed' as any, { tool: 't', result: 'ok' })
    const h = t.getHealth()
    expect(h.successCount).toBe(1)
    t.stop()
  })

  it('stop 后不再接收事件', () => {
    const t = new ModelHealthTracker()
    t.start()
    eventBus.emit('agent.tool.completed' as any, { tool: 't', result: 'ok' })
    t.stop()
    eventBus.emit('agent.tool.completed' as any, { tool: 't', result: 'ok' })
    const h = t.getHealth()
    expect(h.successCount).toBe(1)
  })

  it('getDiagnostics 返回内部状态', () => {
    const t = new ModelHealthTracker()
    t.start()
    eventBus.emit('agent.tool.completed' as any, { tool: 't', result: 'ok' })
    const d = t.getDiagnostics()
    expect(d.successCount).toBe(1)
    expect(typeof d.errorCounts).toBe('object')
    t.stop()
  })
})
