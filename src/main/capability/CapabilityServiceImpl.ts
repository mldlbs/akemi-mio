import { log } from '../logger/Logger'
import { CapabilityResolver } from './CapabilityResolver'
import type { ServerManager } from '../mcp/ServerManager'
import { CapabilityBinding, ICapabilityService } from './types'

/**
 * CapabilityServiceImpl — Agent 能力的统一入口。
 *
 * ADR-015 M5.2：
 * - resolve(): 通过 Resolver 找到能力提供者
 * - invoke(): 通过 ServerManager.callTool 执行
 * - Permission 检查在 invoke 路径内（ServerManager 内部的 CapabilityEngine）
 * - Resolver 不执行权限检查（C-1）
 *
 * Agent 调用链：
 *
 * ```
 * Agent
 *   |
 * CapabilityService.resolve("publishing")
 *   | → CapabilityBinding { capability, provider, tool }
 *   |
 * CapabilityService.invoke(binding, input)
 *   | → ServerManager.callTool(tool, input) ← 此路径含 Permission
 *   | → MCP Server
 * ```
 *
 * Agent 永远不知道：
 * - MCP server id
 * - tool name
 * - transport protocol
 */
export class CapabilityServiceImpl implements ICapabilityService {
  private resolver: CapabilityResolver
  private serverManager: ServerManager

  constructor(resolver: CapabilityResolver, serverManager: ServerManager) {
    this.resolver = resolver
    this.serverManager = serverManager
  }

  async resolve(capability: string, toolHint?: string): Promise<CapabilityBinding | undefined> {
    const result = this.resolver.resolve(capability, toolHint)
    if (!result) {
      log('WARN', 'capability_service.resolve_failed', { capability })
      return undefined
    }

    const binding: CapabilityBinding = {
      capability: result.capabilityId,
      provider: { type: 'mcp', id: result.provider.mcpServerId },
      tool: result.provider.tool,
    }

    log('INFO', 'capability_service.resolved', {
      capability,
      mcpServerId: binding.provider.id,
      tool: binding.tool,
    })

    return binding
  }

  async invoke(binding: CapabilityBinding, input: unknown): Promise<unknown> {
    log('INFO', 'capability_service.invoke', {
      capability: binding.capability,
      provider: binding.provider.id,
      tool: binding.tool,
    })

    // 委托 ServerManager 执行，此路径包含 Permission 检查
    const result = await this.serverManager.callTool(binding.tool, input as Record<string, any>)

    log('INFO', 'capability_service.invoked', {
      capability: binding.capability,
      success: true,
    })

    return result
  }

  listCapabilities(): string[] {
    return this.resolver.listResolvable()
  }
}
