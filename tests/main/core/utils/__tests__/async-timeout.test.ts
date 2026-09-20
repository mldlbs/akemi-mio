import { describe, it, expect, vi } from 'vitest'
import { withTimeout } from '@akemi-mio/core/utils/async'

// Regression tests for the synchronous-throw leak in withTimeout.
//
// History: `withTimeout` used to call `const work = fn()` BEFORE its try block. When
// `fn` threw SYNCHRONOUSLY (e.g. a runner object lacking the expected method ->
// TypeError), the exception bypassed the finally, so the timer was never cleared and
// the already-created `timeout` promise had no handler. It rejected at timeoutMs as an
// Unhandled Rejection, which vitest reports as "Errors N errors" on an otherwise fully
// green run (`2988 passed` + `exit 1`).
//
// The leak is timing-dependent and therefore hid for a long time: in a short run the
// process exits before the timer fires, so it only surfaces in the full suite, or when
// a test file that triggers it takes longer than the timeout window.
//
// These cases assert the *contract*, not the implementation: a synchronous throw must
// reach the caller AND leave nothing pending.

describe('withTimeout', () => {
  it('resolves with the value when fn finishes in time', async () => {
    const result = await withTimeout(() => Promise.resolve('ok'), 1000)
    expect(result).toBe('ok')
  })

  it('rejects with errorMsg when the timeout wins', async () => {
    await expect(
      withTimeout(
        () => new Promise<string>((resolve) => setTimeout(() => resolve('late'), 500)),
        20,
        'probe_timeout'
      )
    ).rejects.toThrow('probe_timeout')
  })

  it('propagates a rejection from fn', async () => {
    await expect(
      withTimeout(() => Promise.reject(new Error('inner failure')), 1000)
    ).rejects.toThrow('inner failure')
  })

  // The regression case. Must reject with the TypeError (not the timeout message),
  // and must not leave an unhandled rejection behind.
  it('a SYNCHRONOUS throw from fn reaches the caller', async () => {
    await expect(
      withTimeout(() => {
        throw new TypeError('runSelfTask is not a function')
      }, 30, 'probe_timeout')
    ).rejects.toThrow('runSelfTask is not a function')
  })

  it('a synchronous throw does not leak the timeout rejection', async () => {
    // Guard the whole test with a listener: vitest fails the file if a stray
    // rejection escapes, but this makes the failure message explicit.
    const leaks: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      leaks.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)

    try {
      await withTimeout(
        () => {
          throw new TypeError('sync boom')
        },
        20,
        'probe_timeout'
      ).catch(() => {
        /* expected */
      })

      // Wait past the timeout window: a leaked promise would reject in here.
      await new Promise((r) => setTimeout(r, 120))

      expect(leaks).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  // A long timer must not survive the call: otherwise it keeps the event loop alive
  // and shows up as a hanging process / slow suite.
  it('clears the timer when fn resolves first', async () => {
    vi.useFakeTimers()
    try {
      const p = withTimeout(() => Promise.resolve('fast'), 60000, 'never')
      const value = await p
      expect(value).toBe('fast')
      // If the 60s timer were still armed, vitest would report a pending timer.
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
