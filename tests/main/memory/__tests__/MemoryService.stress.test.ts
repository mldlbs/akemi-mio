import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDatabase, closeDatabase } from '@akemi-mio/core/db/connection'
import { useIsolatedTestDatabase } from '../../db/__tests__/testDatabase'

vi.mock('@akemi-mio/core/logger/Logger', () => ({ log: vi.fn() }))

import { MemoryService } from '@akemi-mio/intelligence-memory/MemoryService'

describe('MemoryService 压力测试', () => {
  let ms: MemoryService
  let restoreTestDatabase: () => void

  beforeEach(async () => {
    restoreTestDatabase = useIsolatedTestDatabase()
    await initDatabase()
    ms = new MemoryService()
  })

  afterEach(() => {
    ms.shutdown()
    closeDatabase()
    restoreTestDatabase()
  })

  it('5000 次 addEntry + addFact 不崩溃', () => {
    for (let i = 0; i < 5000; i++) {
      ms.addEntry('user_fact', `测试数据 ${i}`, 0.6 + (i % 5) * 0.08)
      if (i % 10 === 0) ms.addFact(`重要事实 ${i}`, 0.9)
    }
    const entries = ms.getEntries()
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.length).toBeLessThanOrEqual(100)
  }, 30_000)

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
    // ⚠️ 这个文件里**每个**用例都必须显式给超时。
    //
    // vitest 默认 testTimeout 是 5000ms，而这里的压力用例实测就在 3–24s 之间
    // （1000 次 getFormattedContext ≈ 3.0s、读写混合 500 轮 ≈ 7.5s、
    // 交替不下沉 ≈ 5.6s、1 万条 entry ≈ 24s）。用例是**同步**的，定时器没法
    // 在它执行中途打断，只能在返回后补判 —— 于是「过不过」取决于机器负载，
    // 同一份代码可能这次绿下次红（09-22 实测：同一台机器，一次 3009 全过，
    // 一次这条 7455ms 判超时）。**flaky 的门禁不是门禁。**
    //
    // 文件里另两个用例本来就写了 30_000 / 60_000，中间三个漏了。
  }, 30_000)

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
  }, 30_000)

  it('getFormattedContext + recordInteraction 交替不下沉', () => {
    for (let i = 0; i < 1000; i++) {
      ms.setLastUserText(`用户消息 ${i}`)
      ms.recordInteraction()
      const ctx = ms.getFormattedContext()
      expect(typeof ctx).toBe('string')
    }
    expect(ms.getInteractionCount()).toBe(1000)
  }, 30_000)

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
    // 内存稳定性仅作粗略上界：10k 次 addEntry 的堆增量受 GC 时机影响，实测约 50-60MB
    expect(memDelta).toBeLessThan(128 * 1024 * 1024)
  }, 60_000)
})
