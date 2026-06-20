import { Worker } from 'worker_threads'
import { join } from 'path'
import { log } from '../logger/Logger'
import { eventBus } from './EventBus'
import type { ISubsystem, HealthCheckResult, SubsystemState } from '../lifecycle/types'

export type WorkerTaskMessage = {
  type: 'task'
  taskId: string
  name: string
  method: string
  data: any
}

export type WorkerResultMessage = {
  type: 'result'
  taskId: string
  success: boolean
  data: any
  error?: string
}

export type WorkerLifecycleMessage = {
  type: 'lifecycle'
  event: 'started' | 'stopped' | 'error'
  workerName: string
  error?: string
}

export type WorkerPingMessage = {
  type: 'ping'
  id: number
}

export type WorkerPongMessage = {
  type: 'pong'
  id: number
}

export type WorkerShutdownMessage = {
  type: 'shutdown'
}

export type WorkerMessage =
  | WorkerTaskMessage
  | WorkerResultMessage
  | WorkerLifecycleMessage
  | WorkerPingMessage
  | WorkerPongMessage
  | WorkerShutdownMessage

export interface WorkerPoolOptions {
  maxWorkers?: number
  workerDir?: string
}

export interface WorkerRegistration {
  name: string
  worker: Worker
  busy: boolean
  startTime: number
  failedPings: number
  restartCount: number
  lastRestartTime: number
  workerFile: string
  pendingTasks: Set<string>
}

/**
 * Worker 线程池 — 管理后台服务的 Worker 生命周期。
 *
 * 实现 ISubsystem 接口，支持：
 * - 健康探针（ping/pong，15s 间隔）
 * - 自动重启（指数退避 1s→2s→4s→8s→30s）
 * - 优雅关闭（5s 超时后 terminate）
 * - 重启风暴检测（5分钟 >5 次 → 发出事件）
 */
export class WorkerPool implements ISubsystem {
  readonly name = 'WorkerPool'
  state: SubsystemState = 'created'

