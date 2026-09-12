/**
 * AgentPluginRegistry — Agent 插件运行时加载器（ServiceLoader 模式）
 *
 * 模式来源：
 * - src/main/core/patterns/ServiceRegistry — 通用服务注册表
 * - src/main/speech/SpeechPluginRegistry.ts — ASR/TTS 插件的 ServiceLoader 模式
 * - 迁移到 Agent 领域，适配 Agent 的认知管线（OTPAR）和运行时特性
 *
 * 职责：
 *   1. 维护 AgentPlugin 注册表
 *   2. 提供按能力（capability）发现插件的查询接口
 *   3. 管理插件的生命周期（initialize / onUnload）
 *
 * 设计意图：
 *   - 单例，全局唯一
 *   - 插件注册后由 registry 统一管理，AgentService 不直接持有插件引用
 *   - 新增认知阶段只需注册对应插件，无需修改核心服务
 *
 * 使用方式：
 *   const registry = AgentPluginRegistry.getInstance()
 *   registry.register(new ObserveStagePlugin())
 *   registry.register(new ThinkStagePlugin())
 *   await registry.loadAll()
 *   const stages = registry.getByCapability('cognitive_stage')
 *   // 按优先级排序使用
 *
 * 对照 SpeechPluginRegistry：
 *   - SpeechPluginRegistry: registerAsr(plugin) / registerTts(plugin)
 *   - AgentPluginRegistry: register(plugin) — 插件通过 manifest.capability 区分
 *   - SpeechPluginRegistry: getAsrPlugins() / getTtsPlugins()
 *   - AgentPluginRegistry: getByCapability(capability)
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { ServiceRegistry } from '@akemi-mio/core/core/patterns/ServiceRegistry'
import type { ServicePlugin } from '@akemi-mio/core/core/patterns/ServiceRegistry'
import type { AgentPlugin, AgentPluginManifest, AgentCapability, AgentPluginStatus } from './types'

/**
 * Agent 插件适配为 ServicePlugin 的包装器。
 * ServiceRegistry 只需 ServicePlugin 接口，通过此类型泛型参数建立连接。
 */
type AgentServicePlugin = ServicePlugin & AgentPlugin

/**
 * 能力读取器：从 AgentPlugin 的 manifest 中读取 capability（单个值）。
 */
function readAgentCapability(p: AgentServicePlugin): AgentCapability | undefined {
  return (p.manifest as AgentPluginManifest).capability
}

export class AgentPluginRegistry extends ServiceRegistry<AgentServicePlugin, AgentCapability> {
  private static instance: AgentPluginRegistry

  private constructor() {
    super('agent_plugin_registry')
    this.setCapabilityReader(readAgentCapability)
  }

  static getInstance(): AgentPluginRegistry {
    if (!AgentPluginRegistry.instance) {
      AgentPluginRegistry.instance = new AgentPluginRegistry()
    }
    return AgentPluginRegistry.instance
  }

  // ==================== Agent 扩展方法 ====================

  /**
   * 获取指定能力类型的所有插件，按优先级降序排列。
   *
   * @param capability 能力类型
   * @returns 匹配的插件列表
   */
  getPluginsByCapability(capability: AgentCapability): AgentServicePlugin[] {
    return this.getByCapability(capability).sort((a, b) => (b.manifest.priority ?? 0) - (a.manifest.priority ?? 0))
  }

  /**
   * 获取指定能力类型的第一个已初始化插件。
   *
   * @param capability 能力类型
   * @returns 匹配的插件，或 undefined
   */
  getFirstPlugin(capability: AgentCapability): AgentServicePlugin | undefined {
    return this.getPluginsByCapability(capability)[0]
  }

  /**
   * 获取指定插件状态。
   */
  getPluginStatus(name: string): AgentPluginStatus | null {
    const plugin = this.plugins.get(name)
    if (!plugin) return null
    return {
      registered: true,
      initialized: this.loaded,
      error: null,
    }
  }

  /**
   * 获取按能力分类的插件统计信息。
   */
  getStats(): {
    total: number
    byCapability: Record<string, number>
    plugins: AgentPluginManifest[]
  } {
    const baseStats = super.getStats()
    const byCapability: Record<string, number> = {}
    for (const plugin of this.plugins.values()) {
      const cap = (plugin.manifest as AgentPluginManifest).capability
      byCapability[cap] = (byCapability[cap] || 0) + 1
    }
    return {
      total: baseStats.total,
      byCapability,
      plugins: Array.from(this.plugins.values()).map((p) => p.manifest as AgentPluginManifest),
    }
  }
}

// =============================================================================
// 单例
// =============================================================================

/** 全局单例，供 AgentService 发现和管理 Agent 插件 */
export const agentPluginRegistry = AgentPluginRegistry.getInstance()
