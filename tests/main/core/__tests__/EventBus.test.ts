import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventBus, SubscriptionTracker, eventBus } from '@akemi-mio/core/core/EventBus'

function resetBus() {
  eventBus.removeAll()
}

describe('EventBus', () => {
  beforeEach(() => {
    resetBus()
  })

  it('getInstance 返回同一实例', () => {
    expect(EventBus.getInstance()).toBe(EventBus.getInstance())
  })

  it('eventBus 导出指向同一实例', () => {
    expect(eventBus).toBe(EventBus.getInstance())
  })

  it('on + emit 收到对应 payload', () => {
    const fn = vi.fn()
    eventBus.on('agent.input.received', fn)
    eventBus.emit('agent.input.received', { text: '你好', requestId: 'r1', source: 'electron' })
    expect(fn).toHaveBeenCalledOnce()
    expect(fn).toHaveBeenCalledWith({ text: '你好', requestId: 'r1', source: 'electron' })
  })

  it('disposer 移除监听', () => {
    const fn = vi.fn()
    const dispose = eventBus.on('scheduler.tick', fn)
    dispose()
    eventBus.emit('scheduler.tick', { taskId: 't1', cron: '*' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('多次 emit 多次触发', () => {
    const fn = vi.fn()
    eventBus.on('scheduler.tick', fn)
    eventBus.emit('scheduler.tick', { taskId: 't1', cron: '*' })
    eventBus.emit('scheduler.tick', { taskId: 't2', cron: '*' })
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('once 只触发一次', () => {
    const fn = vi.fn()
    eventBus.once('agent.observe', fn)
    eventBus.emit('agent.observe', { requestId: 'r1', step: 1, proceduresFound: 0, patternsFound: 0, durationMs: 10 })
    eventBus.emit('agent.observe', { requestId: 'r2', step: 2, proceduresFound: 0, patternsFound: 0, durationMs: 10 })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('priority 顺序 high → normal → low', () => {
    const order: string[] = []
    eventBus.on('scheduler.tick', () => order.push('high'), { label: 'h', priority: 'high' })
    eventBus.on('scheduler.tick', () => order.push('normal'), { label: 'n', priority: 'normal' })
    eventBus.on('scheduler.tick', () => order.push('low'), { label: 'l', priority: 'low' })
    eventBus.emit('scheduler.tick', { taskId: 't1', cron: '*' })
    expect(order).toEqual(['high', 'normal', 'low'])
  })

  it('filter 按 source 过滤', () => {
    const fn = vi.fn()
    eventBus.on('agent.input.received', fn, { filter: { sources: ['telegram'] } })
    // 不传 source 的 emit 不触发 (meta undefined → filter 不生效，所以这里需要给 source)
    eventBus.emit('agent.input.received', { text: 'a', requestId: 'r1', source: 'electron' }, { source: 'electron' })
    expect(fn).not.toHaveBeenCalled()
    eventBus.emit('agent.input.received', { text: 'b', requestId: 'r2', source: 'telegram' }, { source: 'telegram' })
    expect(fn).toHaveBeenCalledOnce()
  })

  it('track 将 disposer 注册到 SubscriptionTracker', () => {
    const fn = vi.fn()
    const tracker = new SubscriptionTracker()
    eventBus.track('scheduler.tick', fn, tracker)
    tracker.dispose()
    eventBus.emit('scheduler.tick', { taskId: 't1', cron: '*' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('removeAll 清空指定事件', () => {
    const fn = vi.fn()
    eventBus.on('scheduler.tick', fn)
    eventBus.removeAll('scheduler.tick')
    eventBus.emit('scheduler.tick', { taskId: 't1', cron: '*' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('removeAll 无参清空所有', () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    eventBus.on('scheduler.tick', fn1)
    eventBus.on('agent.error', fn2)
    eventBus.removeAll()
    eventBus.emit('scheduler.tick', { taskId: 't1', cron: '*' })
    eventBus.emit('agent.error', { error: 'e', requestId: 'r1' })
    expect(fn1).not.toHaveBeenCalled()
    expect(fn2).not.toHaveBeenCalled()
  })

  it('listenerCount 返回正确', () => {
    eventBus.on('scheduler.tick', () => {}, 'a')
    eventBus.on('scheduler.tick', () => {}, 'b')
    expect(eventBus.listenerCount('scheduler.tick')).toBe(2)
  })

  it('getStats 返回事件统计', () => {
    eventBus.on('scheduler.tick', () => {}, { label: 'ticker', priority: 'high' })
    eventBus.on('scheduler.tick', () => {}, { label: 'normal-ticker', priority: 'normal' })
    const stats = eventBus.getStats()
    expect(stats['scheduler.tick'].count).toBe(2)
    expect(stats['scheduler.tick'].labels).toContain('ticker')
    expect(stats['scheduler.tick'].priorityBuckets['high']).toBe(1)
  })

  it('handler 抛异常不影响后续 handler', () => {
    const fn1 = vi.fn(() => {
      throw new Error('bad')
    })
    const fn2 = vi.fn()
    eventBus.on('scheduler.tick', fn1)
    eventBus.on('scheduler.tick', fn2)
    expect(() => eventBus.emit('scheduler.tick', { taskId: 't1', cron: '*' })).not.toThrow()
    expect(fn2).toHaveBeenCalled()
  })

  it('enablePersistence 后 emit 写入 store', () => {
    const store = { append: vi.fn().mockResolvedValue(undefined), query: vi.fn(), prune: vi.fn() }
    eventBus.enablePersistence(store)
    eventBus.emit('scheduler.tick', { taskId: 't1', cron: '*' }, { source: 'test', traceId: 'trace-1' })
    expect(store.append).toHaveBeenCalledWith(expect.objectContaining({ channel: 'scheduler.tick', source: 'test', traceId: 'trace-1' }))
  })

  it('store.append 抛异常不传播', () => {
    const store = { append: vi.fn().mockRejectedValue(new Error('db down')), query: vi.fn(), prune: vi.fn() }
    eventBus.enablePersistence(store)
    expect(() => eventBus.emit('scheduler.tick', { taskId: 't1', cron: '*' })).not.toThrow()
  })
})

describe('SubscriptionTracker', () => {
  it('初始 count 为 0', () => {
    expect(new SubscriptionTracker().count).toBe(0)
  })

  it('add 后 dispose 清空', () => {
    const t = new SubscriptionTracker()
    t.add(() => {})
    t.add(() => {})
    t.dispose()
    expect(t.count).toBe(0)
  })

  it('dispose 中单个函数抛异常不影响其他', () => {
    const t = new SubscriptionTracker()
    const fn1 = vi.fn(() => {
      throw new Error('oops')
    })
    const fn2 = vi.fn()
    t.add(fn1)
    t.add(fn2)
    expect(() => t.dispose()).not.toThrow()
    expect(fn1).toHaveBeenCalled()
    expect(fn2).toHaveBeenCalled()
  })
})
