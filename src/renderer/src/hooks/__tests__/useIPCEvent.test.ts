import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useIPCEvent } from '../useIPCEvent'

describe('useIPCEvent', () => {
  it('calls the register function on mount', () => {
    const register = vi.fn<(...args: [(data: string) => void]) => () => void>()
    renderHook(() => useIPCEvent(register, vi.fn()))
    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith(expect.any(Function))
  })

  it('passes data to the handler when event fires', () => {
    const register = vi.fn<(...args: [(data: string) => void]) => () => void>()
    const handler = vi.fn()
    renderHook(() => useIPCEvent(register, handler))
    const callback = register.mock.calls[0][0]
    callback('test data')
    expect(handler).toHaveBeenCalledWith('test data')
  })

  it('calls cleanup on unmount', () => {
    const cleanup = vi.fn()
    const register = vi.fn<(...args: [(data: string) => void]) => () => void>().mockReturnValue(cleanup)
    const { unmount } = renderHook(() => useIPCEvent(register, vi.fn()))
    unmount()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('handles undefined cleanup gracefully', () => {
    const register = vi.fn<(...args: [(data: string) => void]) => () => void>().mockReturnValue(undefined as any)
    const { unmount } = renderHook(() => useIPCEvent(register, vi.fn()))
    expect(() => unmount()).not.toThrow()
  })

  it('calls latest handler across re-renders without re-subscribing', () => {
    const register = vi.fn<(...args: [(data: string) => void]) => () => void>()
    const handler1 = vi.fn()
    const handler2 = vi.fn()
    const { rerender } = renderHook(({ handler }) => useIPCEvent(register, handler), {
      initialProps: { handler: handler1 },
    })
    expect(register).toHaveBeenCalledTimes(1)
    rerender({ handler: handler2 })
    expect(register).toHaveBeenCalledTimes(1) // no re-subscribe
    const callback = register.mock.calls[0][0]
    callback('data')
    expect(handler2).toHaveBeenCalledWith('data')
    expect(handler1).not.toHaveBeenCalled()
  })

  it('re-subscribes when deps change', () => {
    const register = vi.fn<(...args: [(data: string) => void]) => () => void>().mockReturnValue(vi.fn())
    const { rerender } = renderHook(({ dep }) => useIPCEvent(register, vi.fn(), [dep]), {
      initialProps: { dep: 'a' },
    })
    expect(register).toHaveBeenCalledTimes(1)
    rerender({ dep: 'b' })
    expect(register).toHaveBeenCalledTimes(2)
  })
})
