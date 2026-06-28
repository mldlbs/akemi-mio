import { ChildProcess, fork } from 'child_process'
import { join } from 'path'
import { log } from '../logger/Logger'
import { eventBus } from './EventBus'
import type { ISubsystem, HealthCheckResult, SubsystemState } from './lifecycle/types'

// ==================== Types ====================

export interface ProcessRegistration {
  name: string
  modulePath: string
  proc: ChildProcess | null
  state: 'stopped' | 'starting' | 'running' | 'stopping'
  startTime: number
  restartCount: number
  lastRestartTime: number
  maxMemoryMb: number
  maxCpuMs: number
  healthPings: number
  failedPings: number
  pendingRequests: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>
}

export interface ProcessConfig {
  maxMemoryMb?: number
  maxCpuMs?: number
  healthPingIntervalMs?: number
  maxRestarts?: number
  restartWindowMs?: number
}

export type ProcessMessage =
  | { type: 'result'; requestId: string; success: true; data: unknown }
  | { type: 'result'; requestId: string; success: false; error: string }
  | { type: 'lifecycle'; event: 'started' }
  | { type: 'lifecycle'; event: 'error'; error: string }
  | { type: 'pong'; id: number }
  | { type: 'memory_usage'; heapMb: number }
  | { type: 'shutdown_ack' }

const DEFAULT_CONFIG: Required<ProcessConfig> = {
  maxMemoryMb: 256,
  maxCpuMs: 60_000,
  healthPingIntervalMs: 15_000,
  maxRestarts: 5,
  restartWindowMs: 300_000,
}

/**
 * ProcessManager — Agent OS 子进程生命周期管理器。
 *
 * 使用 child_process.fork() 隔离重型服务（ASR/TTS/Evolution worker）。
 * 支持健康探针、自动重启、资源预算强制执行和优雅关闭。
 */
export class ProcessManager implements ISubsystem {
  readonly name = 'ProcessManager'
  state: SubsystemState = 'created'

  private processes = new Map<string, ProcessRegistration>()
  private healthTimer: ReturnType<typeof setInterval> | null = null
  private nextRequestId = 0
  private configDefaults: Required<ProcessConfig>

  constructor(config?: ProcessConfig) {
    this.configDefaults = { ...DEFAULT_CONFIG, ...config }
  }

  // ==================== 进程注册与生命周期 ====================

  /** 注册并启动一个子进程 */
  register(name: string, modulePath: string, config?: ProcessConfig): void {
    if (this.processes.has(name)) {
      log('WARN', 'processmgr.already_registered', { name })
      return
    }

    const cfg = { ...this.configDefaults, ...config }
    const reg: ProcessRegistration = {
      name,
      modulePath,
      proc: null,
      state: 'stopped',
      startTime: 0,
      restartCount: 0,
      lastRestartTime: 0,
      maxMemoryMb: cfg.maxMemoryMb,
      maxCpuMs: cfg.maxCpuMs,
      healthPings: 0,
      failedPings: 0,
      pendingRequests: new Map(),
    }

    this.processes.set(name, reg)
    this.startProcess(name)
  }

