import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { initDatabase, closeDatabase } from '../db/connection'

vi.mock('../../logger/Logger', () => ({ log: vi.fn() }))

import { MemoryService } from '../memory/MemoryService'
import { EventBus, eventBus as defaultBus, SubscriptionTracker } from '../core/EventBus'
import { MetricsCollector } from '../observability/MetricsCollector'

describe('启动时间基准', () => {
  let bus: EventBus

  beforeEach(async () => {
    const dbPath = join(process.cwd(), 'akemi-mio.db')
    if (existsSync(dbPath)) unlinkSync(dbPath)
    process.env.USER_DATA_DIR = process.cwd()
    await initDatabase()
    bus = defaultBus
    bus.removeAll()
  })

  afterEach(() => {
    bus.removeAll()
    closeDatabase()
    const dbPath = join(process.cwd(), 'akemi-mio.db')
    if (existsSync(dbPath)) unlinkSync(dbPath)
  })

  it('MemoryService 初始化 + 1000 条加载时间', () => {
    const preload = new MemoryService()
    for (let i = 0; i < 1000; i++) {
      preload.addEntry('user_fact', `预置数据 ${i}`, 0.7)
    }
    preload.shutdown()

    const t0 = performance.now()
    const ms = new MemoryService()
    const elapsed = performance.now() - t0
    console.log(`MemoryService init (1000 pre-loaded): ${elapsed.toFixed(2)}ms`)
    expect(ms.getEntries().length).toBeGreaterThan(0)
    ms.shutdown()
  })

  it('EventBus + 50 订阅初始化时间', () => {
    const tracker = new SubscriptionTracker()
    const t0 = performance.now()

    for (let i = 0; i < 50; i++) {
      const event = i % 2 === 0 ? 'agent.tool.invoked' : 'agent.error'
      bus.track(event as any, () => {}, tracker)
    }

    const elapsed = performance.now() - t0
    console.log(`EventBus 50 subscriptions: ${elapsed.toFixed(2)}ms`)
    expect(tracker.count).toBe(50)
    tracker.dispose()
  })

  it('MetricsCollector 初始化时间', () => {
    const t0 = performance.now()
    const mc = new MetricsCollector()
    const elapsed = performance.now() - t0
    console.log(`MetricsCollector init: ${elapsed.toFixed(2)}ms`)
    expect(mc).toBeDefined()
  })
})
