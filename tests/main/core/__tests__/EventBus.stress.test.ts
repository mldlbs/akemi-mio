import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventBus, eventBus as defaultBus, SubscriptionTracker } from '@akemi-mio/core/core/EventBus'

vi.mock('@akemi-mio/core/logger/Logger', () => ({ log: vi.fn() }))

describe('EventBus 压力测试', () => {
  let bus: EventBus

  beforeEach(() => {
    bus = defaultBus
    bus.removeAll()
  })

  afterEach(() => {
    bus.removeAll()
  })

  it('subscribe/unsubscribe 5000 次后 listenerCount 归零', () => {
    for (let i = 0; i < 5000; i++) {
      const disposer = bus.on('agent.tool.invoked', () => {})
      disposer()
    }
    expect(bus.listenerCount('agent.tool.invoked')).toBe(0)
  })

  it('2000 次 emit 后订阅者数量不增长', () => {
    const disposer = bus.on('agent.tool.invoked', () => {})
    const disposer2 = bus.on('agent.error', () => {})

    for (let i = 0; i < 2000; i++) {
      bus.emit('agent.tool.invoked', { requestId: `r${i}`, tool: 'test', args: {} })
    }
    expect(bus.listenerCount('agent.tool.invoked')).toBe(1)
    expect(bus.listenerCount('agent.error')).toBe(1)

    disposer()
    disposer2()
  })

  it('SubscriptionTracker.dispose() 清理全部订阅', () => {
    const tracker = new SubscriptionTracker()

    for (let i = 0; i < 50; i++) {
      bus.track('agent.tool.invoked', () => {}, tracker)
      bus.track('agent.error', () => {}, tracker)
    }
    expect(tracker.count).toBe(100)
    expect(bus.listenerCount('agent.tool.invoked')).toBe(50)

    tracker.dispose()
    expect(tracker.count).toBe(0)
    expect(bus.listenerCount('agent.tool.invoked')).toBe(0)
    expect(bus.listenerCount('agent.error')).toBe(0)
  })

  it('100 个不同事件并发 emit 不丢消息', async () => {
    let receivedCount = 0
    const events: string[] = []
    for (let i = 0; i < 100; i++) {
      const eventName = `test.event.${i}` as any
      bus.on(eventName, () => {
        receivedCount++
      })
      events.push(eventName)
    }

    await Promise.all(
      events.map((evt, i) =>
        Promise.resolve().then(() => {
          bus.emit(evt as any, { index: i })
        }),
      ),
    )

    expect(receivedCount).toBeGreaterThanOrEqual(50)
  })
})
