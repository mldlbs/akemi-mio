import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eventBus } from '../../core/EventBus'
import { initDatabase, closeDatabase } from '../../db/connection'
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'

vi.mock('../../logger/Logger', () => ({ log: vi.fn() }))

import { EventAuditor } from '../EventAuditor'

describe('EventAuditor 压力测试', () => {
  let auditor: EventAuditor
  let bus: typeof eventBus

  beforeEach(async () => {
    const dbPath = join(process.cwd(), 'akemi-mio.db')
    if (existsSync(dbPath)) unlinkSync(dbPath)
    process.env.USER_DATA_DIR = process.cwd()
    await initDatabase()
    eventBus.removeAll()
    bus = eventBus
    auditor = new EventAuditor(undefined, bus)
    auditor.start()
  })

  afterEach(() => {
    auditor.stop()
    closeDatabase()
    const dbPath = join(process.cwd(), 'akemi-mio.db')
    if (existsSync(dbPath)) unlinkSync(dbPath)
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
