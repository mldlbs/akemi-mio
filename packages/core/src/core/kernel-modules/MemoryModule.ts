import { log } from '@akemi-mio/core/logger/Logger'
import type { MemoryService } from '@akemi-mio/intelligence-memory/MemoryService'
import type { IModule, HealthCheckResult, SubsystemState } from '../lifecycle/types'

/**
 * MemoryModule — MemoryService 的内核模块封装。
 *
 * 标准化生命周期，暴露只读 query 和有限写入 API。
 */
export class MemoryModule implements IModule {
  readonly name = 'memory'
  readonly prefix = 'packages/intelligence/src/memory/'
  readonly hotReloadable = false
  readonly exports = ['MemoryService']
  state: SubsystemState = 'created'

  private memoryService: MemoryService

  constructor(memoryService: MemoryService) {
    this.memoryService = memoryService
  }

  getExport(name: string): unknown {
    if (name === 'MemoryService') return this.memoryService
    return undefined
  }

  async handleSyscall(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'get_stats':
        return {
          totalEntries: this.memoryService.getEntries().length,
          interactionCount: this.memoryService.getInteractionCount(),
        }

      case 'get_recent_summaries': {
        const p = params as { limit?: number }
        return this.memoryService.summary.getRecent(p?.limit ?? 10)
      }

      case 'flush':
        this.memoryService.flush()
        return { ok: true }

      default:
        throw new Error(`Unknown memory syscall: ${method}`)
    }
  }

  async init(): Promise<void> {
    if (this.state !== 'created') return
    this.state = 'initializing'
    log('INFO', 'memory_module.init')
    this.state = 'ready'
  }

  async start(): Promise<void> {
    if (this.state !== 'ready') return
    this.state = 'running'
    log('INFO', 'memory_module.started')
  }

  async stop(): Promise<void> {
    this.state = 'stopping'
    this.memoryService.shutdown?.()
    log('INFO', 'memory_module.stopped')
    this.state = 'stopped'
  }

  async destroy(): Promise<void> {
    log('INFO', 'memory_module.destroyed')
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return {
      healthy: true,
      detail: `Memory module: ${this.memoryService.getEntries().length} entries`,
    }
  }
}
