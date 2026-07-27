import { log } from '../logger/Logger'
import { CapabilityResolver } from './CapabilityResolver'
import type { ServerManager } from '../mcp/ServerManager'
import { CapabilityBinding, ICapabilityService, CapabilityProviderAdapter } from './types'
import { eventBus } from '../core/EventBus'

/**
 * CapabilityServiceImpl — Agent 能力的统一入口。
 *
 * ADR-015 M5.2：
 * - resolve(): 通过 Resolver 找到能力提供者
 * - invoke(): 通过 ServerManager.callTool 执行
 * - Permission 检查在 invoke 路径内（ServerManager 内部的 CapabilityEngine）
 * - Resolver 不执行权限检查（C-1）
 *
 * P1.3b (Capability Schema Ownership D3):
 * - 持有 providerAdapters 映射，将 canonical input 转换为 provider-specific params
 * - 无 adapter 的 provider 保持向后兼容
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
 *   | → adapter(input)  ← P1.3b: 适配 canonical → tool params
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
  /** P1.3b: provider id + tool → canonical input adapter */
  private providerAdapters = new Map<string, CapabilityProviderAdapter>()

  constructor(resolver: CapabilityResolver, serverManager: ServerManager) {
    this.resolver = resolver
    this.serverManager = serverManager
  }

  /** 注册 provider adapter: key = "{providerId}:{tool}" */
  setAdapter(providerId: string, tool: string, adapter: CapabilityProviderAdapter): void {
    this.providerAdapters.set(`${providerId}:${tool}`, adapter)
  }

  /** 获取 adapter key 对应的 adapter */
  private getAdapter(providerId: string, tool: string): CapabilityProviderAdapter | undefined {
    return this.providerAdapters.get(`${providerId}:${tool}`)
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
    const startedAt = Date.now()
    log('INFO', 'capability_service.invoke', {
      capability: binding.capability,
      provider: binding.provider.id,
      tool: binding.tool,
    })

    // 发射 capability.invoked 事件（P0 数据面）
    eventBus.emit('capability.invoked', {
      capability: binding.capability,
      provider: binding.provider.id,
      tool: binding.tool,
      input,
    })

    try {
      // P1.3b: 如果存在 provider adapter，转换 canonical input → tool-specific params
      const adapter = this.getAdapter(binding.provider.id, binding.tool)
      const toolInput = adapter ? adapter(input, binding.tool) : input

      // 委托 ServerManager 执行，此路径包含 Permission 检查
      const result = await this.serverManager.callTool(binding.tool, toolInput as Record<string, any>)

      const durationMs = Date.now() - startedAt
      log('INFO', 'capability_service.invoked', {
        capability: binding.capability,
        success: true,
        durationMs,
      })

      // 发射 capability.completed 事件（P0 数据面）
      eventBus.emit('capability.completed', {
        capability: binding.capability,
        provider: binding.provider.id,
        tool: binding.tool,
        success: true,
        durationMs,
      })

      return result
    } catch (err: any) {
      const durationMs = Date.now() - startedAt
      log('WARN', 'capability_service.failed', {
        capability: binding.capability,
        error: err.message,
        durationMs,
      })

      // 失败也发射 capability.completed（P0 数据面）
      eventBus.emit('capability.completed', {
        capability: binding.capability,
        provider: binding.provider.id,
        tool: binding.tool,
        success: false,
        durationMs,
        error: err.message,
      })

      throw err
    }
  }

  listCapabilities(): string[] {
    return this.resolver.listResolvable()
  }
}
