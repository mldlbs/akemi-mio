import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, statSync, WriteStream } from 'fs'
import { join, resolve } from 'path'
import https from 'https'

type Level = 'INFO' | 'WARN' | 'ERROR' | 'PERF' | 'CHAT' | 'DEBUG'

let requestCounter = 0
let currentRequestId = ''

const BEIJING_OFFSET = 8 * 3600 * 1000

function beijingTimestamp(): string {
  return new Date(Date.now() + BEIJING_OFFSET).toISOString().replace('Z', '+08:00')
}

function beijingDateStr(): string {
  return new Date(Date.now() + BEIJING_OFFSET).toISOString().slice(0, 10)
}

// AppData log stream
let logDir: string | null = null
let currentDateStr = ''
let stream: WriteStream | null = null
let bytesWritten = 0
let rotationCheckCounter = 0

// Project-root convenience log (append mode, max 50MB then rotates)
let projectStream: WriteStream | null = null
let projectBytesWritten = 0
const MAX_PROJECT_FILE_SIZE = 50 * 1024 * 1024

// Write serialization lock to prevent interleaved writes from concurrent log() calls
let writeLock: Promise<void> = Promise.resolve()

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB
const ROTATION_CHECK_INTERVAL = 50 // check every 50 writes
const RETENTION_DAYS = 30

export function createRequestId(): string {
  requestCounter++
  return `req_${String(Date.now()).slice(-6)}_${requestCounter}`
}

export function setRequestId(id: string) {
  currentRequestId = id
}

export function getRequestId(): string {
  if (!currentRequestId) {
    currentRequestId = createRequestId()
  }
  return currentRequestId
}

export function sanitizeForLog(text: string): string {
  return text.replace(/\b(sk-[\w-]{10,})/g, (m) => m.slice(0, 8) + '***' + m.slice(-4))
}

/** Get today's log file path for the current date */
function getDailyLogPath(baseDir: string, dateStr: string): string {
  return join(baseDir, `app-${dateStr}.log`)
}

/** Rotate the stream if date changed or file size exceeded */
function ensureStream(): void {
  if (!logDir) return

  const dateStr = beijingDateStr()

  // If same date and stream is healthy and under size limit, reuse it
  if (stream && dateStr === currentDateStr && bytesWritten < MAX_FILE_SIZE) {
    return
  }

  // Close old stream
  if (stream) {
    try {
      stream.end()
    } catch {
      /* ignore */
    }
    stream = null
  }

  currentDateStr = dateStr
  const filePath = getDailyLogPath(logDir, dateStr)

  // Append if file exists (same day restart), create otherwise
  try {
    const existingSize = existsSync(filePath) ? statSync(filePath).size : 0
    bytesWritten = existingSize

    // If existing file already exceeds limit, rotate old file before creating new
    if (existingSize >= MAX_FILE_SIZE) {
      // Rename current to app-YYYY-MM-DD.N.log and start fresh
      let n = 1
      let rotatedPath: string
      do {
        rotatedPath = getDailyLogPath(logDir, `${dateStr}.${n}`)
        n++
      } while (existsSync(rotatedPath))
      try {
        renameSync(filePath, rotatedPath)
        bytesWritten = 0
      } catch {
        /* if rename fails, just append */
      }
    }

    stream = createWriteStream(filePath, { flags: 'a', encoding: 'utf-8' })
    stream.on('error', () => {
      stream = null
    })
  } catch {
    stream = null
  }
}

/** Clean up log files older than RETENTION_DAYS */
function cleanupOldLogs(): void {
  if (!logDir) return
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
    const files = readdirSync(logDir)
    for (const file of files) {
      if (!file.startsWith('app-') || !file.endsWith('.log')) continue
      const filePath = join(logDir, file)
      try {
        const mtime = statSync(filePath).mtimeMs
        if (mtime < cutoff) {
          unlinkSync(filePath)
        }
      } catch {
        /* skip files we can't stat/unlink */
      }
    }
  } catch {
    /* skip if dir doesn't exist */
  }
}

