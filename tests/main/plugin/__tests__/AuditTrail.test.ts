import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDatabase, closeDatabase } from '@akemi-mio/core/db/connection'
import { useIsolatedTestDatabase } from '../../db/__tests__/testDatabase'

vi.mock('@akemi-mio/core/logger/Logger', () => ({ log: vi.fn() }))

import { AuditTrail } from '@akemi-mio/intelligence/plugin/AuditTrail'

describe('AuditTrail', () => {
  let audit: AuditTrail
  let restoreTestDatabase: () => void

  beforeEach(async () => {
    restoreTestDatabase = useIsolatedTestDatabase()
    await initDatabase()
    audit = new AuditTrail()
  })

  afterEach(() => {
    closeDatabase()
    restoreTestDatabase()
  })

  it('record 写入 audit_trail 表', () => {
    audit.record({
      source: 'agent',
      action: 'tool_call',
      target: 'read_file',
      details: { path: '/test' },
      allowed: true,
    })
    const results = audit.query({ limit: 10 })
    expect(results.length).toBe(1)
    expect(results[0].source).toBe('agent')
    expect(results[0].action).toBe('tool_call')
  })

  it('record 写入多条记录', () => {
    audit.record({ source: 'agent', action: 'tool_call', target: 'read', details: {}, allowed: true })
    audit.record({ source: 'plugin', action: 'file_write', target: '/tmp/x', details: {}, allowed: true })
    expect(audit.getRecent(10)).toHaveLength(2)
  })

  it('query 按 source 过滤', () => {
    audit.record({ source: 'agent', action: 'tool_call', target: 'read', details: {}, allowed: true })
    audit.record({ source: 'user', action: 'command', target: 'ls', details: {}, allowed: true })

    const agent = audit.getBySource('agent')
    expect(agent).toHaveLength(1)
    expect(agent[0].source).toBe('agent')
  })

  it('query 按 action 过滤', () => {
    audit.record({ source: 'agent', action: 'tool_call', target: 'read', details: {}, allowed: true })
    audit.record({ source: 'agent', action: 'file_write', target: '/tmp/x', details: {}, allowed: true })

    const writes = audit.query({ action: 'file_write' })
    expect(writes).toHaveLength(1)
    expect(writes[0].action).toBe('file_write')
  })

  it('query 空库返回空数组', () => {
    expect(audit.getRecent(10)).toEqual([])
  })

  it('getStats 返回正确计数', () => {
    audit.record({ source: 'agent', action: 'tool_call', target: 'read', details: {}, allowed: true })
    audit.record({ source: 'plugin', action: 'file_write', target: '/tmp/x', details: {}, allowed: true })

    const stats = audit.getStats()
    expect(stats.total).toBe(2)
    expect(stats.bySource['agent']).toBe(1)
    expect(stats.bySource['plugin']).toBe(1)
    expect(stats.byAction['tool_call']).toBe(1)
    expect(stats.byAction['file_write']).toBe(1)
  })

  it('getBySource 返回指定 source 记录', () => {
    audit.record({ source: 'agent', action: 'tool_call', target: 'read', details: {}, allowed: true })
    audit.record({ source: 'evolution', action: 'tool_call', target: 'write', details: {}, allowed: true })
    audit.record({ source: 'system', action: 'plugin_load', target: 'test', details: {}, allowed: true })

    const evolution = audit.getBySource('evolution')
    expect(evolution).toHaveLength(1)
  })

  it('query 限制数量', () => {
    for (let i = 0; i < 20; i++) {
      audit.record({ source: 'agent', action: 'tool_call', target: `tool_${i}`, details: {}, allowed: true })
    }
    expect(audit.query({ limit: 5 })).toHaveLength(5)
    expect(audit.getRecent(3)).toHaveLength(3)
  })

  it('MAX_ENTRIES 裁剪不抛异常', () => {
    for (let i = 0; i < 50; i++) {
      audit.record({ source: 'agent', action: 'tool_call', target: `tool_${i}`, details: {}, allowed: false, reason: `err_${i}` })
    }
    const stats = audit.getStats()
    expect(stats.total).toBe(50)

    const last = audit.getRecent(1)[0]
    expect(last.allowed).toBe(false)
    expect(last.reason).toMatch(/err_\d+/)
  })
})
