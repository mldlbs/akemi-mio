import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useClockStore, stopClock } from '../../store/clockStore'

describe('ClockStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    stopClock()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('has a valid initial now value', () => {
    const { now } = useClockStore.getState()
    expect(typeof now).toBe('number')
    expect(now).toBeGreaterThan(0)
  })

  it('allows setting a custom now (for tests)', () => {
    useClockStore.setState({ now: 50000 })
    expect(useClockStore.getState().now).toBe(50000)
  })
})
