/**
 * PluginServiceLoader — Evolution 插件运行时加载器（ServiceLoader 模式）
 *
 * 职责：
 *   1. 维护 EvolutionPlugin 注册表
 *   2. 提供按能力（capability）发现插件的查询接口
 *   3. 管理插件的生命周期（onLoad / onUnload）
 *
 * 使用方式：
 *   const loader = PluginServiceLoader.getInstance()
 *   loader.register(new WallpaperPlugin(projectRoot))
 *   await loader.loadAll()
 *   const collectors = loader.getByCapability('collect')
 *
 * 设计意图：
 *   - 单例，全局唯一
 *   - 插件注册后由 loader 统一管理，Evolution 系统不直接持有插件引用
 *   - PipelineOrchestrator 通过 PluginCollectorAdapter/PluginExecutorAdapter 消费插件
 *
 * 模式来源：
 * - src/main/core/patterns/ServiceRegistry — 通用服务注册表
 * - 与 AgentPluginRegistry 共享同一核心实现
 */

import { ServiceRegistry } from '@akemi-mio/core/core/patterns/ServiceRegistry'
import type { EvolutionPlugin, EvolutionCapability } from './types'

/**
 * 能力读取器：从 EvolutionPlugin 的 manifest 中读取 capabilities（数组）。
 */
function readEvolutionCapability(p: EvolutionPlugin): EvolutionCapability[] {
  return p.manifest.capabilities
}

export class PluginServiceLoader extends ServiceRegistry<EvolutionPlugin, EvolutionCapability> {
  private static instance: PluginServiceLoader

  private constructor() {
    super('evolution_plugin')
    this.setCapabilityReader(readEvolutionCapability)
  }

  static getInstance(): PluginServiceLoader {
    if (!PluginServiceLoader.instance) {
      PluginServiceLoader.instance = new PluginServiceLoader()
    }
    return PluginServiceLoader.instance
  }
}
