import { describe, expect, it } from 'vitest'

describe('messaging package exports', () => {
  it('uses the canonical messaging package implementation', async () => {
    const mod = await import('@akemi-mio/messaging')

    expect(mod.ExternalMessageGateway).toBeTypeOf('function')
  })
})
