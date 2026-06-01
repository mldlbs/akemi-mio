import { describe, it, expect, vi, beforeEach } from 'vitest'
import { log, setRequestId, getRequestId, createRequestId } from '../logger/Logger'

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('logger', () => {
  it('log() produces valid JSON output', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log('INFO', 'test_event', { foo: 'bar' })
    const output = spy.mock.calls[0][0]
    const parsed = JSON.parse(output)
    expect(parsed).toBeDefined()
    expect(typeof parsed).toBe('object')
  })

  it('log() includes level, timestamp, event fields', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log('WARN', 'something_happened', { detail: 42 })
    const parsed = JSON.parse(spy.mock.calls[0][0])
    expect(parsed).toHaveProperty('level', 'WARN')
    expect(parsed).toHaveProperty('event', 'something_happened')
    expect(parsed).toHaveProperty('timestamp')
    expect(parsed).toHaveProperty('detail', 42)
  })

  it('setRequestId() and getRequestId() work correctly', () => {
    setRequestId('test-req-123')
    expect(getRequestId()).toBe('test-req-123')
  })

  it('getRequestId() auto-generates if not set', () => {
    setRequestId('')
    const id = getRequestId()
    expect(id).toMatch(/^req_\d+_\d+$/)
  })

  it('supports multiple log levels', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const levels = ['INFO', 'WARN', 'ERROR', 'PERF', 'CHAT'] as const
    for (const level of levels) {
      log(level, 'test')
      const parsed = JSON.parse(spy.mock.calls[levels.indexOf(level)][0])
      expect(parsed.level).toBe(level)
    }
    expect(spy).toHaveBeenCalledTimes(5)
  })
})
