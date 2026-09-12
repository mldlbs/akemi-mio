import { describe, expect, it, vi } from 'vitest'

vi.mock('@akemi-mio/core/logger/Logger', () => ({
  log: vi.fn(),
}))

describe('main database compatibility exports', () => {
  it('points the legacy db connection import path at the canonical package implementation', async () => {
    const legacy = await import('@akemi-mio/core/db/connection')
    const canonical = await import('../../../../packages/core/src/db/connection')

    expect(legacy.initDatabase).toBe(canonical.initDatabase)
    expect(legacy.getRawDb).toBe(canonical.getRawDb)
    expect(legacy.closeDatabase).toBe(canonical.closeDatabase)
  })
})
