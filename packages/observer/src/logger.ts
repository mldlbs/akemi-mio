/**
 * Minimal logger for @akemi-mio/observer.
 * No dependencies. Structured JSON console output with timestamps.
 */

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

function ts(): string {
  return new Date().toISOString()
}

export function log(level: LogLevel, event: string, data?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = { ts: ts(), level, event }
  if (data) Object.assign(entry, data)
  const line = JSON.stringify(entry)
  if (level === 'ERROR') {
    console.error(line)
  } else if (level === 'WARN') {
    console.warn(line)
  } else {
    console.log(line)
  }
}
