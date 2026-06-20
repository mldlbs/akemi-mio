import { log } from '../logger/Logger'
import { eventBus } from '../core/EventBus'
import type { IModule, ISubsystem, HealthCheckResult, SubsystemState } from '../core/lifecycle/types'

/**
 * Kernel — Agent OS 微内核。
 *
 * 职责：
 * 1. 管理所有内核模块的生命周期（注册/注销/热重载）
 * 2. 提供系统调用路由（通过 SyscallBus）
 * 3. 报告内核状态和模块摘要
 *
 * 生命周期：init() → start() → [运行] → stop() → destroy()
 */

export interface KernelModule {
  name: string
  prefix: string
  description: string
  hotReloadable: boolean
  exports: string[]
}

const KERNEL_MODULES: KernelModule[] = [
  {
    name: 'core',
    prefix: 'src/main/core/',
    description: '事件总线、状态管理、引擎注册表、生命周期',
    hotReloadable: false,
    exports: ['EventBus', 'StateManager', 'EngineRegistry', 'Lifecycle', 'Scheduler', 'CircuitBreaker'],
  },
  {
    name: 'constitution',
    prefix: 'src/main/constitution/',
    description: '治理引擎、受保护路径、宪法文档',
    hotReloadable: false,
    exports: ['ConstitutionEngine', 'ProtectedPaths'],
  },
  {
    name: 'kernel',
    prefix: 'src/main/core/Kernel',
    description: '微内核定义',
    hotReloadable: false,
    exports: ['Kernel', 'KernelModule'],
  },
]

export const KERNEL_PREFIXES = KERNEL_MODULES.map((m) => m.prefix)
export const KERNEL_NAMES = new Set(KERNEL_MODULES.map((m) => m.name))

export class Kernel implements ISubsystem {
  readonly name = 'Kernel'
  state: SubsystemState = 'created'

  private modules = new Map<string, IModule>()
  private static instance: Kernel
  private _frozen = false

  static getInstance(): Kernel {
    if (!Kernel.instance) {
      Kernel.instance = new Kernel()
    }
    return Kernel.instance
  }

  // ==================== 模块管理 ====================

  /** 冻结模块注册表，防止运行时修改核心模块 */
  freezeModuleRegistry(): void {
    this._frozen = true
    Object.freeze(KERNEL_MODULES)
    log('INFO', 'kernel.registry_frozen', { moduleCount: KERNEL_MODULES.length })
  }

  /** 验证内核完整性 */
  verifyIntegrity(): { ok: boolean; issues: string[] } {
    const issues: string[] = []
    for (const def of KERNEL_MODULES) {
      const m = this.modules.get(def.name)
      if (!m) {
        issues.push(`Missing module: ${def.name}`)
        continue
      }
      if (m.state !== 'running' && m.state !== 'ready') {
        issues.push(`Module ${def.name} in unexpected state: ${m.state}`)
      }
      if (m.hotReloadable !== def.hotReloadable) {
        issues.push(`Module ${def.name} hotReloadable mismatch: expected=${def.hotReloadable}, actual=${m.hotReloadable}`)
      }
    }
    if (this._frozen !== true) issues.push('Module registry not frozen')
    log('INFO', 'kernel.integrity_check', { ok: issues.length === 0, issueCount: issues.length })
    return { ok: issues.length === 0, issues }
  }

  /** 注册一个模块，调用其 init() */
  async registerModule(module: IModule): Promise<void> {
    if (this._frozen) {
      log('WARN', 'kernel.registry_frozen_cannot_register', { name: module.name })
      return
    }
    if (this.modules.has(module.name)) {
      log('WARN', 'kernel.module_already_registered', { name: module.name })
      return
    }
    this.modules.set(module.name, module)
    await module.init()
    log('INFO', 'kernel.module_registered', { name: module.name, state: module.state })
  }

  /** 注销一个模块，调用 stop() + destroy() */
  async unregisterModule(name: string): Promise<void> {
    if (this._frozen) {
      log('WARN', 'kernel.registry_frozen_cannot_unregister', { name })
      return
    }
    const module = this.modules.get(name)
    if (!module) {
      log('WARN', 'kernel.module_not_found', { name })
      return
    }
    await module.stop()
    await module.destroy()
    this.modules.delete(name)
    log('INFO', 'kernel.module_unregistered', { name })
  }

