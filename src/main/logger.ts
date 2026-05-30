type Level = 'INFO' | 'WARN' | 'ERROR' | 'PERF'

let requestCounter = 0
let currentRequestId = ''

export function setRequestId(id: string) {
  currentRequestId = id
}

export function getRequestId(): string {
  if (!currentRequestId) {
    requestCounter++
    currentRequestId = `req_${String(Date.now()).slice(-6)}_${requestCounter}`
  }
  return currentRequestId
}

export function log(level: Level, event: string, meta?: Record<string, unknown>) {
  const entry: Record<string, unknown> = {
    level,
    timestamp: new Date().toISOString(),
    event,
    ...(meta || {})
  }
  console.log(JSON.stringify(entry))
}
