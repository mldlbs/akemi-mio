import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTimeout, useInterval, useTimerControl } from '../useTimer'

describe('useTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires callback after delay', () => {
    const fn = vi.fn()
    renderHook(() => useTimeout(fn, 1000))
    expect(fn).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not fire when delay is null', () => {
    const fn = vi.fn()
    renderHook(() => useTimeout(fn, null))
    act(() => {
      vi.advanceTimersByTime(100000)
    })
    expect(fn).not.toHaveBeenCalled()
  })

  it('updates callback reference without rescheduling', () => {
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    const { rerender } = renderHook(({ cb }) => useTimeout(cb, 1000), {
      initialProps: { cb: fn1 },
    })
    rerender({ cb: fn2 })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(fn2).toHaveBeenCalledTimes(1)
    expect(fn1).not.toHaveBeenCalled()
  })
})

describe('useInterval', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires repeatedly on interval', () => {
    const fn = vi.fn()
    renderHook(() => useInterval(fn, 100))
    expect(fn).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(250)
    })
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('cleans up on unmount', () => {
    const fn = vi.fn()
    const { unmount } = renderHook(() => useInterval(fn, 100))
    unmount()
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(fn).not.toHaveBeenCalled()
  })

  it('stops when intervalMs becomes null', () => {
    const fn = vi.fn()
    const { rerender } = renderHook(({ ms }) => useInterval(fn, ms), {
      initialProps: { ms: 100 as number | null },
    })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(fn).toHaveBeenCalledTimes(1)
    rerender({ ms: null })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('useTimerControl', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('set fires timeout once', () => {
    const fn = vi.fn()
    const { result } = renderHook(() => useTimerControl())
    act(() => {
      result.current.set(fn, 100)
    })
    expect(fn).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('setInterval fires repeatedly', () => {
    const fn = vi.fn()
    const { result } = renderHook(() => useTimerControl())
    act(() => {
      result.current.setInterval(fn, 50)
    })
    act(() => {
      vi.advanceTimersByTime(120)
    })
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('clear cancels pending timer', () => {
    const fn = vi.fn()
    const { result } = renderHook(() => useTimerControl())
    act(() => {
      result.current.set(fn, 100)
    })
    act(() => {
      result.current.clear()
    })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(fn).not.toHaveBeenCalled()
  })

  it('clears on unmount', () => {
    const fn = vi.fn()
    const { result, unmount } = renderHook(() => useTimerControl())
    act(() => {
      result.current.setInterval(fn, 50)
    })
    unmount()
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(fn).not.toHaveBeenCalled()
  })
})
