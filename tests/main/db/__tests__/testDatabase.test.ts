import { afterEach, describe, expect, it } from 'vitest'
import { useIsolatedTestDatabase } from './testDatabase'

describe('test database isolation helper', () => {
  const restorers: Array<() => void> = []

  afterEach(() => {
    while (restorers.length > 0) {
      restorers.pop()!()
    }
  })

  it('allocates a unique user-data directory for each isolation scope', () => {
    const restoreFirst = useIsolatedTestDatabase()
    const firstUserDataDir = process.env.USER_DATA_DIR
    restorers.push(restoreFirst)

    restoreFirst()
    restorers.pop()

    const restoreSecond = useIsolatedTestDatabase()
    const secondUserDataDir = process.env.USER_DATA_DIR
    restorers.push(restoreSecond)

    expect(secondUserDataDir).not.toBe(firstUserDataDir)
  })
})
