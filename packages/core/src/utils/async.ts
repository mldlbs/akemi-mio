import { exec } from 'child_process'
import { log } from '@akemi-mio/core/logger/Logger'

/** Create an AbortController + auto-timeout timer. Clear the timer after use to avoid leaks. */
export function createTimeoutSignal(timeoutMs: number): { controller: AbortController; timer: ReturnType<typeof setTimeout> } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { controller, timer }
}

/**
 * Race a promise against a timeout. Rejects with `errorMsg` if the timeout fires first.
 *
 * `Promise.race` 不会取消落选的一方，所以两个方向都要收尾，否则：
 *   1. fn 先返回时，那个 setTimeout 仍会到点 reject，而已经没人接它 ——
 *      变成 unhandled rejection（测试里表现为 "Errors N errors"，
 *      且可能掩盖真正的失败）。timer 还会一直挂到 timeoutMs 到期才释放，
 *      拖着 event loop、推迟进程退出。
 *   2. timeout 先触发时，fn 之后才 reject 同理。
 * 所以这里 finally 里 clearTimeout，并给 fn 挂一个空 catch 吃掉落选后的 rejection。
 *
 * ⚠️ `fn()` 必须在 try 内调用：`fn` 同步抛出时（例如 runner 根本没有那个方法，
 * 调用即 TypeError），若 `fn()` 写在 try 之前，异常会绕过 finally ——
 * timer 不会被清掉，那个已经建好的 `timeout` promise 也没人接，
 * 到期后变成 Unhandled Rejection。单文件跑得快时定时器还没到点进程就退了，
 * 只有在长时/并发运行里才暴露，因此这个缺陷藏得很深。
 */
export async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, errorMsg = 'timeout'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  // `timeout` 一旦建成，就必须保证有处理者：同步抛出时由下面的 catch 分支接手。
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(errorMsg)), timeoutMs)
  })
  let work: Promise<T>
  try {
    work = fn()
  } catch (err) {
    // fn 同步抛出：定时器已建但 work 不存在，必须自己收掉两样东西再抛出。
    clearTimeout(timer)
    timeout.catch(() => {})
    throw err
  }
  work.catch(() => {})
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
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
