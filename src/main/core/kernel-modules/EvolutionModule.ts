import { log } from '../../logger/Logger'
import type { SelfEvolutionService } from '../../evolution/SelfEvolutionService'
import type { IModule, HealthCheckResult, SubsystemState } from '../lifecycle/types'

/**
 * EvolutionModule — SelfEvolutionService 的内核模块封装。
 *
 * 标准化生命周期，暴露有限监控和触发接口。
 */
export class EvolutionModule implements IModule {
  readonly name = 'evolution'
  readonly prefix = 'src/main/evolution/'
  readonly hotReloadable = false
  readonly exports = ['SelfEvolutionService']
  state: SubsystemState = 'created'

  private evolutionService: SelfEvolutionService

  constructor(evolutionService: SelfEvolutionService) {
    this.evolutionService = evolutionService
  }

  getExport(name: string): unknown {
    if (name === 'SelfEvolutionService') return this.evolutionService
    return undefined
  }

  async handleSyscall(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'get_state':
        return { state: this.evolutionService['state'] ?? 'unknown' }

      case 'trigger_cycle':
        if (!this.evolutionService.runAnalysisCycle) throw new Error('runAnalysisCycle not available')
        return this.evolutionService.runAnalysisCycle()

      case 'get_snapshot':
        return {
          state: this.evolutionService['state'],
          currentMode: this.evolutionService['currentMode'],
          safetyMode: this.evolutionService['safetyMode'],
        }

      default:
        throw new Error(`Unknown evolution syscall: ${method}`)
    }
  }

  async init(): Promise<void> {
    if (this.state !== 'created') return
    this.state = 'initializing'
    log('INFO', 'evolution_module.init')
    this.state = 'ready'
  }

  async start(): Promise<void> {
    if (this.state !== 'ready') return
    this.state = 'running'
    log('INFO', 'evolution_module.started')
  }

  async stop(): Promise<void> {
    this.state = 'stopping'
    log('INFO', 'evolution_module.stopped')
    this.state = 'stopped'
  }

  async destroy(): Promise<void> {
    log('INFO', 'evolution_module.destroyed')
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return {
      healthy: true,
      detail: `Evolution module: state=${this.evolutionService['state'] ?? 'unknown'}`,
    }
  }
}