// ── 错误日志自动上报 ──────────────────────────────────────────────
const FEEDBACK_API = 'https://skills.crlkcloud.cyou/feedback/api/feedback'
const SITE_ID = 'akemi-mio'

let lastErrorReport = 0
const ERROR_REPORT_INTERVAL = 60_000 // 相同 event 至少间隔 1 分钟

function reportError(entry: Record<string, unknown>): void {
  const now = Date.now()
  const event = entry.event as string
  // 用时间窗口节流，同一种 event 不频繁上报
  if (now - lastErrorReport < ERROR_REPORT_INTERVAL) return
  lastErrorReport = now

  try {
    const body = JSON.stringify({
      site_id: SITE_ID,
      type: 'bug',
      message: `[${entry.level}] ${event}\n${JSON.stringify(entry, null, 2)}`,
    })
    const req = https.request(
      FEEDBACK_API,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        // 静默消费响应
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          /* 不输出日志避免循环 */
        })
      },
    )
    req.on('error', () => {
      /* 静默失败 */
    })
    req.write(body)
    req.end()
  } catch {
    // 静默失败
  }
}

export function initLogFile(userDataPath: string): void {
  logDir = join(userDataPath, 'logs')
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })

  // Ensure today's stream is ready
  ensureStream()

  // Run cleanup on startup (async, don't block)
  cleanupOldLogs()

  // Run cleanup once daily via a simple counter-based schedule
  // (checked every ~5000 writes, not time-based, to avoid setInterval)
}

export function getLogFilePath(): string | null {
  if (!logDir) return null
  return getDailyLogPath(logDir, beijingDateStr())
}

/** Lazily init a project-root log file, append mode, with size-based rotation. */
function ensureProjectLog(): void {
  const projectRoot = resolve(__dirname, '..', '..')
  const path = join(projectRoot, 'logs.txt')
  if (projectStream) {
    // Check size and rotate if too large
    try {
      if (existsSync(path) && statSync(path).size >= MAX_PROJECT_FILE_SIZE) {
        projectStream.end()
        projectStream = null
        // Rename to logs.1.txt, logs.2.txt, etc.
        let n = 1
        let rotatedPath: string
        do {
          rotatedPath = join(projectRoot, `logs.${n}.txt`)
          n++
        } while (existsSync(rotatedPath))
        try {
          renameSync(path, rotatedPath)
        } catch {
          /* ignore */
        }
        projectBytesWritten = 0
      }
    } catch {
      projectStream = null
    }
    return
  }
  try {
    projectBytesWritten = existsSync(path) ? statSync(path).size : 0
    projectStream = createWriteStream(path, { flags: 'a', encoding: 'utf-8' })
    projectStream.on('error', () => {
      projectStream = null
    })
  } catch {
    projectStream = null
  }
}

export function log(level: Level, event: string, meta?: Record<string, unknown>) {
  const entry: Record<string, unknown> = {
    level,
    timestamp: beijingTimestamp(),
    event,
    ...(meta || {}),
  }
  const line = JSON.stringify(entry)
  console.log(line)

  // Serialize file writes to prevent interleaved JSON lines from concurrent calls
  writeLock = writeLock
    .then(() => {
      if (logDir) {
        ensureStream()
        if (stream) {
          try {
            stream.write(line + '\n')
            bytesWritten += line.length + 1

            rotationCheckCounter++
            if (rotationCheckCounter >= ROTATION_CHECK_INTERVAL) {
              rotationCheckCounter = 0
              if (bytesWritten >= MAX_FILE_SIZE) {
                try {
                  stream.end()
                } catch {
                  /* ignore */
                }
                stream = null
              }
              if (Math.random() < 0.02) cleanupOldLogs()
            }
          } catch {
            // silent
          }
        }
      }

      ensureProjectLog()
      if (projectStream) {
        try {
          projectStream.write(line + '\n')
          projectBytesWritten += line.length + 1
        } catch {
          /* silent */
        }
      }

      if (level === 'ERROR') reportError(entry)
    })
    .catch(() => {})
}
