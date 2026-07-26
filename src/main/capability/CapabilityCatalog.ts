import { log } from '../logger/Logger'
import type { MCPRegistry } from '../mcp/MCPRegistry'
import { CapabilityDefinition, CapabilityProvider, ResolveResult } from './types'

/**
 * CapabilityCatalog — 语义 Capability 索引。
 *
 * 从 MCPRegistry 中的 manifest.capabilities 构建内存索引。
 * 不负责持久化（Registry 负责）。Registry 变化时重建。
 *
 * ADR-015 C-2：Catalog 只持有内存索引。
 * ADR-015 C-4：Manifest capabilities 字段是权威来源。
 */
export class CapabilityCatalog {
  private capabilities = new Map<string, CapabilityDefinition>()
  private registry: MCPRegistry
  private built = false

  constructor(registry: MCPRegistry) {
    this.registry = registry
  }

  /** 从 Registry 重建索引 */
  rebuild(): void {
    this.capabilities.clear()
    const manifests = this.registry.list()

    for (const manifest of manifests) {
      // 在 manifest 启用前，先创建一次 catalog，然后为每 capability 映射
      for (const capId of manifest.capabilities) {
        let def = this.capabilities.get(capId)
        if (!def) {
          def = {
            id: capId,
            description: capId,
            // P1.3a: M1 阶段用通用 inputSchema（非空，满足 C-8）
            inputSchema: {
              type: 'object',
              properties: {
                description: {
                  type: 'string',
                  description: `What you want "${capId}" to do. Describe the task or provide specific parameters.`,
                },
              },
              required: ['description'],
            },
            providers: [],
          }
          this.capabilities.set(capId, def)
        }

        // 收集该 manifest 中对应此 capability 的工具
        // 暂时没有明确的 capId→toolName 映射，默认用 manifest 的全部工具
        const tools = manifest.dependencies
          ?.filter((d) => d.capability === capId)
          ?.map((d) => d.capability) ?? [capId]

        // 如果没有依赖映射，使用 Manifest 的 id 作为工具名近似
        const provider: CapabilityProvider = {
          mcpServerId: manifest.id,
          tools: tools.length > 0 ? tools : manifest.capabilities.length === 1 ? [manifest.id] : [],
          defaultTool: tools[0] || manifest.id,
        }
        def.providers.push(provider)
      }
    }

    this.built = true
    log('INFO', 'capability_catalog.rebuilt', { count: this.capabilities.size })
  }

  /** 获取所有语义 Capability */
  getCapabilities(): CapabilityDefinition[] {
    if (!this.built) this.rebuild()
    return Array.from(this.capabilities.values())
  }

  /** 获取单个 Capability */
  get(id: string): CapabilityDefinition | undefined {
    if (!this.built) this.rebuild()
    return this.capabilities.get(id)
  }

  /** 获取某个 capability 的所有 provider */
  getProviders(id: string): CapabilityProvider[] {
    return this.get(id)?.providers ?? []
  }

  /** 检查 capability 是否存在 */
  has(id: string): boolean {
    if (!this.built) this.rebuild()
    return this.capabilities.has(id)
  }
}
