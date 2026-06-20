import { log } from '../../logger/Logger'
import { eventBus } from '../EventBus'
import type { IModule, SyscallRequest, SyscallResponse } from './types'

/**
 * SyscallBus — 内核系统调用总线
 *
 * 在已注册的内核模块之间路由系统调用。
 * 提供超时、日志和事件发射。
 */
export class SyscallBus {
  private modules = new Map<string, IModule>()
  private static readonly DEFAULT_TIMEOUT = 30_000

  /** 注册一个模块使其可接收系统调用 */
  register(module: IModule): void {
    if (this.modules.has(module.name)) {
      log('WARN', 'syscall.module_already_registered', { name: module.name })
    }
    this.modules.set(module.name, module)
    log('INFO', 'syscall.module_registered', { name: module.name })
  }

  /** 注销模块 */
  unregister(name: string): void {
    this.modules.delete(name)
    log('INFO', 'syscall.module_unregistered', { name })
  }

  /** 获取已注册模块列表 */
  getRegisteredModules(): string[] {
    return Array.from(this.modules.keys())
  }

  /** 检查模块是否已注册 */
  isRegistered(name: string): boolean {
    return this.modules.has(name)
  }

  /**
   * 向目标模块发起系统调用
   * 超时默认 30 秒
   */
  async call(
    targetModule: string,
    method: string,
    params: unknown,
    caller: string,
    timeoutMs: number = SyscallBus.DEFAULT_TIMEOUT,
  ): Promise<SyscallResponse> {
    const module = this.modules.get(targetModule)
    if (!module) {
      return {
        success: false,
        error: `Module "${targetModule}" not registered`,
        requestId: '',
      }
    }

    const requestId = `sc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const request: SyscallRequest = {
      targetModule,
      method,
      params,
      caller,
      requestId,
      timestamp: Date.now(),
    }

    eventBus.emit('syscall.invoked' as any, {
      targetModule,
      method,
      caller,
      requestId,
    })

    try {
      const result = await this.executeWithTimeout(() => module.handleSyscall(method, params), timeoutMs)

      const response: SyscallResponse = {
        success: true,
        data: result,
        requestId,
      }

      eventBus.emit('syscall.completed' as any, {
        targetModule,
        method,
        requestId,
        durationMs: Date.now() - request.timestamp,
      })

      return response
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)

      eventBus.emit('syscall.failed' as any, {
        targetModule,
        method,
        requestId,
        error,
      })

      return {
        success: false,
        error,
        requestId,
      }
    }
  }

  private async executeWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Syscall timeout after ${timeoutMs}ms`))
      }, timeoutMs)

      fn()
        .then((result) => {
          clearTimeout(timer)
          resolve(result)
        })
        .catch((err) => {
          clearTimeout(timer)
          reject(err)
        })
    })
  }
}
