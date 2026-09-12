import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ObservabilityLogger } from '@akemi-mio/intelligence/observability/ObservabilityLogger'

vi.mock('@akemi-mio/core/logger/Logger', () => ({
  log: vi.fn(),
}))

describe('ObservabilityLogger', () => {
  let spy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env.AKEMI_MIO_OBSERVABILITY = '1'
    spy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    delete process.env.AKEMI_MIO_OBSERVABILITY
    spy?.mockRestore()
    vi.restoreAllMocks()
  })

  function getObsOutput(log: ObservabilityLogger): string {
    // Find the console.log call that contains the request separator
    return spy.mock.calls.find((args) => String(args[0]).startsWith('━'))?.[0] || ''
  }

  it('should not log when disabled', () => {
    delete process.env.AKEMI_MIO_OBSERVABILITY
    const log = new ObservabilityLogger('test-1')
    expect(log.enabled).toBe(false)
    log.logInput('x', 'test')
    log.flush()
    expect(getObsOutput(log)).toBe('')
  })

  it('should log input', () => {
    const log = new ObservabilityLogger('req-001')
    log.logInput('你好', 'telegram')
    log.flush()
    const out = getObsOutput(log)
    expect(out).toContain('INPUT:')
    expect(out).toContain('你好')
  })

  it('should log memory context breakdown', () => {
    const log = new ObservabilityLogger('req-002')
    log.logMemory('查询内容', '【重要的记忆】 content')
    log.flush()
    const out = getObsOutput(log)
    expect(out).toContain('MEMORY:')
    expect(out).toContain('permanent:true')
  })

  it('should log tool batch', () => {
    const log = new ObservabilityLogger('req-003')
    log.logToolBatch([
      { id: '1', name: 'search', success: true, content: 'ok', latencyMs: 1500 },
      { id: '2', name: 'read', success: false, content: '', error: 'ENOENT', latencyMs: 5 },
    ])
    log.flush()
    const out = getObsOutput(log)
    expect(out).toContain('search → success')
    expect(out).toContain('read → fail')
    expect(out).toContain('ENOENT')
  })

  it('should log prompt with all roles', () => {
    const log = new ObservabilityLogger('req-004')
    log.logPrompt([
      { role: 'system', content: 'You are an AI' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!', tool_calls: [{ id: 'c1', name: 'search', arguments: '{}' }] },
    ])
    log.flush()
    const out = getObsOutput(log)
    expect(out).toContain('[system   ]')
    expect(out).toContain('[user     ]')
    expect(out).toContain('[tool_calls: search]')
  })

  it('should log output', () => {
    const log = new ObservabilityLogger('req-005')
    log.logOutput('回复内容', 5678)
    log.flush()
    const out = getObsOutput(log)
    expect(out).toContain('OUTPUT:')
    expect(out).toContain('回复内容')
    expect(out).toContain('5678ms')
  })

  it('should produce the full 5-block layout', () => {
    const log = new ObservabilityLogger('req-full')
    log.logInput('test', 'electron')
    log.logMemory('test', '【重要的记忆】xyz 相关的历史记忆 abc')
    log.logPrompt([{ role: 'system', content: 'sys' }])
    log.logToolBatch([{ id: '1', name: 'tool_a', success: true, content: 'ok', latencyMs: 100 }])
    log.logOutput('reply', 999)
    log.flush()
    const out = getObsOutput(log)
    expect(out).toContain('Request req-full')
    expect(out).toContain('INPUT:\ntest')
    expect(out).toContain('MEMORY:\nquery:')
    expect(out).toContain('PROMPT:\n')
    expect(out).toContain('TOOL:\n')
    expect(out).toContain('OUTPUT:\nreply (999ms)')
  })

  it('should clear entries after flush', () => {
    const log = new ObservabilityLogger('req-clear')
    log.logInput('x', 'test')
    log.flush()
    expect(getObsOutput(log)).toContain('INPUT:')
    const callCount = spy.mock.calls.length
    // second flush with no new entries should not create a new observability output
    log.flush()
    expect(spy.mock.calls.length).toBe(callCount)
  })
})
