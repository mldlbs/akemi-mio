/**
 * Agent OS 生命周期接口定义
 *
 * 所有核心模块必须实现的标准化生命周期接口。
 * 保证模块可以统一初始化、启动、停止和销毁。
 */

export type SubsystemState = 'created' | 'initializing' | 'ready' | 'running' | 'stopping' | 'stopped' | 'failed'

export interface HealthCheckResult {
  healthy: boolean
  detail?: string
  metrics?: Record<string, number>
}

/**
 * 基础子系统接口 — 所有可管理组件的标准生命周期
 */
export interface ISubsystem {
  readonly name: string
  readonly state: SubsystemState

  /** 初始化（分配资源/建立连接），不应开始处理 */
  init(): Promise<void>

  /** 启动（开始处理消息/任务） */
  start(): Promise<void>

  /** 停止（停止处理，保持资源以便恢复） */
  stop(): Promise<void>

  /** 销毁（释放所有资源） */
  destroy(): Promise<void>

  /** 健康检查 */
  healthCheck(): Promise<HealthCheckResult>

  /** 可选：事件订阅 */
  on?(event: string, listener: (...args: any[]) => void): () => void
}

/**
 * 内核模块 — 可注册到 Kernel 的可管理模块
 */
export interface IModule extends ISubsystem {
  readonly prefix: string
  readonly exports: string[]
  readonly hotReloadable: boolean

  /** 获取模块导出的服务实例 */
  getExport(name: string): unknown

  /** 处理系统调用 */
  handleSyscall(method: string, params: unknown): Promise<unknown>
}

/**
 * 系统调用请求
 */
export interface SyscallRequest {
  targetModule: string
  method: string
  params: unknown
  caller: string
  requestId: string
  timestamp: number
}

/**
 * 系统调用响应
 */
export interface SyscallResponse {
  success: boolean
  data?: unknown
  error?: string
  requestId: string
}

/** 子系统状态变更事件 */
export interface SubsystemEventMap {
  'subsystem.state_changed': { name: string; from: SubsystemState; to: SubsystemState; error?: string }
  'subsystem.health_changed': { name: string; healthy: boolean; detail?: string }
}
