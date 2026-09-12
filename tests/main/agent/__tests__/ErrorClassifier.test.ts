import { describe, it, expect, vi } from 'vitest'
import { classify, computeBackoff, getUserMessage } from '@akemi-mio/intelligence/agent/ErrorClassifier'

vi.mock('@akemi-mio/core/logger/Logger', () => ({ log: vi.fn() }))

describe('ErrorClassifier', () => {
  // ======= classify =======

  it('空字符串 → FATAL', () => {
    const r = classify('')
    expect(r.category).toBe('FATAL')
    expect(r.strategy.shouldRetry).toBe(false)
  })

  it('null/undefined → FATAL', () => {
    const r = classify(undefined as any)
    expect(r.category).toBe('FATAL')
  })

  it('timeout → RETRYABLE', () => {
    const r = classify('request timeout after 30s')
    expect(r.category).toBe('RETRYABLE')
    expect(r.strategy.shouldRetry).toBe(true)
  })

  it('ETIMEDOUT → RETRYABLE', () => {
    const r = classify('etimedout')
    expect(r.category).toBe('RETRYABLE')
  })

  it('429 → RETRYABLE', () => {
    const r = classify('429 Too Many Requests')
    expect(r.category).toBe('RETRYABLE')
  })

  it('500 → RETRYABLE', () => {
    const r = classify('500 Internal Server Error')
    expect(r.category).toBe('RETRYABLE')
  })

  it('502 → RETRYABLE', () => {
    const r = classify('502 Bad Gateway')
    expect(r.category).toBe('RETRYABLE')
  })

  it('socket hangup → RETRYABLE', () => {
    const r = classify('socket hang up')
    expect(r.category).toBe('RETRYABLE')
  })

  it('rate limited → RETRYABLE', () => {
    const r = classify('rate limit exceeded')
    expect(r.category).toBe('RETRYABLE')
  })

  it('fetch failed → RETRYABLE', () => {
    const r = classify('fetch failed')
    expect(r.category).toBe('RETRYABLE')
  })

  it('insufficient tool messages → CORRUPTED_STATE', () => {
    const r = classify('insufficient tool messages')
    expect(r.category).toBe('CORRUPTED_STATE')
    expect(r.strategy.contextAction).toBe('clear')
  })

  it('orphan tool_call → CORRUPTED_STATE', () => {
    const r = classify('orphan tool_call block detected')
    expect(r.category).toBe('CORRUPTED_STATE')
  })

  it('tool_calls must be followed → CORRUPTED_STATE', () => {
    const r = classify('tool_calls must be followed by tool messages')
    expect(r.category).toBe('CORRUPTED_STATE')
  })

  it('tool not found → CAPABILITY_LOSS', () => {
    const r = classify('tool not found: write_file')
    expect(r.category).toBe('CAPABILITY_LOSS')
    expect(r.strategy.shouldRetry).toBe(false)
  })

  it('unknown tool → CAPABILITY_LOSS', () => {
    const r = classify('unknown tool')
    expect(r.category).toBe('CAPABILITY_LOSS')
  })

  it('MCP unavailable → CAPABILITY_LOSS', () => {
    const r = classify('MCP server unavailable')
    expect(r.category).toBe('CAPABILITY_LOSS')
  })

  it('no API key → CONFIGURATION_ERROR', () => {
    const r = classify('no api key configured')
    expect(r.category).toBe('CONFIGURATION_ERROR')
    expect(r.strategy.contextAction).toBe('reject')
  })

  it('401 → CONFIGURATION_ERROR', () => {
    const r = classify('401 Unauthorized')
    expect(r.category).toBe('CONFIGURATION_ERROR')
  })

  it('401k 排除 → 不匹配 CONFIGURATION_ERROR', () => {
    const r = classify('401k plan')
    expect(r.category).not.toBe('CONFIGURATION_ERROR')
  })

  it('context_length_exceeded → CONTEXT_OVERFLOW', () => {
    const r = classify('context_length_exceeded')
    expect(r.category).toBe('CONTEXT_OVERFLOW')
    expect(r.strategy.contextAction).toBe('compress')
  })

  it('prompt too long → CONTEXT_OVERFLOW', () => {
    const r = classify('prompt too long')
    expect(r.category).toBe('CONTEXT_OVERFLOW')
  })

  it('token limit → CONTEXT_OVERFLOW', () => {
    const r = classify('token limit exceeded')
    expect(r.category).toBe('CONTEXT_OVERFLOW')
  })

  it('bad request → INVALID_REQUEST', () => {
    const r = classify('bad request')
    expect(r.category).toBe('INVALID_REQUEST')
  })

  it('invalid request → INVALID_REQUEST', () => {
    const r = classify('invalid request')
    expect(r.category).toBe('INVALID_REQUEST')
  })

  it('missing required → INVALID_REQUEST', () => {
    const r = classify('missing required parameter')
    expect(r.category).toBe('INVALID_REQUEST')
  })

  it('tool call schema error → TOOL_SCHEMA_ERROR', () => {
    const r = classify('tool call schema validation failed')
    expect(r.category).toBe('TOOL_SCHEMA_ERROR')
    expect(r.strategy.shouldRetry).toBe(true)
  })

  it('validation error tool → TOOL_SCHEMA_ERROR', () => {
    const r = classify('validation error for tool')
    expect(r.category).toBe('TOOL_SCHEMA_ERROR')
  })

  it('OOM → FATAL', () => {
    const r = classify('out of memory')
    expect(r.category).toBe('FATAL')
  })

  it('segfault → FATAL', () => {
    const r = classify('segmentation fault')
    expect(r.category).toBe('FATAL')
  })

  it('bare 400 → CORRUPTED_STATE (fallback)', () => {
    const r = classify('400')
    expect(r.category).toBe('CORRUPTED_STATE')
  })

  it('400 error → CORRUPTED_STATE (fallback)', () => {
    const r = classify('400 error from API')
    expect(r.category).toBe('CORRUPTED_STATE')
  })

  it('API_ERROR:400 → INVALID_REQUEST（API_ERROR:4 匹配）', () => {
    const r = classify('API_ERROR:400')
    expect(r.category).toBe('INVALID_REQUEST')
  })

  it('400 context_length → CONTEXT_OVERFLOW (先匹配到 CONTEXT_OVERFLOW)', () => {
    const r = classify('400 context_length_exceeded')
    expect(r.category).toBe('CONTEXT_OVERFLOW')
  })

  it('未分类错误 → FATAL', () => {
    const r = classify('some random unexpected error')
    expect(r.category).toBe('FATAL')
  })

  // ======= computeBackoff =======

  it('computeBackoff 无 jitter 返回 base * 2^attempt', () => {
    expect(computeBackoff(2000, 0, false)).toBe(2000)
    expect(computeBackoff(2000, 1, false)).toBe(4000)
    expect(computeBackoff(2000, 2, false)).toBe(8000)
    expect(computeBackoff(1000, 3, false)).toBe(8000)
  })

  it('computeBackoff 有 jitter 产生不同值', () => {
    const results = new Set<number>()
    for (let i = 0; i < 20; i++) {
      results.add(computeBackoff(2000, 0, true))
    }
    expect(results.size).toBeGreaterThanOrEqual(2)
  })

  it('computeBackoff 有 jitter 时 delay >= base * 2^attempt', () => {
    for (let i = 0; i < 10; i++) {
      const d = computeBackoff(2000, 1, true)
      expect(d).toBeGreaterThanOrEqual(4000)
    }
  })

  // ======= getUserMessage =======

  it('getUserMessage 非 FATAL 只返回策略消息', () => {
    const msg = getUserMessage('RETRYABLE', 'timeout')
    expect(msg).toBe('暂时遇到服务波动，正在自动重试...')
    expect(msg).not.toContain('timeout')
  })

  it('getUserMessage FATAL 包含原始错误', () => {
    const msg = getUserMessage('FATAL', 'oom crash')
    expect(msg).toContain('oom crash')
    expect(msg).toContain('无法恢复')
  })

  it('getUserMessage CORRUPTED_STATE 返回回滚提示', () => {
    const msg = getUserMessage('CORRUPTED_STATE', 'orphan tool')
    expect(msg).toContain('回滚')
  })
})