  /** 热重载模块（仅 hotReloadable 模块） */
  async hotReload(name: string): Promise<boolean> {
    if (this._frozen) {
      log('WARN', 'kernel.registry_frozen_cannot_hotreload', { name })
      return false
    }
    const module = this.modules.get(name)
    if (!module) {
      log('WARN', 'kernel.hotreload_module_not_found', { name })
      return false
    }
    if (!module.hotReloadable) {
      log('WARN', 'kernel.hotreload_not_allowed', { name })
      return false
    }

    log('INFO', 'kernel.hotreload_started', { name })
    await module.stop()
    await module.destroy()
    this.modules.delete(name)

    log('INFO', 'kernel.hotreload_requires_reinit', { name })
    return true
  }

  /** 处理内核级系统调用 */
  async handleSyscall(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'list_modules':
        return Array.from(this.modules.entries()).map(([name, mod]) => ({
          name,
          state: mod.state,
          hotReloadable: mod.hotReloadable,
          exports: mod.exports,
        }))

      case 'get_module_info': {
        const p = params as { name?: string }
        if (!p?.name) throw new Error('get_module_info requires "name" param')
        const mod = this.modules.get(p.name)
        if (!mod) throw new Error(`Module "${p.name}" not found`)
        return {
          name: mod.name,
          state: mod.state,
          hotReloadable: mod.hotReloadable,
          exports: mod.exports,
          prefix: mod.prefix,
        }
      }

      case 'reload_module': {
        const p = params as { name?: string }
        if (!p?.name) throw new Error('reload_module requires "name" param')
        return this.hotReload(p.name)
      }

      default:
        throw new Error(`Unknown kernel syscall: ${method}`)
    }
  }

  /** 获取模块 */
  getModule(name: string): IModule | undefined {
    return this.modules.get(name)
  }

  /** 获取所有已注册模块列表 */
  getModules(): IModule[] {
    return Array.from(this.modules.values())
  }

  // ==================== ISubsystem ====================

  async init(): Promise<void> {
    if (this.state !== 'created') return
    this.state = 'initializing'
    log('INFO', 'kernel.init')
    this.state = 'ready'
  }

  async start(): Promise<void> {
    if (this.state !== 'ready') return
    this.state = 'running'

    for (const [name, mod] of this.modules) {
      if (mod.state === 'ready') {
        try {
          await mod.start()
          log('INFO', 'kernel.module_started', { name })
        } catch (err) {
          log('ERROR', 'kernel.module_start_failed', {
            name,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    log('INFO', 'kernel.started', { moduleCount: this.modules.size })
  }

  async stop(): Promise<void> {
    this.state = 'stopping'

    const reversed = Array.from(this.modules.entries()).reverse()
    for (const [name, mod] of reversed) {
      try {
        await mod.stop()
      } catch (err) {
        log('ERROR', 'kernel.module_stop_failed', {
          name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    this.state = 'stopped'
    log('INFO', 'kernel.stopped')
  }

  async destroy(): Promise<void> {
    const reversed = Array.from(this.modules.entries()).reverse()
    for (const [name, mod] of reversed) {
      try {
        await mod.destroy()
      } catch (err) {
        log('ERROR', 'kernel.module_destroy_failed', {
          name,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    this.modules.clear()
    log('INFO', 'kernel.destroyed')
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const unhealthy: string[] = []
    for (const [name, mod] of this.modules) {
      if (mod.state === 'failed' || mod.state === 'stopped') {
        unhealthy.push(name)
      }
    }
    return {
      healthy: unhealthy.length === 0,
      detail: unhealthy.length > 0 ? `Unhealthy modules: ${unhealthy.join(', ')}` : undefined,
      metrics: { modules: this.modules.size, unhealthy: unhealthy.length },
    }
  }

  // ==================== 摘要 ====================

  getFormattedSummary(): string {
    const lines: string[] = ['Agent OS Kernel:']
    for (const mod of this.modules.values()) {
      const flag = mod.hotReloadable ? 'M' : 'I'
      lines.push(`  [${flag}] ${mod.name}: state=${mod.state}, prefix=${mod.prefix}`)
    }
    lines.push(`  Total: ${this.modules.size} modules registered`)
    return lines.join('\n')
  }
}
