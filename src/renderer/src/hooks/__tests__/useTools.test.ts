import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTools } from '../useTools'
import { createMockIPC } from '../../__tests__/mockIPC'

beforeEach(() => {
  window.electronAPI = createMockIPC() as any
})

describe('useTools', () => {
  it('starts with empty lists', () => {
    const { result } = renderHook(() => useTools())
    expect(result.current.toolRunning).toEqual([])
    expect(result.current.toolCompleted).toEqual([])
  })

  it('clears both lists on tool:status "start"', () => {
    let onStatusHandler: Function = () => {}
    window.electronAPI.onToolStatus = vi.fn().mockImplementation((cb: Function) => {
      onStatusHandler = cb
      return vi.fn()
    })
    const { result } = renderHook(() => useTools())
    act(() => {
      onStatusHandler({ type: 'start', tool: 'all', message: 'new turn' })
    })
    expect(result.current.toolRunning).toEqual([])
    expect(result.current.toolCompleted).toEqual([])
  })

  it('adds tool to running on onToolInvoked', () => {
    let onInvokedHandler: Function = () => {}
    window.electronAPI.onToolInvoked = vi.fn().mockImplementation((cb: Function) => {
      onInvokedHandler = cb
      return vi.fn()
    })
    const { result } = renderHook(() => useTools())
    act(() => {
      onInvokedHandler({ tool: 'search', args: { q: 'test' }, id: 't1' })
    })
    expect(result.current.toolRunning).toHaveLength(1)
    expect(result.current.toolRunning[0].tool).toBe('search')
  })

  it('moves tool from running to completed on onToolCompleted', () => {
    let onInvokedHandler: Function = () => {}
    let onCompletedHandler: Function = () => {}
    window.electronAPI.onToolInvoked = vi.fn().mockImplementation((cb: Function) => {
      onInvokedHandler = cb
      return vi.fn()
    })
    window.electronAPI.onToolCompleted = vi.fn().mockImplementation((cb: Function) => {
      onCompletedHandler = cb
      return vi.fn()
    })
    const { result } = renderHook(() => useTools())
    act(() => {
      onInvokedHandler({ tool: 'search', args: {}, id: 't1' })
    })
    expect(result.current.toolRunning).toHaveLength(1)
    act(() => {
      onCompletedHandler({ tool: 'search', result: 'ok', id: 't1', latencyMs: 100 })
    })
    expect(result.current.toolRunning).toHaveLength(0)
    expect(result.current.toolCompleted).toHaveLength(1)
    expect(result.current.toolCompleted[0].latencyMs).toBe(100)
  })

  it('moves tool to completed with error on onToolFailed', () => {
    let onInvokedHandler: Function = () => {}
    let onFailedHandler: Function = () => {}
    window.electronAPI.onToolInvoked = vi.fn().mockImplementation((cb: Function) => {
      onInvokedHandler = cb
      return vi.fn()
    })
    window.electronAPI.onToolFailed = vi.fn().mockImplementation((cb: Function) => {
      onFailedHandler = cb
      return vi.fn()
    })
    const { result } = renderHook(() => useTools())
    act(() => {
      onInvokedHandler({ tool: 'search', args: {}, id: 't2' })
    })
    act(() => {
      onFailedHandler({ tool: 'search', error: 'timeout', id: 't2', latencyMs: 5000 })
    })
    expect(result.current.toolCompleted[0].error).toBe('timeout')
    expect(result.current.toolRunning).toHaveLength(0)
  })
})
