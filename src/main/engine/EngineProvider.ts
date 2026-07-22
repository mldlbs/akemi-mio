/**
 * EngineProvider — IEngineStrategyProvider 默认实现
 *
 * 管理多个 IEngineService 实例的注册、发现和运行时策略选择。
 * 调用方通过 IEngineStrategyProvider 接口获取统一引擎服务，
 * 无需了解底层是 AgentService 还是 PiperOrchestrator。
 *
 * 设计：
 * - 内部使用 Map 存储引擎实例，名称即引擎的 name 属性
 * - 支持单引擎提供（无需主动 setActive）和多重引擎选择
 * - 活跃引擎默认为首注册的引擎，可通过 setActive 切换
 * - 与 ServiceRegistry 模式兼容：提供的 onRegister/onUnregister
 *   回调可在引擎注册时进行额外的初始化/清理
 *
 * 使用示例：
 *   const provider = new EngineProvider()
 *   provider.register(agentService)      // name='agent'
 *   provider.register(piperOrchestrator) // name='piper-tts'
 *
 *   // 查询所有引擎（统一抽象，不暴露具体类型）
 *   const engines = provider.getAll()
 *   for (const e of engines) {
 *     console.log(`${e.name}: ${e.getStatus().state}`)
 *   }
 *
 *   // 获取 Agent 引擎状态
 *   const agent = provider.getActive()
 *   if (agent) { console.log(agent.getInfo()) }
 *
 *   // 切换到 PiperTTS
 *   provider.setActive('piper-tts')
 *
 * 与 IStrategyProvider<IEngineService> 的兼容性：
 * - getActive/getAll/setActive 签名完全一致
 * - 可在需要 IStrategyProvider<IEngineService> 的地方传入本实例
 */

import { log } from '../logger/Logger'
import type { IEngineService, IEngineStrategyProvider } from './types'

/**
 * 引擎策略提供者 — 在运行时选择具体引擎实现。
 *
 * 实现 IEngineStrategyProvider 接口（engine/types.ts），
 * 内部使用 Map<string, IEngineService> 管理引擎实例。
 *
 * 线程安全注意：注册/注销应在启动阶段完成，运行时不频繁变更。
 * 非线程安全，不适合在多个 IPC handler 中并发修改注册表。
 */
export class EngineProvider implements IEngineStrategyProvider {
  /** 已注册的引擎实例（name → engine） */
  private readonly engines = new Map<string, IEngineService>()

  /** 当前活跃引擎的名称 */
  private activeName: string | null = null

  /**
   * @param defaultName 默认活跃引擎名称（可选）
   *                    不指定时以首个注册的引擎为活跃引擎
   */
  constructor(defaultName?: string) {
    this.activeName = defaultName ?? null
  }

  // ══════════════════════════════════════════
  //  IEngineStrategyProvider 实现
  // ══════════════════════════════════════════

  /**
   * 获取当前活跃的引擎实例。
   * @returns 当前引擎，无可用引擎时返回 null
   */
  getActive(): IEngineService | null {
    if (!this.activeName) return null
    return this.engines.get(this.activeName) ?? null
  }

  /**
   * 获取所有已注册的引擎实例。
   * @returns 全部引擎实例列表（按注册顺序）
   */
  getAll(): IEngineService[] {
    return Array.from(this.engines.values())
  }

  /**
   * 设置活跃引擎。
   * @param name 引擎名称（对应 IEngineService.name 属性）
   * @returns 是否设置成功
   */
  setActive(name: string): boolean {
    if (!this.engines.has(name)) {
      log('WARN', 'engine_provider_set_active_not_found', {
        name,
        available: Array.from(this.engines.keys()),
      })
      return false
    }
    const previous = this.activeName
    this.activeName = name
    log('INFO', 'engine_provider_set_active', {
      from: previous,
      to: name,
    })
    return true
  }

  // ══════════════════════════════════════════
  //  注册表管理方法
  // ══════════════════════════════════════════

  /**
   * 注册一个引擎到提供者。
   * 同名引擎只能注册一次，重复注册会打印警告并跳过。
   * 首次注册的引擎自动成为活跃引擎（若未设置默认值）。
   *
   * @param engine 引擎实例（必须实现了 IEngineService）
   * @param options 可选配置
   */
  register(
    engine: IEngineService,
    options?: { skipIfExists?: boolean },
  ): void {
    const name = engine.name
    if (this.engines.has(name)) {
      if (options?.skipIfExists ?? true) {
        log('WARN', 'engine_provider_already_registered', { name })
        return
      }
      // skipIfExists=false 时替换已有引擎（谨慎使用）
      log('WARN', 'engine_provider_replace', { name })
    }

    this.engines.set(name, engine)

    // 首次注册或当前活跃引擎不存在时设为活跃
    if (!this.activeName || !this.engines.has(this.activeName)) {
      this.activeName = name
    }

    log('INFO', 'engine_provider_registered', {
      name,
      total: this.engines.size,
    })
  }

  /**
   * 注销指定名称的引擎。
   * 如果注销的是当前活跃引擎，迁移到下一个可用引擎。
   *
   * @param name 引擎名称
   * @returns 是否成功注销
   */
  unregister(name: string): boolean {
    const engine = this.engines.get(name)
    if (!engine) return false

    this.engines.delete(name)

    // 如果注销的是当前活跃引擎，将活跃引擎迁移到第一个可用引擎
    if (this.activeName === name) {
      const remaining = Array.from(this.engines.keys())
      this.activeName = remaining.length > 0 ? remaining[0] : null
      log('INFO', 'engine_provider_active_migrated', {
        from: name,
        to: this.activeName ?? '(none)',
      })
    }

    log('INFO', 'engine_provider_unregistered', {
      name,
      total: this.engines.size,
    })
    return true
  }

  /**
   * 检查指定名称的引擎是否已注册。
   */
  has(name: string): boolean {
    return this.engines.has(name)
  }

  /**
   * 获取当前活跃引擎的名称。
   */
  getActiveName(): string | null {
    return this.activeName
  }

  /**
   * 获取注册的引擎数量。
   */
  get count(): number {
    return this.engines.size
  }

  /**
   * 按名称获取引擎实例。
   * @param name 引擎名称
   * @returns 引擎实例，未找到时返回 undefined
   */
  get(name: string): IEngineService | undefined {
    return this.engines.get(name)
  }

  /**
   * 重置到默认引擎（第一个注册的引擎）。
   */
  resetToDefault(): void {
    const all = Array.from(this.engines.keys())
    if (all.length > 0) {
      this.activeName = all[0]
      log('INFO', 'engine_provider_reset_to_default', {
        name: this.activeName,
      })
    }
  }
}

/**
 * 全局引擎策略提供者单例。
 *
 * 在 AppRuntime.start() 中完成引擎注册：
 *    engineProvider.register(agentService)       // name='agent'
 *    engineProvider.register(piperOrchestrator)   // name='piper-tts'
 *
 * 调用方通过此单例获取统一引擎服务：
 *    import { engineProvider } from '../engine'
 *    const engines = engineProvider.getAll()
 *    for (const e of engines) {
 *      const status = e.getStatus()
 *      console.log(`${status.name}: ${status.state}`)
 *    }
 */
export const engineProvider = new EngineProvider()
