import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@akemi-mio/core/credentials/CredentialsManager', () => ({
  credentialsManager: { get: vi.fn() },
}))

import { credentialsManager } from '@akemi-mio/core/credentials/CredentialsManager'
import { resolveTelegramTarget, type TelegramTargetResolution } from '@akemi-mio/messaging/telegram/TelegramTargetRouter'

describe('TelegramTargetRouter', () => {
  afterEach(() => {
    vi.clearAllMocks()
    delete process.env.TELEGRAM_CHAT_ID
  })

  it('returns disabled when radar_chat_id is missing', () => {
    vi.mocked(credentialsManager.get).mockReturnValueOnce(null)

    expect(resolveTelegramTarget('radar')).toEqual({
      status: 'disabled',
      reason: 'missing radar_chat_id',
    } satisfies TelegramTargetResolution)
  })

  it('returns invalid when radar_chat_id is not numeric', () => {
    vi.mocked(credentialsManager.get).mockReturnValueOnce('abc')

    expect(resolveTelegramTarget('radar')).toEqual({
      status: 'invalid',
      reason: 'invalid radar_chat_id',
      rawValue: 'abc',
    } satisfies TelegramTargetResolution)
  })

  it.each(['-100123abc', '12.5', '0', '9007199254740992'])('rejects malformed or unsafe radar target %s', (rawValue) => {
    vi.mocked(credentialsManager.get).mockReturnValueOnce(rawValue)

    expect(resolveTelegramTarget('radar')).toEqual({
      status: 'invalid',
      reason: 'invalid radar_chat_id',
      rawValue,
    } satisfies TelegramTargetResolution)
  })

  it('returns configured when radar_chat_id is numeric', () => {
    vi.mocked(credentialsManager.get).mockReturnValueOnce('-100123456')

    expect(resolveTelegramTarget('radar')).toEqual({
      status: 'configured',
      chatId: -100123456,
    } satisfies TelegramTargetResolution)
  })

  it('resolves push from credential before env fallback', () => {
    process.env.TELEGRAM_CHAT_ID = '2002'
    vi.mocked(credentialsManager.get).mockReturnValueOnce('1001')

    expect(resolveTelegramTarget('push')).toEqual({
      status: 'configured',
      chatId: 1001,
    } satisfies TelegramTargetResolution)
  })

  it('returns disabled when push target is absent in both credential and env', () => {
    vi.mocked(credentialsManager.get).mockReturnValueOnce(null)

    expect(resolveTelegramTarget('push')).toEqual({
      status: 'disabled',
      reason: 'missing telegram_chat_id',
    } satisfies TelegramTargetResolution)
  })
})
