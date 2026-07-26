import { log } from '../logger/Logger'
import { CapabilityCatalog } from './CapabilityCatalog'
import { ResolveResult } from './types'

/**
 * CapabilityResolver — 语义 Capability → Provider 解析。
 *
 * ADR-015 M1：
 * - 单 provider 直接返回
 * - 多 provider 返回第一个注册的（确定性）
 * - 不涉及自动选择 / 健康度加权 / fallback 链
 *
 * ADR-015 C-3：总是返回确定的 provider。
 */
export class CapabilityResolver {
  private catalog: CapabilityCatalog

  constructor(catalog: CapabilityCatalog) {
    this.catalog = catalog
  }

  /**
   * 解析 capability → { provider, tool }。
   * 未找到时返回 undefined。
   */
  resolve(capabilityId: string, toolHint?: string): ResolveResult | undefined {
    const def = this.catalog.get(capabilityId)
    if (!def || def.providers.length === 0) {
      log('WARN', 'capability_resolver.not_found', { capabilityId })
      return undefined
    }

    // M1: 单 provider 直接返回
    const provider = def.providers[0]
    const tool = toolHint && provider.tools.includes(toolHint)
      ? toolHint
      : provider.defaultTool || provider.tools[0]

    if (!tool) {
      log('WARN', 'capability_resolver.no_tool', { capabilityId, mcpServerId: provider.mcpServerId })
      return undefined
    }

    log('INFO', 'capability_resolver.resolved', {
      capabilityId,
      mcpServerId: provider.mcpServerId,
      tool,
    })

    return {
      capabilityId,
      provider: { mcpServerId: provider.mcpServerId, tool },
      confidence: 1.0,
    }
  }

  /**
   * 列出所有可解析的 capability（catalog 中存在且至少有一个 provider）。
   */
  listResolvable(): string[] {
    return this.catalog
      .getCapabilities()
      .filter((def) => def.providers.length > 0)
      .map((def) => def.id)
  }
}
