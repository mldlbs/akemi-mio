import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDatabase, closeDatabase } from '@akemi-mio/core/db/connection'
import { useIsolatedTestDatabase } from '../db/__tests__/testDatabase'

vi.mock('@akemi-mio/core/logger/Logger', () => ({ log: vi.fn() }))

import { MemoryService } from '@akemi-mio/intelligence/memory/MemoryService'
import { DecisionStore } from '@akemi-mio/intelligence/memory/DecisionStore'
import { SummaryMemory } from '@akemi-mio/intelligence/memory/SummaryMemory'
import { EventBus, eventBus as defaultBus } from '@akemi-mio/core/core/EventBus'

describe('资源消耗基线', () => {
  let bus: EventBus
  let restoreTestDatabase: () => void

  beforeEach(async () => {
    restoreTestDatabase = useIsolatedTestDatabase()
    await initDatabase()
    bus = defaultBus
    bus.removeAll()
  })

  afterEach(() => {
    bus.removeAll()
    closeDatabase()
    restoreTestDatabase()
  })

  it('空载内存基线', () => {
    const mem = process.memoryUsage()
    console.log(`Idle baseline: RSS=${(mem.rss / 1024 / 1024).toFixed(1)}MB, heapUsed=${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB`)
    expect(mem.rss).toBeGreaterThan(0)
  })

  it('加载 500 条后内存增量', () => {
    const before = process.memoryUsage()
    const ms = new MemoryService()
    const decisionStore = new DecisionStore()
    const summary = new SummaryMemory()

    for (let i = 0; i < 500; i++) {
      ms.addEntry('user_fact', `基线数据 ${i} 用于资源消耗测量`, 0.7)
      decisionStore.record({ agentId: 'baseline', category: 'tool_select', context: `测试 ${i}`, choice: 'read' })
    }
    for (let i = 0; i < 50; i++) {
      summary.addSummary(`对话摘要 ${i}`, i * 100, (i + 1) * 100, { topics: [], decisions: [], keyEntities: [] })
    }

    const after = process.memoryUsage()
    const deltaMB = (after.heapUsed - before.heapUsed) / 1024 / 1024
    console.log(`After 500 entries + 50 summaries: heapUsed delta=${deltaMB.toFixed(2)}MB`)
    expect(deltaMB).toBeLessThan(50)
  })

  it('1000 次 EventBus emit 后无内存残留', () => {
    const disposers: (() => void)[] = []
    for (let i = 0; i < 10; i++) {
      disposers.push(bus.on('agent.tool.invoked', () => {}))
      disposers.push(bus.on('agent.error', () => {}))
    }

    const before = process.memoryUsage()
    for (let i = 0; i < 1000; i++) {
      bus.emit('agent.tool.invoked', { requestId: `mem_${i}`, tool: 'test', args: {} })
    }
    const after = process.memoryUsage()
    const deltaMB = (after.heapUsed - before.heapUsed) / 1024 / 1024
    console.log(`After 1000 emits: heapUsed delta=${deltaMB.toFixed(2)}MB`)

    disposers.forEach((d) => d())
    expect(deltaMB).toBeLessThan(10)
  })
})
