import { ChildProcess, fork, spawn } from 'child_process'
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

  /** spawn 进程专属字段（非 fork） */
  spawnConfig?: {
    command: string
    args: string[]
    cwd?: string
    env?: Record<string, string>
  }
  /** per-process 重启预算，覆盖全局默认值 */
  restartPolicy?: RestartPolicy
  /** stdout/stderr 日志缓冲区，每个进程滚动保留最多 1000 行 */
  logBuffer: LogEntry[]
}

export interface ProcessConfig {
  maxMemoryMb?: number
  maxCpuMs?: number
  healthPingIntervalMs?: number
  maxRestarts?: number
  restartWindowMs?: number
}

export interface SpawnProcessConfig {
  /** spawn 的可执行文件路径 */
  command: string
  /** spawn 的参数列表 */
  args?: string[]
  /** 工作目录 */
  cwd?: string
  /** 环境变量 */
  env?: Record<string, string>
  /** 重启预算，不设置则使用全局默认值 */
  restartPolicy?: RestartPolicy
}

export interface RestartPolicy {
  maxRetries: number
  windowMs: number
  cooldownMs: number
}

export interface LogEntry {
  processId: string
  timestamp: number
  stream: 'stdout' | 'stderr'
  message: string
}

export type SpawnResult = {
  process: ChildProcess
  processId: string
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

/** MCP Controller 默认重启预算：3 次/5 分钟，冷却 60 秒 */
const MCP_RESTART_POLICY: RestartPolicy = { maxRetries: 3, windowMs: 300_000, cooldownMs: 60_000 }
const MAX_LOG_LINES = 1000

/**
 * ProcessManager — Agent OS 子进程生命周期管理器（Runtime Process Supervisor）。
 *
 * ## 职责边界 (ADR-014)
 *
 * ProcessManager owns:
 * - 进程生命周期: spawn / stop / restart / gracefulShutdown
 * - 资源追踪: PID, startTime, restartCount
 * - 重启预算: per-process RestartPolicy, 超限锁定
 * - 日志捕获: stdout/stderr → LogEntry 滚动缓冲区 (1000 行)
 * - 健康探针: fork 进程的 IPC ping (spawn 进程用 exit 检测)
 *
 * ProcessManager does NOT own:
 * - 协议握手: MCP initialize / shutdown 属于 MCPControlPlane
 * - 工具发现: discoverTools 属于 MCPControlPlane
 * - 工具调用路由: callTool 分发属于 ServerManager / MCPControlPlane
 * - MCP 健康检查: MCP ping/pong 属于 MCPControlPlane
 * - 注册表/持久化: Registry 属于上层
 *
 * ## 支持的进程类型
 *
 * 统一管理：启动/停止/重启、PID 追踪、stdout/stderr 捕获、健康探针、重启预算。
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

  /** 注册并启动一个 fork 子进程（IPC-based worker） */
  register(name: string, modulePath: string, config?: ProcessConfig): void {
    if (this.processes.has(name)) {
      log('WARN', 'processmgr.already_registered', { name })
      return
    }

    const reg = this.createRegistration(name, { ...config, modulePath })
    this.processes.set(name, reg)
    this.startProcess(name)
  }

  /** 注册并启动一个 spawn 子进程（stdio-based process，如 MCP Server） */
  registerSpawn(name: string, spawnConfig: SpawnProcessConfig): SpawnResult {
    if (this.processes.has(name)) {
      log('WARN', 'processmgr.already_registered', { name })
      const existing = this.processes.get(name)!
      return { process: existing.proc!, processId: name }
    }

    const reg = this.createRegistration(name, undefined, spawnConfig)
    this.processes.set(name, reg)
    this.startSpawnProcess(name)
    return { process: reg.proc!, processId: name }
  }

  /** 子进程间通信（request/response，仅 fork 模式支持） */
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

  /** 获取进程 stdout/stderr 日志 */
  getLogs(name: string, opts?: { tail?: number; stream?: 'stdout' | 'stderr' }): LogEntry[] {
    const reg = this.processes.get(name)
    if (!reg) return []

    let entries = reg.logBuffer
    if (opts?.stream) {
      entries = entries.filter((e) => e.stream === opts.stream)
    }
    if (opts?.tail && opts.tail > 0) {
      entries = entries.slice(-opts.tail)
    }
    return entries
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

  // ==================== 内部：fork 进程 ====================

  private createRegistration(
    name: string,
    forkConfig?: { modulePath: string } & Partial<ProcessConfig>,
    spawnConfig?: SpawnProcessConfig,
  ): ProcessRegistration {
    const cfg = { ...this.configDefaults, ...forkConfig }
    return {
      name,
      modulePath: forkConfig?.modulePath || '',
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
      spawnConfig: spawnConfig ? {
        command: spawnConfig.command,
        args: spawnConfig.args || [],
        cwd: spawnConfig.cwd,
        env: spawnConfig.env,
      } : undefined,
      restartPolicy: spawnConfig?.restartPolicy,
      logBuffer: [],
    }
  }

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

  // ==================== 内部：spawn 进程 ====================

  private startSpawnProcess(name: string): void {
    const reg = this.processes.get(name)!
    if (reg.state === 'starting' || reg.state === 'running') return
    reg.state = 'starting'

    const sc = reg.spawnConfig!
    const mergedEnv = { ...process.env, ...sc.env } as Record<string, string>

    try {
      const proc = spawn(sc.command, sc.args, {
        cwd: sc.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: mergedEnv,
        windowsHide: true,
      })

      reg.proc = proc
      reg.startTime = Date.now()
      reg.failedPings = 0

      proc.stdout?.on('data', (chunk: Buffer) => {
        this.appendLog(name, 'stdout', chunk.toString())
      })

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        this.appendLog(name, 'stderr', text)
        console.error(`[MCP:${name}] ${text.trim()}`)
      })

      proc.on('error', (err) => {
        log('ERROR', 'processmgr.process_error', { name, error: err.message })
        reg.state = 'stopped'
      })

      proc.on('exit', (code) => {
        console.error(`[MCP:${name}] process exited with code ${code}`)
        this.handleExit(name, reg, code)
      })

      reg.state = 'running'
      log('INFO', 'processmgr.spawned', { name, pid: proc.pid })
    } catch (err: any) {
      log('ERROR', 'processmgr.spawn_failed', { name, error: err.message })
      reg.state = 'stopped'
    }
  }

  // ==================== 内部：通用 ====================

  private appendLog(name: string, stream: 'stdout' | 'stderr', text: string): void {
    const reg = this.processes.get(name)
    if (!reg) return

    const lines = text.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      reg.logBuffer.push({ processId: name, timestamp: Date.now(), stream, message: trimmed })
    }

    // 超出上限时丢弃最旧的
    if (reg.logBuffer.length > MAX_LOG_LINES) {
      reg.logBuffer = reg.logBuffer.slice(-MAX_LOG_LINES)
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
    // Reject all pending requests (fork 进程可能有)
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

  private getRestartPolicy(reg: ProcessRegistration): { maxRetries: number; windowMs: number } {
    if (reg.restartPolicy) {
      return { maxRetries: reg.restartPolicy.maxRetries, windowMs: reg.restartPolicy.windowMs }
    }
    return { maxRetries: this.configDefaults.maxRestarts, windowMs: this.configDefaults.restartWindowMs }
  }

  private attemptRestart(name: string): void {
    const reg = this.processes.get(name)
    if (!reg) return

    const policy = this.getRestartPolicy(reg)
    const now = Date.now()

    if (now - reg.lastRestartTime < policy.windowMs) {
      reg.restartCount++
    } else {
      reg.restartCount = 1
    }
    reg.lastRestartTime = now

    if (reg.restartCount > policy.maxRetries) {
      log('ERROR', 'processmgr.restart_storm', { name, count: reg.restartCount, maxRetries: policy.maxRetries })
      eventBus.emit('process.restart_storm' as any, { name, count: reg.restartCount, maxRetries: policy.maxRetries })
      return
    }

    const delay = Math.min(1000 * Math.pow(2, reg.restartCount - 1), 30_000)
    log('INFO', 'processmgr.scheduling_restart', { name, delayMs: delay, attempt: reg.restartCount })

    setTimeout(() => {
      if (reg.spawnConfig) {
        this.startSpawnProcess(name)
      } else {
        this.startProcess(name)
      }
    }, delay)
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
        if (typeof reg.proc!.send === 'function') {
          reg.proc!.send({ type: 'shutdown' })
        } else {
          reg.proc!.kill('SIGTERM')
        }
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
        if (typeof reg.proc.send === 'function') {
          reg.proc.send({ type: 'ping', id: Date.now() })
          reg.failedPings = 0
        }
        // spawn 进程用 exit 检测，不做 IPC ping
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
