import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryIndexer } from '../MemoryIndexer'

describe('MemoryIndexer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('should create and start', () => {
    const indexer = new MemoryIndexer(0.1)
    const spy = vi.spyOn(global, 'setInterval')
    indexer.start()
    expect(spy).toHaveBeenCalled()
    indexer.stop()
  })

  it('should not start twice', () => {
    const indexer = new MemoryIndexer(1)
    indexer.start()
    const timerId = (indexer as any).timer
    indexer.start()
    expect((indexer as any).timer).toBe(timerId)
    indexer.stop()
  })

  it('should stop timer', () => {
    const indexer = new MemoryIndexer(1)
    const spy = vi.spyOn(global, 'clearInterval')
    indexer.start()
    indexer.stop()
    expect(spy).toHaveBeenCalled()
  })
})
