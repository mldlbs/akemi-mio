import { exec } from 'child_process'
import { log } from '../logger/Logger'

/** Create an AbortController + auto-timeout timer. Clear the timer after use to avoid leaks. */
export function createTimeoutSignal(timeoutMs: number): { controller: AbortController; timer: ReturnType<typeof setTimeout> } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { controller, timer }
}

/** Race a promise against a timeout. Rejects with `errorMsg` if the timeout fires first. */
export async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, errorMsg = 'timeout'): Promise<T> {
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(errorMsg)), timeoutMs))
  return Promise.race([fn(), timer])
}

/** Retry an async function on rejection. Waits `delayMs` between attempts. */
export async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 1000): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt === retries) throw err
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  throw new Error('unreachable')
}

/**
 * Async replacement for execSync — does NOT block the event loop.
 * Returns stdout on success, or rejects with error augmented with .stdout and .stderr.
 */
export function execAsync(
  cmd: string,
  options: { cwd?: string; timeout?: number; encoding?: string; windowsHide?: boolean; maxBuffer?: number } = {},
): Promise<string> {
  const cmdShort = cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd
  log('DEBUG', 'exec_async_start', { cmd: cmdShort, timeout: options.timeout ?? 60000 })
  const t0 = Date.now()
  return new Promise<string>((resolve, reject) => {
    const child = exec(
      cmd,
      {
        cwd: options.cwd || process.cwd(),
        timeout: options.timeout || 60000,
        maxBuffer: options.maxBuffer || 1024 * 1024,
        windowsHide: options.windowsHide !== false,
      },
      (error, stdout, stderr) => {
        const elapsed = Date.now() - t0
        if (error) {
          log('WARN', 'exec_async_fail', { cmd: cmdShort, elapsed, error: error.message?.slice(0, 120) })
          ;(error as any).stdout = stdout
          ;(error as any).stderr = stderr
          reject(error)
        } else {
          log('DEBUG', 'exec_async_done', { cmd: cmdShort, elapsed, size: stdout.length })
          resolve(stdout)
        }
      },
    )
  })
}
