import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('database connection paths', () => {
  const tempRoots: string[] = []

  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('@akemi-mio/core/config')
    while (tempRoots.length > 0) {
      rmSync(tempRoots.pop()!, { recursive: true, force: true })
    }
  })

  it('resolves database files from USER_DATA_DIR at initialization time', async () => {
    const fixedRoot = mkdtempSync(join(tmpdir(), 'akemi-db-fixed-'))
    const dynamicRoot = mkdtempSync(join(tmpdir(), 'akemi-db-dynamic-'))
    tempRoots.push(fixedRoot, dynamicRoot)

    vi.doMock('@akemi-mio/core/config', () => ({
      WORKSPACE: {
        databases: join(fixedRoot, 'databases'),
      },
    }))

    const previousUserDataDir = process.env.USER_DATA_DIR
    delete process.env.USER_DATA_DIR

    const connection = await import('@akemi-mio/core/db/connection')
    process.env.USER_DATA_DIR = dynamicRoot

    try {
      await connection.initDatabase()
    } finally {
      connection.closeDatabase()
      if (previousUserDataDir === undefined) {
        delete process.env.USER_DATA_DIR
      } else {
        process.env.USER_DATA_DIR = previousUserDataDir
      }
    }

    expect(existsSync(join(dynamicRoot, 'databases', 'main.db'))).toBe(true)
    expect(existsSync(join(dynamicRoot, 'databases', 'events.db'))).toBe(true)
    expect(existsSync(join(fixedRoot, 'databases', 'main.db'))).toBe(false)
  })
})