  /** 子进程间通信（request/response） */
  async sendRequest(name: string, method: string, data: unknown, timeoutMs = 30_000): Promise<unknown> {
    const reg = this.processes.get(name)
    if (!reg || !reg.proc) throw new Error(`Process "${name}" not running`)
    if (reg.state !== 'running') throw new Error(`Process "${name}" in state ${reg.state}`)

    const requestId = `pm_${Date.now()}_${++this.nextRequestId}`

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reg.pendingRequests.delete(requestId)
        reject(new Error(`Process request ${method} timeout after ${timeoutMs}ms`))
      }, timeoutMs)

      reg.pendingRequests.set(requestId, { resolve, reject, timer })

      reg.proc!.send({ type: 'request', requestId, method, data } as ProcessRequestMessage)
    })
  }

  /** 停止并卸载一个子进程 */
  async unregister(name: string): Promise<void> {
    const reg = this.processes.get(name)
    if (!reg) return
    await this.gracefulShutdown(reg)
    this.processes.delete(name)
    log('INFO', 'processmgr.unregistered', { name })
  }

  isRunning(name: string): boolean {
    return this.processes.get(name)?.state === 'running'
  }

  getUtilization(name: string): { running: boolean; heapMb?: number; uptimeMs: number } | null {
    const reg = this.processes.get(name)
    if (!reg) return null
    return {
      running: reg.state === 'running',
      uptimeMs: reg.state === 'running' ? Date.now() - reg.startTime : 0,
    }
  }

  // ==================== ISubsystem ====================

  async init(): Promise<void> {
    if (this.state !== 'created') return
    this.state = 'initializing'
    log('INFO', 'processmgr.init')
    this.state = 'ready'
  }

  async start(): Promise<void> {
    if (this.state !== 'ready') return
    this.state = 'running'

    this.healthTimer = setInterval(() => this.checkAllProcesses(), this.configDefaults.healthPingIntervalMs)
    this.healthTimer.unref()

    log('INFO', 'processmgr.started')
  }

  async stop(): Promise<void> {
    if (this.state !== 'running') return
    this.state = 'stopping'

    if (this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = null
    }

    const shutdowns = Array.from(this.processes.values()).map((r) => this.gracefulShutdown(r))
    await Promise.all(shutdowns)

    this.state = 'stopped'
    log('INFO', 'processmgr.stopped')
  }

  async destroy(): Promise<void> {
    await this.stop()
    this.processes.clear()
    log('INFO', 'processmgr.destroyed')
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const alive = Array.from(this.processes.values()).filter((r) => r.state === 'running').length
    const total = this.processes.size
    return {
      healthy: alive === total,
      detail: `${alive}/${total} processes running`,
      metrics: { alive, total },
    }
  }

  // ==================== 内部 ====================

  private startProcess(name: string): void {
    const reg = this.processes.get(name)!
    if (reg.state === 'starting' || reg.state === 'running') return
    reg.state = 'starting'

    const workerPath = join(__dirname, '..', '..', '..', reg.modulePath)

    try {
      const proc = fork(workerPath, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, PROCESS_NAME: name },
        execArgv: [],
      })

      reg.proc = proc
      reg.startTime = Date.now()
      reg.failedPings = 0

      proc.on('message', (msg: ProcessMessage) => {
        this.handleMessage(name, reg, msg)
      })

      proc.on('error', (err) => {
        log('ERROR', 'processmgr.process_error', { name, error: err.message })
      })

      proc.on('exit', (code) => {
        this.handleExit(name, reg, code)
      })

      log('INFO', 'processmgr.spawned', { name, pid: proc.pid })
    } catch (err: any) {
      log('ERROR', 'processmgr.spawn_failed', { name, error: err.message })
      reg.state = 'stopped'
    }
  }

  private handleMessage(name: string, reg: ProcessRegistration, msg: ProcessMessage): void {
    switch (msg.type) {
      case 'lifecycle':
        if (msg.event === 'started') {
          reg.state = 'running'
          log('INFO', 'processmgr.process_started', { name })
        } else if (msg.event === 'error') {
          log('ERROR', 'processmgr.process_error_msg', { name, error: msg.error })
        }
        break

      case 'result': {
        const handler = reg.pendingRequests.get(msg.requestId)
        if (handler) {
          clearTimeout(handler.timer)
          reg.pendingRequests.delete(msg.requestId)
          if (msg.success) handler.resolve(msg.data)
          else handler.reject(new Error(msg.error))
        }
        break
      }

      case 'pong':
        reg.failedPings = 0
        break

      case 'memory_usage':
        if (msg.heapMb > reg.maxMemoryMb) {
          log('WARN', 'processmgr.memory_exceeded', { name, heapMb: msg.heapMb, limit: reg.maxMemoryMb })
          eventBus.emit('process.memory_exceeded' as any, { name, heapMb: msg.heapMb, limit: reg.maxMemoryMb })
          this.gracefulShutdown(reg).then(() => this.startProcess(name))
        }
        break

      case 'shutdown_ack':
        log('INFO', 'processmgr.shutdown_ack', { name })
        break
    }
  }

  private handleExit(name: string, reg: ProcessRegistration, code: number | null): void {
    // Reject all pending requests
    for (const [reqId, handler] of reg.pendingRequests) {
      clearTimeout(handler.timer)
      handler.reject(new Error(`Process ${name} exited (code ${code})`))
    }
    reg.pendingRequests.clear()
    reg.proc = null

    if (code !== 0 && reg.state !== 'stopping') {
      reg.state = 'stopped'
      log('WARN', 'processmgr.process_exited', { name, code })
      this.attemptRestart(name)
    } else {
      reg.state = 'stopped'
    }
  }

  private attemptRestart(name: string): void {
    const reg = this.processes.get(name)
    if (!reg) return

    const now = Date.now()
    if (now - reg.lastRestartTime < this.configDefaults.restartWindowMs) {
      reg.restartCount++
    } else {
      reg.restartCount = 1
    }
    reg.lastRestartTime = now

    if (reg.restartCount > this.configDefaults.maxRestarts) {
      log('ERROR', 'processmgr.restart_storm', { name, count: reg.restartCount })
      eventBus.emit('process.restart_storm' as any, { name, count: reg.restartCount })
      return
    }

    const delay = Math.min(1000 * Math.pow(2, reg.restartCount - 1), 30_000)
    log('INFO', 'processmgr.scheduling_restart', { name, delayMs: delay, attempt: reg.restartCount })

    setTimeout(() => this.startProcess(name), delay)
  }

  private async gracefulShutdown(reg: ProcessRegistration): Promise<void> {
    if (!reg.proc || reg.state === 'stopped') return
    reg.state = 'stopping'

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        log('WARN', 'processmgr.shutdown_timeout', { name: reg.name })
        try {
          reg.proc?.kill('SIGKILL')
        } catch {}
        resolve()
      }, 5000)

      reg.proc!.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })

      try {
        reg.proc!.send({ type: 'shutdown' })
      } catch {
        clearTimeout(timeout)
        resolve()
      }
    })
  }

  private checkAllProcesses(): void {
    for (const [name, reg] of this.processes) {
      if (reg.state !== 'running' || !reg.proc) continue
      try {
        reg.proc.send({ type: 'ping', id: Date.now() })
        reg.failedPings = 0
      } catch {
        reg.failedPings++
        if (reg.failedPings >= 2) {
          log('WARN', 'processmgr.health_failed', { name })
          this.attemptRestart(name)
        }
      }
    }
  }
}

// Internal: message type sent TO child processes
interface ProcessRequestMessage {
  type: 'request'
  requestId: string
  method: string
  data: unknown
}
