import { credentialsManager } from '@akemi-mio/core/credentials/CredentialsManager'

export type TelegramTargetKind = 'push' | 'radar'

export type TelegramTargetResolution =
  | { status: 'configured'; chatId: number }
  | { status: 'disabled'; reason: string }
  | { status: 'invalid'; reason: string; rawValue?: string }

export function resolveTelegramTarget(kind: TelegramTargetKind): TelegramTargetResolution {
  if (kind === 'push') {
    const raw = credentialsManager.get('telegram_chat_id') || process.env.TELEGRAM_CHAT_ID || null
    return parseTarget(raw, 'telegram_chat_id')
  }

  return parseTarget(credentialsManager.get('radar_chat_id') || process.env.RADAR_CHAT_ID || null, 'radar_chat_id')
}

/** Strict integer regex: optional leading minus, then 1-15 digits (within safe integer range). */
const STRICT_INT = /^-?\d{1,15}$/

function parseTarget(raw: string | null, key: 'telegram_chat_id' | 'radar_chat_id'): TelegramTargetResolution {
  if (!raw) {
    return {
      status: 'disabled',
      reason: `missing ${key}`,
    }
  }

  const trimmed = raw.trim()
  if (!STRICT_INT.test(trimmed)) {
    return {
      status: 'invalid',
      reason: `invalid ${key}`,
      rawValue: raw,
    }
  }

  const chatId = Number(trimmed)
  if (chatId === 0 || !Number.isSafeInteger(chatId)) {
    return {
      status: 'invalid',
      reason: `invalid ${key}`,
      rawValue: raw,
    }
  }

  return {
    status: 'configured',
    chatId,
  }
}
