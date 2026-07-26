import { log } from '../logger/Logger'
import type { CapabilityCatalog } from './CapabilityCatalog'

/**
 * CapabilitySchemaAdapter — Capability → LLM-readable text 的适配器。
 *
 * ADR-015 P1.1 Shadow Mode：
 * - 从 CapabilityCatalog 读取 capability 定义
 * - 生成 LLM 可读的文本块（CAPABILITY_CONTEXT）
 * - 不参与执行，不触发调用
 * - 仅用于 shadow 观测
 */
export class CapabilitySchemaAdapter {
  private catalog: CapabilityCatalog

  constructor(catalog: CapabilityCatalog) {
    this.catalog = catalog
  }

  /**
   * 构建 CAPABILITY_CONTEXT 文本块。
   * 格式示例：
   *
   * Available Capabilities:
   * - publishing
   *   Publish content to external platforms.
   *   Providers: fanqie
   *
   * - content.drafting
   *   Create and manage content drafts.
   *   Providers: fanqie
   */
  buildContext(): string {
    const capabilities = this.catalog.getCapabilities()
    if (capabilities.length === 0) return ''

    const lines: string[] = ['Available Capabilities:']
    for (const cap of capabilities) {
      lines.push(`- ${cap.id}`)
      lines.push(`  ${cap.description !== cap.id ? cap.description : ''}`)
      const providerNames = cap.providers.map((p) => p.mcpServerId).join(', ')
      if (providerNames) {
        lines.push(`  Providers: ${providerNames}`)
      }
      // 在 shadow 阶段列出相关工具（旧名），帮助 LLM 理解映射
      const allTools = cap.providers.flatMap((p) => p.tools).filter(Boolean)
      if (allTools.length > 0) {
        lines.push(`  Related tools: ${allTools.join(', ')}`)
      }
    }

    const context = lines.filter((l) => l.trim()).join('\n')
    log('INFO', 'capability_schema_adapter.context_built', {
      capabilityCount: capabilities.length,
      contextLength: context.length,
    })
    return context
  }
}
