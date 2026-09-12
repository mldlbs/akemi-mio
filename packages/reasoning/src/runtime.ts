/**
 * Injectable runtime for reasoning.
 *
 * ReasoningPlanner used to import the Electron host logger directly, which
 * blocked reuse outside @akemi-mio/core. Now logging goes through this module:
 * zero-dependency console fallback by default, and the host can plug its own
 * logger once at startup via `configureReasoningLogger()`.
 */

export type ReasoningLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

export type ReasoningLogger = (
  level: ReasoningLogLevel,
  event: string,
  data?: Record<string, unknown>,
) => void

let logger: ReasoningLogger = (level, event, data) => {
  if (process.env.REASONING_SILENT === '1') return
  const line = `[reasoning][${level}] ${event}`
  if (data === undefined) console.log(line)
  else console.log(line, JSON.stringify(data))
}

export function configureReasoningLogger(next: ReasoningLogger): void {
  logger = next
}

export function resetReasoningLogger(): void {
  logger = (level, event, data) => {
    if (process.env.REASONING_SILENT === '1') return
    const line = `[reasoning][${level}] ${event}`
    if (data === undefined) console.log(line)
    else console.log(line, JSON.stringify(data))
  }
}

/** Stable call-site API; always delegates to the current logger. */
export const log: ReasoningLogger = (level, event, data) => logger(level, event, data)
