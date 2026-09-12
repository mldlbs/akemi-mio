import { describe, it, expect } from 'vitest'
import { AsyncLock } from '@akemi-mio/core/utils/AsyncLock'

describe('AsyncLock', () => {
  let lock: AsyncLock

  beforeEach(() => {
    lock = new AsyncLock()
  })

  it('acquires immediately when not locked', async () => {
    await lock.acquire()
    expect(lock.isLocked()).toBe(true)
    lock.release()
    expect(lock.isLocked()).toBe(false)
  })

  it('queues waiting acquires', async () => {
    await lock.acquire()
    let secondAcquired = false

    const second = lock.acquire().then(() => {
      secondAcquired = true
    })

    expect(secondAcquired).toBe(false)
    lock.release()
    await second
    expect(secondAcquired).toBe(true)
    lock.release()
  })

  it('run() executes and releases', async () => {
    let inside = false
    const result = await lock.run(async () => {
      inside = true
      return 42
    })
    expect(result).toBe(42)
    expect(lock.isLocked()).toBe(false)
  })

  it('run() serializes concurrent operations', async () => {
    const order: number[] = []
    const p1 = lock.run(async () => {
      await new Promise((r) => setTimeout(r, 10))
      order.push(1)
    })
    const p2 = lock.run(async () => {
      order.push(2)
    })

    await Promise.all([p1, p2])
    expect(order).toEqual([1, 2])
  })

  it('run() releases even on exception', async () => {
    await expect(
      lock.run(async () => {
        throw new Error('test error')
      }),
    ).rejects.toThrow('test error')
    expect(lock.isLocked()).toBe(false)
  })

  it('isLocked returns correct status', async () => {
    expect(lock.isLocked()).toBe(false)
    await lock.acquire()
    expect(lock.isLocked()).toBe(true)
    lock.release()
    expect(lock.isLocked()).toBe(false)
  })
})
