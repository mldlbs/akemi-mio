import { describe, expect, it, vi } from 'vitest'

vi.mock('@akemi-mio/core/logger/Logger', () => ({
  log: vi.fn(),
}))

describe('credentials package exports', () => {
  it('uses the canonical CredentialsManager package implementation', async () => {
    const legacy = await import('@akemi-mio/core/credentials/CredentialsManager')
    const canonical = await import('../../../../packages/core/src/credentials/CredentialsManager')

    expect(legacy.CredentialsManager).toBe(canonical.CredentialsManager)
    expect(legacy.credentialsManager).toBe(canonical.credentialsManager)
  })

  it('uses the canonical social credentials migration package implementation', async () => {
    const mod = await import('@akemi-mio/core/credentials/socialCredsMigration')

    expect(mod.SOCIAL_CREDS_KEY_MIGRATION.TELEGRAM_BOT_TOKEN).toBe('telegram_bot_token')
    expect(mod.mapSocialCreds({ TELEGRAM_BOT_TOKEN: 'token' })).toEqual([['telegram_bot_token', 'token']])
  })

})
