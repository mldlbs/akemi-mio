import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventBus, eventBus } from '@akemi-mio/core/core/EventBus'
import { initDatabase, closeDatabase } from '@akemi-mio/core/db/connection'
import { useIsolatedTestDatabase } from '../../db/__tests__/testDatabase'

vi.mock('@akemi-mio/core/logger/Logger', () => ({ log: vi.fn() }))

// Must import after mocks
import { EventAuditor } from '@akemi-mio/audit/EventAuditor'

describe('EventAuditor', () => {
  let auditor: EventAuditor
  let bus: EventBus
  let restoreTestDatabase: () => void

  beforeEach(async () => {
    restoreTestDatabase = useIsolatedTestDatabase()
    await initDatabase()
    eventBus.removeAll()
    bus = eventBus
    auditor = new EventAuditor(undefined, bus)
  })

  afterEach(() => {
    auditor.stop()
    closeDatabase()
    restoreTestDatabase()
  })

  it('start 后订阅 6 个事件', () => {
    expect(bus.listenerCount('agent.tool.invoked')).toBe(0)
    auditor.start()
    expect(bus.listenerCount('agent.tool.invoked')).toBe(1)
    expect(bus.listenerCount('agent.tool.completed')).toBe(1)
    expect(bus.listenerCount('agent.tool.failed')).toBe(1)
    expect(bus.listenerCount('agent.error')).toBe(1)
    expect(bus.listenerCount('agent.input.received')).toBe(1)
    expect(bus.listenerCount('agent.response.generated')).toBe(1)
  })

  it('重复 start 不重复订阅', () => {
    auditor.start()
    auditor.start()
    expect(bus.listenerCount('agent.tool.invoked')).toBe(1)
  })

  it('stop 取消全部订阅', () => {
    auditor.start()
    auditor.stop()
    expect(bus.listenerCount('agent.tool.invoked')).toBe(0)
    expect(bus.listenerCount('agent.error')).toBe(0)
  })

  it('tool.invoked 推送到缓冲区', () => {
    auditor.start()
    bus.emit('agent.tool.invoked', { requestId: 'r1', tool: 'read_file', args: { path: '/test' } })
    expect(auditor['buffer'].length).toBe(1)
    expect(auditor['buffer'][0].eventType).toBe('tool_invoked')
  })

  it('tool.completed 计算 durationMs', () => {
    auditor.start()
    bus.emit('agent.tool.invoked', { requestId: 'r1', tool: 'write_file', args: { path: '/test' } })
    bus.emit('agent.tool.completed', { requestId: 'r1', tool: 'write_file', result: 'ok' })
    const record = auditor['buffer'].find((r) => r.eventType === 'tool_completed')
    expect(record).toBeDefined()
    expect(record!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('tool.completed 无对应 invoked 时 durationMs 为 undefined', () => {
    auditor.start()
    bus.emit('agent.tool.completed', { requestId: 'r2', tool: 'write_file', result: 'ok' })
    const record = auditor['buffer'].find((r) => r.eventType === 'tool_completed')
    expect(record!.durationMs).toBeUndefined()
  })

  it('tool.failed 存储错误详情', () => {
    auditor.start()
    bus.emit('agent.tool.failed', { requestId: 'r3', tool: 'write_file', error: 'permission denied' })
    const detail = JSON.parse(auditor['buffer'][0].detail)
    expect(detail.error).toContain('permission denied')
  })

  it('error 事件存储错误和 requestId', () => {
    auditor.start()
    bus.emit('agent.error', { requestId: 'r4', error: 'timeout', step: 1 })
    const detail = JSON.parse(auditor['buffer'][0].detail)
    expect(detail.error).toContain('timeout')
    expect(detail.requestId).toBe('r4')
  })

  it('input.received 存储截断文本', () => {
    auditor.start()
    const longText = 'x'.repeat(500)
    bus.emit('agent.input.received', { requestId: 'r5', text: longText })
    const detail = JSON.parse(auditor['buffer'][0].detail)
    expect(detail.text.length).toBe(200)
  })

  it('response.generated 存储截断文本', () => {
    auditor.start()
    bus.emit('agent.response.generated', { requestId: 'r6', text: 'hello world', durationMs: 100 })
    const detail = JSON.parse(auditor['buffer'][0].detail)
    expect(detail.text).toContain('hello world')
  })

  it('flush 写入 DB 并清空缓冲区', () => {
    auditor.start()
    bus.emit('agent.tool.invoked', { requestId: 'r7', tool: 'read_file', args: {} })
    auditor.flush()
    expect(auditor['buffer'].length).toBe(0)
    const results = auditor.query()
    expect(results.length).toBeGreaterThanOrEqual(1)
  })

  it('query 按 event_type 过滤', () => {
    auditor.start()
    bus.emit('agent.tool.invoked', { requestId: 'r8', tool: 'read_file', args: {} })
    bus.emit('agent.error', { requestId: 'r9', error: 'fail', step: 3 })
    auditor.flush()

    const errors = auditor.query({ eventTypes: ['error'] })
    expect(errors.every((r) => r.eventType === 'error')).toBe(true)
  })

  it('query 按时间范围过滤', () => {
    auditor.start()
    bus.emit('agent.tool.invoked', { requestId: 'r10', tool: 'read_file', args: {} })
    auditor.flush()

    const now = Date.now()
    const results = auditor.query({ since: now - 1000, until: now + 1000 })
    expect(results.length).toBeGreaterThanOrEqual(1)

    const old = auditor.query({ since: now + 10000 })
    expect(old.length).toBe(0)
  })

  it('query 空库不抛异常', () => {
    const results = auditor.query()
    expect(results).toEqual([])
  })

  it('getStats 返回正确统计', () => {
    auditor.start()
    bus.emit('agent.tool.invoked', { requestId: 'r11', tool: 'read_file', args: {} })
    bus.emit('agent.error', { requestId: 'r12', error: 'fail', step: 3 })
    auditor.flush()

    const stats = auditor.getStats()
    expect(stats.total).toBeGreaterThanOrEqual(2)
    expect(stats.byType['tool_invoked']).toBeGreaterThanOrEqual(1)
    expect(stats.byType['error']).toBeGreaterThanOrEqual(1)
  })

  it('缓冲区超 maxBufferSize 时自动 flush', () => {
    const small = new EventAuditor({ maxBufferSize: 5 }, bus)
    small.start()
    for (let i = 0; i < 10; i++) {
      bus.emit('agent.tool.invoked', { requestId: `r${i}`, tool: 'read_file', args: {} })
    }
    // 第 6 条触发 auto-flush，缓冲区应 <= 5
    expect(small['buffer'].length).toBeLessThanOrEqual(5)
    small.stop()

    // 验证已写入 DB
    const results = small.query()
    expect(results.length).toBeGreaterThanOrEqual(10)
  })

  it('start 后调用 enforceRetention 不抛异常', () => {
    auditor.start()
    expect(() => auditor.enforceRetention()).not.toThrow()
  })

  it('stop 后不应再写入', () => {
    auditor.start()
    auditor.flush()
    auditor.stop()

    bus.emit('agent.tool.invoked', { requestId: 'r99', tool: 'read_file', args: {} })
    expect(auditor['buffer'].length).toBe(0)
  })

  it('配置自定义 retentionHours', () => {
    const custom = new EventAuditor({ retentionHours: 48 }, bus)
    custom.start()
    expect(custom.retentionHours).toBe(48)
    custom.stop()
  })
})
