import { log } from '../../logger/Logger'
import type { ServerManager } from '../../mcp/ServerManager'
import type { IModule, HealthCheckResult, SubsystemState } from '../lifecycle/types'

/**
 * McpModule — MCP ServerManager 的内核模块封装。
 *
 * 标准化生命周期，暴露 MCP 服务器查询和工具列表接口。
 */
export class McpModule implements IModule {
  readonly name = 'mcp'
  readonly prefix = 'src/main/mcp/'
  readonly hotReloadable = false
  readonly exports = ['ServerManager']
  state: SubsystemState = 'created'

  private mcpManager: ServerManager

  constructor(mcpManager: ServerManager) {
    this.mcpManager = mcpManager
  }

  getExport(name: string): unknown {
    if (name === 'ServerManager') return this.mcpManager
    return undefined
  }

  async handleSyscall(method: string, _params: unknown): Promise<unknown> {
    switch (method) {
      case 'list_servers':
        return this.mcpManager.listServers()

      case 'list_tools':
        return this.mcpManager.listTools()

      case 'get_server_count':
        return { count: this.mcpManager.listServers().length }

      default:
        throw new Error(`Unknown mcp syscall: ${method}`)
    }
  }

  async init(): Promise<void> {
    if (this.state !== 'created') return
    this.state = 'initializing'
    log('INFO', 'mcp_module.init')
    this.state = 'ready'
  }

  async start(): Promise<void> {
    if (this.state !== 'ready') return
    this.state = 'running'
    log('INFO', 'mcp_module.started')
  }

  async stop(): Promise<void> {
    this.state = 'stopping'
    log('INFO', 'mcp_module.stopped')
    this.state = 'stopped'
  }

  async destroy(): Promise<void> {
    log('INFO', 'mcp_module.destroyed')
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return {
      healthy: true,
      detail: `MCP module: ${this.mcpManager.listServers().length} servers`,
    }
  }
}
