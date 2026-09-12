import { log } from '@akemi-mio/core/logger/Logger'
import { CapabilityCatalog } from './CapabilityCatalog'
import { type ResolveResult } from './types'

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

    // toolHint 约定（M5.3 之前）：优先选择声明了该工具的 provider
    if (toolHint) {
      const owner = def.providers.find((p) => p.tools.includes(toolHint))
      if (owner) {
        log('INFO', 'capability_resolver.resolved', { capabilityId, mcpServerId: owner.mcpServerId, tool: toolHint })
        return { capabilityId, provider: { mcpServerId: owner.mcpServerId, tool: toolHint }, confidence: 1.0 }
      }
    }

    // M1: 单 provider 直接返回（多 provider 返回第一个注册的，确定性）
    const provider = def.providers[0]
    const tool = provider.defaultTool || provider.tools[0]

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

  /**
   * 反向解析 toolName → { capabilityId, tool }。
   * 遍历 catalog 寻找定义该工具的 capability。
   * 未找到时返回 undefined。
   *
   * M5.5 D2: Memory identity 的唯一映射源。
   */
  resolveByTool(toolName: string): { capabilityId: string; tool: string } | undefined {
    for (const def of this.catalog.getCapabilities()) {
      if (def.providers.length === 0) continue
      for (const provider of def.providers) {
        if (provider.tools.includes(toolName)) {
          return { capabilityId: def.id, tool: toolName }
        }
      }
    }
    return undefined
  }
}

