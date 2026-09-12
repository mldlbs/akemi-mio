import { afterEach, describe, expect, it } from 'vitest'

import { closeDatabase, getRawDb, initDatabase } from '@akemi-mio/core/db/connection'

describe('database connection lifecycle', () => {
  afterEach(() => {
    closeDatabase()
  })

  it('reopens the database after closeDatabase', async () => {
    await initDatabase()
    expect(getRawDb()).toBeDefined()

    closeDatabase()
    await initDatabase()

    expect(getRawDb()).toBeDefined()
  })
})
