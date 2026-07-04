import { describe, it, expect } from 'vitest'
import {
  createPending,
  transitionToRunning,
  transitionToSuccess,
  transitionToError,
  transitionToTimeout,
  transitionToCancelled,
  IllegalTransitionError,
  isToolActive,
} from '../toolTypes'
import type { ToolState, ToolEvent } from '../toolTypes'

function startedEvent(overrides?: Partial<ToolEvent & { type: 'tool.started' }>): ToolEvent & { type: 'tool.started' } {
  return { type: 'tool.started', id: 't1', tool: 'search', args: { q: 'test' }, timestamp: 1000, ...overrides }
}

function runTool(): ToolState {
  const pending = createPending(startedEvent())
  return transitionToRunning(pending, startedEvent())
}

describe('createPending', () => {
  it('creates a pending state', () => {
    const state = createPending(startedEvent())
    expect(state.status).toBe('pending')
    expect(state.id).toBe('t1')
    expect(state.tool).toBe('search')
    expect(state.createdAt).toBe(1000)
  })
})

describe('transitionToRunning', () => {
  it('transitions pending → running', () => {
    const pending = createPending(startedEvent())
    const running = transitionToRunning(pending, startedEvent())
    expect(running.status).toBe('running')
    expect(running.id).toBe('t1')
    expect(running.startedAt).toBe(1000)
  })

  it('throws when transitioning from terminal state', () => {
    const terminal = { status: 'success' as const, id: 't1', tool: 'test', startedAt: 1000, endedAt: 2000, latencyMs: 1000 }
    expect(() => transitionToRunning(terminal, startedEvent())).toThrow(IllegalTransitionError)
  })
})

describe('transitionToSuccess', () => {
  it('transitions running → success', () => {
    const tool = runTool()
    const event = { type: 'tool.succeeded' as const, id: 't1', result: 'ok', latencyMs: 500, timestamp: 1500 }
    const result = transitionToSuccess(tool, event)
    expect(result.status).toBe('success')
    expect(result.result).toBe('ok')
    expect(result.latencyMs).toBe(500)
    expect(result.startedAt).toBe(1000)
    expect(result.endedAt).toBe(1500)
  })

  it('throws when transitioning from terminal state', () => {
    const terminal = runTool()
    const successEvent = { type: 'tool.succeeded' as const, id: 't1', result: 'ok', latencyMs: 500, timestamp: 1500 }
    const succeeded = transitionToSuccess(terminal, successEvent)
    expect(() => transitionToSuccess(succeeded, successEvent)).toThrow(IllegalTransitionError)
  })
})

describe('transitionToError', () => {
  it('transitions running → error', () => {
    const tool = runTool()
    const event = { type: 'tool.failed' as const, id: 't1', error: 'permission denied', latencyMs: 300, timestamp: 1300 }
    const result = transitionToError(tool, event)
    expect(result.status).toBe('error')
    expect(result.error).toBe('permission denied')
    expect(result.latencyMs).toBe(300)
  })

  it('throws from non-running states', () => {
    const pending = createPending(startedEvent())
    const event = { type: 'tool.failed' as const, id: 't1', error: 'err', latencyMs: 100, timestamp: 1100 }
    expect(() => transitionToError(pending, event)).toThrow(IllegalTransitionError)
  })
})

describe('transitionToTimeout', () => {
  it('creates a timeout state', () => {
    const tool = runTool()
    const event = { type: 'tool.timedout' as const, id: 't1', latencyMs: 60000, timestamp: 61000 }
    const result = transitionToTimeout(tool, event)
    expect(result.status).toBe('timeout')
    expect(result.latencyMs).toBe(60000)
  })
})

describe('transitionToCancelled', () => {
  it('creates a cancelled state with explicit latency', () => {
    const tool = runTool()
    const event = { type: 'tool.cancelled' as const, id: 't1', latencyMs: 2000, timestamp: 3000 }
    const result = transitionToCancelled(tool, event)
    expect(result.status).toBe('cancelled')
    expect(result.latencyMs).toBe(2000)
  })

  it('calculates latency when not provided', () => {
    const now = Date.now()
    const pending = createPending(startedEvent({ timestamp: now - 5000 }))
    const running = transitionToRunning(pending, startedEvent({ timestamp: now - 5000 }))
    const event = { type: 'tool.cancelled' as const, id: 't1', timestamp: now }
    const result = transitionToCancelled(running, event)
    expect(result.status).toBe('cancelled')
    expect(result.latencyMs).toBeGreaterThanOrEqual(4900)
  })
})

describe('isToolActive', () => {
  it('returns true for pending and running', () => {
    expect(isToolActive(createPending(startedEvent()))).toBe(true)
    expect(isToolActive(runTool())).toBe(true)
  })

  it('returns false for terminal states', () => {
    const tool = runTool()
    const success = transitionToSuccess(tool, { type: 'tool.succeeded', id: 't1', result: '', latencyMs: 0, timestamp: 1500 })
    expect(isToolActive(success)).toBe(false)
  })
})