  private workers = new Map<string, WorkerRegistration>()
  private maxWorkers: number
  private workerDir: string
  private healthTimer: ReturnType<typeof setInterval> | null = null
  private responseHandlers = new Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }>()

  constructor(options: WorkerPoolOptions = {}) {
    this.maxWorkers = options.maxWorkers || 4
    this.workerDir = options.workerDir || join(__dirname, 'workers')
  }

  register(name: string, workerFile: string): void {
    if (this.workers.has(name)) {
      log('WARN', 'workerpool.already_registered', { name })
      return
    }
    this.spawnWorker(name, workerFile)
  }

  sendTask(name: string, taskId: string, method: string, data: any): void {
    const reg = this.workers.get(name)
    if (!reg) throw new Error(`Worker "${name}" not registered`)

    const msg: WorkerTaskMessage = { type: 'task', taskId, name, method, data }
    reg.busy = true
    reg.pendingTasks.add(taskId)
    reg.worker.postMessage(msg)
  }

  sendTaskAndWait(name: string, method: string, data: any, timeoutMs = 30_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const taskId = `tw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const reg = this.workers.get(name)
      if (!reg) return reject(new Error(`Worker "${name}" not registered`))

      const timer = setTimeout(() => {
        this.responseHandlers.delete(taskId)
        reg.pendingTasks.delete(taskId)
        reject(new Error(`Worker task ${method} timeout after ${timeoutMs}ms`))
      }, timeoutMs)

      this.responseHandlers.set(taskId, {
        resolve: (data: any) => {
          clearTimeout(timer)
          resolve(data)
        },
        reject: (err: Error) => {
          clearTimeout(timer)
          reject(err)
        },
      })

      reg.busy = true
      reg.pendingTasks.add(taskId)
      reg.worker.postMessage({ type: 'task', taskId, name, method, data } as WorkerTaskMessage)
    })
  }

  isActive(name: string): boolean {
    const reg = this.workers.get(name)
    if (!reg) return false
    try {
      reg.worker.threadId
      return true
    } catch {
      return false
    }
  }

  isBusy(name: string): boolean {
    return this.workers.get(name)?.busy ?? false
  }

  // ==================== ISubsystem ====================

  async init(): Promise<void> {
    if (this.state !== 'created') return
    this.state = 'initializing'
    log('INFO', 'workerpool.init')
    this.state = 'ready'
  }

  async start(): Promise<void> {
    if (this.state !== 'ready') return
    this.state = 'running'

    this.healthTimer = setInterval(() => this.checkAllWorkers(), 15_000)
    this.healthTimer.unref()

    log('INFO', 'workerpool.started', { maxWorkers: this.maxWorkers })
  }

  async stop(): Promise<void> {
    if (this.state !== 'running') return
    this.state = 'stopping'

    if (this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = null
    }

    const promises: Promise<void>[] = []
    for (const [name, reg] of this.workers) {
      promises.push(this.gracefulShutdown(name, reg))
    }
    await Promise.all(promises)
    this.responseHandlers.clear()

    this.state = 'stopped'
    log('INFO', 'workerpool.stopped')
  }

  async destroy(): Promise<void> {
    await this.stop()
    this.workers.clear()
    log('INFO', 'workerpool.destroyed')
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const alive = this.workers.size
    const dead = Array.from(this.workers.values()).filter((r) => {
      try {
        r.worker.threadId
        return false
      } catch {
        return true
      }
    }).length

    return {
      healthy: dead === 0,
      detail: dead > 0 ? `${dead} worker(s) dead of ${alive}` : `${alive} worker(s) running`,
      metrics: { alive, dead },
    }
  }

  // ==================== 内部方法 ====================

  private spawnWorker(name: string, workerFile: string): void {
    const workerPath = join(this.workerDir, workerFile)
    log('INFO', 'workerpool.spawning', { name, path: workerPath })

    let worker: Worker
    try {
      worker = new Worker(workerPath, {
        workerData: { workerName: name },
      })
    } catch (err: any) {
      log('ERROR', 'workerpool.spawn_failed', { name, error: err.message })
      return
    }

    const registration: WorkerRegistration = {
      name,
      worker,
      busy: false,
      startTime: Date.now(),
      failedPings: 0,
      restartCount: 0,
      lastRestartTime: 0,
      workerFile,
      pendingTasks: new Set(),
    }

    worker.on('message', (msg: WorkerMessage) => {
      if (msg.type === 'result') {
        registration.busy = false
        registration.pendingTasks.delete(msg.taskId)
        const handler = this.responseHandlers.get(msg.taskId)
        if (handler) {
          this.responseHandlers.delete(msg.taskId)
          if (msg.success) handler.resolve(msg.data)
          else handler.reject(new Error(msg.error || 'Worker task failed'))
        }
      } else if (msg.type === 'lifecycle' && msg.event === 'started') {
        log('INFO', 'workerpool.worker_started', { name })
      } else if (msg.type === 'lifecycle' && msg.event === 'error') {
        log('ERROR', 'workerpool.worker_error', { name, error: msg.error })
      } else if (msg.type === 'pong') {
        registration.failedPings = 0
      }
    })

    worker.on('error', (err) => {
      log('ERROR', 'workerpool.worker_error_event', { name, error: err.message })
      registration.busy = false
    })

    worker.on('exit', (code) => {
      // Clear busy flag and pending task handlers on exit
      registration.busy = false
      for (const taskId of registration.pendingTasks) {
        const handler = this.responseHandlers.get(taskId)
        if (handler) {
          this.responseHandlers.delete(taskId)
          handler.reject(new Error(`Worker ${name} exited (code ${code})`))
        }
      }
      registration.pendingTasks.clear()

      if (code !== 0) {
        log('WARN', 'workerpool.worker_exited', { name, code })
        if (this.state === 'running') {
          this.attemptRestart(name)
        }
      }
      this.workers.delete(name)
    })

    this.workers.set(name, registration)
  }

  private async gracefulShutdown(name: string, reg: WorkerRegistration): Promise<void> {
    const TIMEOUT_MS = 5000

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        log('WARN', 'workerpool.shutdown_timeout', { name })
        try {
          reg.worker.terminate()
        } catch {}
        resolve()
      }, TIMEOUT_MS)

      reg.worker.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })

      try {
        reg.worker.postMessage({ type: 'shutdown' } as WorkerShutdownMessage)
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  private checkAllWorkers(): void {
    for (const [name, reg] of this.workers) {
      try {
        reg.worker.postMessage({ type: 'ping', id: Date.now() } as WorkerPingMessage)
      } catch {
        reg.failedPings++
        if (reg.failedPings >= 2) {
          log('WARN', 'workerpool.health_check_failed', { name, failedPings: reg.failedPings })
          this.attemptRestart(name)
        }
      }
    }
  }

  private attemptRestart(name: string): void {
    const reg = this.workers.get(name)
    if (!reg || !reg.workerFile) return

    const now = Date.now()
    if (now - reg.lastRestartTime < 300_000) {
      reg.restartCount++
    } else {
      reg.restartCount = 1
    }
    reg.lastRestartTime = now

    if (reg.restartCount > 5) {
      log('ERROR', 'workerpool.restart_storm', { name, count: reg.restartCount })
      eventBus.emit('worker.cycle_failed' as any, { name, restarts: reg.restartCount, periodMs: 300_000 })
      return
    }

    const delay = Math.min(1000 * Math.pow(2, reg.restartCount - 1), 30_000)
    log('INFO', 'workerpool.scheduling_restart', { name, delayMs: delay, attempt: reg.restartCount })

    setTimeout(() => {
      try {
        reg.worker.terminate()
      } catch {}
      this.workers.delete(name)
      this.spawnWorker(name, reg.workerFile)
    }, delay)
  }
}
