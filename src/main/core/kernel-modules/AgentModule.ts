import { log } from '../../logger/Logger'
import type { AgentService } from '../../agent/AgentService'
import type { IModule, HealthCheckResult, SubsystemState } from '../lifecycle/types'

/**
 * AgentModule — AgentService 的内核模块封装。
 *
 * 通过 IModule 标准化生命周期，暴露有限的 syscall API。
 */
export class AgentModule implements IModule {
  readonly name = 'agent'
  readonly prefix = 'src/main/agent/'
  readonly hotReloadable = false
  readonly exports = ['AgentService']
  state: SubsystemState = 'created'

  private agentService: AgentService

  constructor(agentService: AgentService) {
    this.agentService = agentService
  }

  getExport(name: string): unknown {
    if (name === 'AgentService') return this.agentService
    return undefined
  }

  async handleSyscall(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'get_status':
        return { busy: this.agentService['isBusy']?.() ?? false }

      case 'get_context_stats':
        return { messageCount: this.agentService.getContext().getMessages().length ?? 0 }

      case 'inject_system_message': {
        const p = params as { message?: string }
        if (!p?.message) throw new Error('inject_system_message requires "message" param')
        this.agentService.getContext().addSystemMessage?.(p.message)
        return { ok: true }
      }

      case 'clear_context':
        this.agentService.clearContext()
        return { ok: true }

      default:
        throw new Error(`Unknown agent syscall: ${method}`)
    }
  }

  async init(): Promise<void> {
    if (this.state !== 'created') return
    this.state = 'initializing'
    log('INFO', 'agent_module.init')
    this.state = 'ready'
  }

  async start(): Promise<void> {
    if (this.state !== 'ready') return
    this.state = 'running'
    log('INFO', 'agent_module.started')
  }

  async stop(): Promise<void> {
    this.state = 'stopping'
    this.agentService.saveRecoverySnapshot?.('shutdown', 'module_stop')
    log('INFO', 'agent_module.stopped')
    this.state = 'stopped'
  }

  async destroy(): Promise<void> {
    log('INFO', 'agent_module.destroyed')
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return {
      healthy: true,
      detail: `Agent module, ${this.agentService.getContext()?.getMessages().length ?? 0} messages`,
    }
  }
}
