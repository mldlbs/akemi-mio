/**
 * StrategySelector — 通用策略选择器
 *
 * 实现 IStrategyProvider 接口，提供运行时策略选择能力。
 * 与 IPluginRegistry 结合使用：策略来源是注册表中的插件，
 * 选择器在注册表之上提供 getActive/setActive 抽象。
 *
 * 使用示例：
 *   const registry = SpeechPluginRegistry.getInstance()
 *   const selector = new StrategySelector(registry, 'whisper_gpu')
 *
 *   // 获取当前活跃引擎
 *   const engine = selector.getActive()
 *
 *   // 切换到百度引擎
 *   selector.setActive('baidu_asr')
 *
 * 降级策略示例：
 *   // 按优先级自动选择第一个可用的
 *   const autoSelector = new StrategySelector(registry)
 *   autoSelector.selectFirstAvailable()
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { IPlugin, IPluginRegistry, IStrategyProvider } from './types'

/**
 * 从插件注册表派生的策略选择器。
 *
 * @template TStrategy 策略类型，必须是 IPlugin 的子类型
 */
export class StrategySelector<TStrategy extends IPlugin> implements IStrategyProvider<TStrategy> {
  /** 插件注册表引用 */
  private registry: IPluginRegistry<TStrategy>
  /** 当前活跃策略名称 */
  private activeName: string | null = null

  /**
   * @param registry 已注册策略的插件注册表
   * @param defaultName 默认策略名称（可选，如不指定则选优先级最高的）
   */
  constructor(registry: IPluginRegistry<TStrategy>, defaultName?: string) {
    this.registry = registry
    if (defaultName && registry.has(defaultName)) {
      this.activeName = defaultName
    } else {
      // 无默认值则选优先级最高的插件
      const all = registry.getAll()
      if (all.length > 0) {
        this.activeName = all[0].manifest.name
      }
    }
  }

  getActive(): TStrategy | null {
    if (!this.activeName) return null
    return this.registry.get(this.activeName) ?? null
  }

  getAll(): TStrategy[] {
    return this.registry.getAll()
  }

  setActive(name: string): boolean {
    if (!this.registry.has(name)) {
      log('WARN', 'strategy_select_not_found', { name, available: this.registry.getAll().map((p) => p.manifest.name) })
      return false
    }
    const previous = this.activeName
    this.activeName = name
    log('INFO', 'strategy_selected', {
      from: previous,
      to: name,
    })
    return true
  }

  /**
   * 获取当前活跃策略名称。
   */
  getActiveName(): string | null {
    return this.activeName
  }

  /**
   * 自动选择第一个可用（已就绪）的策略。
   * 按优先级降序检查每个策略的 getStatus().ready。
   *
   * @returns 是否找到可用策略
   */
  selectFirstAvailable(): boolean {
    for (const plugin of this.registry.getAll()) {
      if (plugin.getStatus().ready) {
        this.activeName = plugin.manifest.name
        log('INFO', 'strategy_auto_selected', {
          name: plugin.manifest.name,
          priority: plugin.manifest.priority ?? 0,
        })
        return true
      }
    }
    // 没有可用策略但注册表非空时，保留当前选择
    if (this.registry.count > 0) {
      log('WARN', 'strategy_no_available', {
        active: this.activeName,
        total: this.registry.count,
      })
    }
    return false
  }

  /**
   * 重置为默认策略（优先级最高的插件）。
   */
  resetToDefault(): void {
    const all = this.registry.getAll()
    if (all.length > 0) {
      this.activeName = all[0].manifest.name
      log('INFO', 'strategy_reset_to_default', { name: this.activeName })
    }
  }
}
