/**
 * Injectable runtime for agent-persona.
 *
 * The package used to hard-depend on `@akemi-mio/core` (Logger, db message
 * types). To stay reusable outside the Electron host:
 *
 * - logger: console-backed (silence with AGENT_PERSONA_SILENT=1)
 * - StoredMessage: structural local mirror of the host's db message type —
 *   any host type with the same shape stays assignable (TS structural typing)
 *
 * The host application can call `configureAgentPersonaRuntime({ logger })`
 * once at startup to plug its own logger and restore full parity.
 */

export type RuntimeLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

export type RuntimeLogger = (
  level: RuntimeLogLevel,
  event: string,
  data?: Record<string, unknown>,
) => void

/** Structural mirror of `@akemi-mio/core` db StoredMessage (type-only use). */
export interface StoredMessage {
  id: string
  source: 'electron' | 'telegram'
  role: 'user' | 'assistant'
  content: string
  category: string
  sessionId?: string
  telegramChatId?: number | null
  telegramUserId?: number | null
  telegramFrom?: string | null
  telegramMessageId?: number | null
  createdAt: number
}

function consoleLogger(): RuntimeLogger {
  return (level, event, data) => {
    if (process.env.AGENT_PERSONA_SILENT === '1') return
    const line = `[agent-persona][${level}] ${event}`
    if (data === undefined) console.log(line)
    else console.log(line, JSON.stringify(data))
  }
}

let logger: RuntimeLogger = consoleLogger()

export function configureAgentPersonaRuntime(overrides: { logger?: RuntimeLogger } = {}): void {
  if (overrides.logger) logger = overrides.logger
}

export function resetAgentPersonaRuntime(): void {
  logger = consoleLogger()
}

/** Delegates to the current runtime logger on every call. */
export const log: RuntimeLogger = (level, event, data) => logger(level, event, data)
