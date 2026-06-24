import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDatabase, closeDatabase } from '../../db/connection'
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'

vi.mock('../../logger/Logger', () => ({ log: vi.fn() }))

import { MemoryService } from '../MemoryService'

describe('MemoryService 压力测试', () => {
  let ms: MemoryService

  beforeEach(async () => {
    const dbPath = join(process.cwd(), 'akemi-mio.db')
    if (existsSync(dbPath)) unlinkSync(dbPath)
    process.env.USER_DATA_DIR = process.cwd()
    await initDatabase()
    ms = new MemoryService()
  })

  afterEach(() => {
    ms.shutdown()
    closeDatabase()
    const dbPath = join(process.cwd(), 'akemi-mio.db')
    if (existsSync(dbPath)) unlinkSync(dbPath)
  })

  it('5000 次 addEntry + addFact 不崩溃', () => {
    for (let i = 0; i < 5000; i++) {
      ms.addEntry('user_fact', `测试数据 ${i}`, 0.6 + (i % 5) * 0.08)
      if (i % 10 === 0) ms.addFact(`重要事实 ${i}`, 0.9)
    }
    const entries = ms.getEntries()
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.length).toBeLessThanOrEqual(100)
  })

  it('1000 次 getFormattedContext 不崩溃', () => {
    for (let i = 0; i < 100; i++) {
      ms.addEntry('user_fact', `测试内容 ${i}`, 0.7)
    }
    const samples: number[] = []
    for (let i = 0; i < 1000; i++) {
      const t0 = performance.now()
      const ctx = ms.getFormattedContext()
      samples.push(performance.now() - t0)
      expect(typeof ctx).toBe('string')
    }
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length
    console.log(`getFormattedContext avg latency: ${avg.toFixed(3)}ms over 1000 calls`)

    const nonEmpty = samples.filter((_, i) => {
      ms.setLastUserText(`query ${i}`)
      return ms.getFormattedContext().length > 0
    })
    expect(nonEmpty.length).toBeGreaterThan(0)
  })

  it('读写混合 500 轮不崩溃', () => {
    for (let round = 0; round < 500; round++) {
      ms.addEntry('user_fact', `混合测试 ${round}`, 0.6)
      ms.addFact(`关键事实 ${round}`, 0.85)
      ms.recordInteraction()
      const ctx = ms.getFormattedContext()
      expect(typeof ctx).toBe('string')
      const queryCtx = ms.unifiedQuery.query(`测试 ${round}`)
      expect(queryCtx).toBeDefined()
    }
    const entries = ms.getEntries()
    expect(entries.length).toBeGreaterThan(0)
  })

  it('getFormattedContext + recordInteraction 交替不下沉', () => {
    for (let i = 0; i < 1000; i++) {
      ms.setLastUserText(`用户消息 ${i}`)
      ms.recordInteraction()
      const ctx = ms.getFormattedContext()
      expect(typeof ctx).toBe('string')
    }
    expect(ms.getInteractionCount()).toBe(1000)
  })

  it('1 万条 entry 后 prune 正确且内存稳定', () => {
    const memBefore = process.memoryUsage().heapUsed
    for (let i = 0; i < 10000; i++) {
      ms.addEntry('user_fact', `数据点 ${i} 用于填充内存系统`, 0.5 + (i % 5) * 0.1)
    }
    const memAfter = process.memoryUsage().heapUsed
    const entries = ms.getEntries()
    expect(entries.length).toBeLessThanOrEqual(100)
    const memDelta = memAfter - memBefore
    console.log(`Memory delta after 10k entries: ${(memDelta / 1024).toFixed(1)}KB`)
    expect(memDelta).toBeLessThan(50 * 1024 * 1024)
  })
})
