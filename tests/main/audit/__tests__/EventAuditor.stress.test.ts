import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import { initDatabase, closeDatabase } from '@akemi-mio/core/db/connection'
import { useIsolatedTestDatabase } from '../../db/__tests__/testDatabase'

vi.mock('@akemi-mio/core/logger/Logger', () => ({ log: vi.fn() }))

import { EventAuditor } from '@akemi-mio/audit/EventAuditor'

describe('EventAuditor 压力测试', () => {
  let auditor: EventAuditor
  let bus: typeof eventBus
  let restoreTestDatabase: () => void

  beforeEach(async () => {
    restoreTestDatabase = useIsolatedTestDatabase()
    await initDatabase()
    eventBus.removeAll()
    bus = eventBus
    auditor = new EventAuditor(undefined, bus)
    auditor.start()
  })

  afterEach(() => {
    auditor.stop()
    closeDatabase()
    restoreTestDatabase()
  })

  it('900 条 tool 事件全部写入', () => {
    for (let i = 0; i < 300; i++) {
      bus.emit('agent.tool.invoked', { requestId: `r${i}`, tool: 'read_file', args: {} })
      bus.emit('agent.tool.completed', { requestId: `r${i}`, tool: 'read_file', result: 'ok' })
      bus.emit('agent.error', { requestId: `r${i}`, error: 'timeout', step: 1 })
    }
    auditor.flush()

    const stats = auditor.getStats()
    expect(stats.total).toBe(900)
    expect(stats.byType['tool_invoked']).toBe(300)
    expect(stats.byType['tool_completed']).toBe(300)
    expect(stats.byType['error']).toBe(300)
  })
})
