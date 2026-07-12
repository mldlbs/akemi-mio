/**
 * UserBehaviorPluginAdapter — UserBehavior 作为 Wallpaper 插件的适配器
 *
 * 将 UserBehaviorService 适配为 IWallpaperPlugin 契约。
 * UserBehavior 通过此适配器向 Wallpaper 提供行为数据，
 * 不涉及 Wallpaper 的内部调度逻辑。
 *
 * ── 职责边界 ──
 * UserBehavior 端：
 *   - 追踪窗口焦点、空闲状态、应用类别
 *   - 计算行为模式（focus / multitasking / break）
 *   - 计算活动情境（coding / browsing / resting）
 *   - 发布增强行为状态到渲染进程
 *
 * 本适配器：
 *   - 将 UserBehaviorService 的 EnrichedBehaviorState 转换为 WallpaperBehaviorSnapshot
 *   - 订阅 EventBus 'behavior.state.updated' 事件并转发给插件消费者
 *   - 注册到 WallpaperPluginRegistry 供 Wallpaper 系统发现
 *
 * ── 可测试性 ──
 * 测试时可通过构造 mock 对象（只需 duck-typed getEnrichedState + markActive）
 * 来测试适配器的转换逻辑，无需实例化完整的 UserBehaviorService。
 *
 * ── 松耦合 ──
 * 构造函数接受 duck-typed 接口而非具体类，
 * 适配器与 UserBehaviorService 之间无 import 依赖。
 */

import { log } from '../../logger/Logger'
import { eventBus } from '../../core/EventBus'
import type { IWallpaperPlugin, WallpaperPluginManifest, IBehaviorProvider, WallpaperBehaviorSnapshot } from './types'

// ═══════════════════════════════════════════════════
//  IBehaviorProvider 的 UserBehavior 实现
// ═══════════════════════════════════════════════════

/**
 * BehaviorProviderImpl — IBehaviorProvider 的实际实现。
 *
 * 内部类，不对外暴露实现细节。
 * 通过 duck typing 松耦合地访问 UserBehaviorService。
 */
class BehaviorProviderImpl implements IBehaviorProvider {
  readonly name = 'user-behavior'

  /**
   * 被包装的行为服务引用。
   * 使用 duck-typed 接口而非具体类型，实现松耦合。
   */
  private behavior: {
    getEnrichedState(): {
      mode: string
      context: string
      activityState: string
      appCategory: string
      fullscreen: boolean
      focused: boolean
      idleTimeMs: number
      modeDurationMs: number
      confidence: number
    }
    markActive(): void
  }

  /** 订阅者集合 */
  private subscribers = new Set<(snapshot: WallpaperBehaviorSnapshot) => void>()

  constructor(behavior: {
    getEnrichedState(): {
      mode: string
      context: string
      activityState: string
      appCategory: string
      fullscreen: boolean
      focused: boolean
      idleTimeMs: number
      modeDurationMs: number
      confidence: number
    }
    markActive(): void
  }) {
    this.behavior = behavior
  }

  getBehaviorSnapshot(): WallpaperBehaviorSnapshot | null {
    try {
      const enriched = this.behavior.getEnrichedState()
      if (!enriched) return null
      return this.toSnapshot(enriched)
    } catch {
      return null
    }
  }

  onBehaviorChange(callback: (snapshot: WallpaperBehaviorSnapshot) => void): () => void {
    this.subscribers.add(callback)
    return () => this.subscribers.delete(callback)
  }

  markActive(): void {
    this.behavior.markActive()
  }

  // ── 内部方法 ──

  /** 推送给所有订阅者 */
  notify(snapshot: WallpaperBehaviorSnapshot): void {
    for (const cb of this.subscribers) {
      try {
        cb(snapshot)
      } catch {
        // 单个订阅者失败不影响其他订阅者
      }
    }
  }

  /** 将 UserBehavior 的 EnrichedBehaviorState 转换为标准 WallpaperBehaviorSnapshot */
  private toSnapshot(enriched: {
    mode: string
    context: string
    activityState: string
    appCategory: string
    fullscreen: boolean
    focused: boolean
    idleTimeMs: number
    modeDurationMs: number
    confidence: number
  }): WallpaperBehaviorSnapshot {
    return {
      mode: this.normalizeMode(enriched.mode),
      context: this.normalizeContext(enriched.context),
      activityState: this.normalizeActivityState(enriched.activityState),
      appCategory: enriched.appCategory ?? 'other',
      fullscreen: enriched.fullscreen ?? false,
      focused: enriched.focused ?? true,
      idleTimeMs: enriched.idleTimeMs ?? 0,
      modeDurationMs: enriched.modeDurationMs ?? 0,
      confidence: enriched.confidence ?? 0.5,
      timestamp: Date.now(),
    }
  }

  private normalizeMode(mode: string): WallpaperBehaviorSnapshot['mode'] {
    if (mode === 'focus' || mode === 'multitasking' || mode === 'break') return mode
    return 'focus'
  }

  private normalizeContext(context: string): WallpaperBehaviorSnapshot['context'] {
    if (context === 'coding' || context === 'browsing' || context === 'resting') return context
    return 'resting'
  }

  private normalizeActivityState(activityState: string): WallpaperBehaviorSnapshot['activityState'] {
    if (activityState === 'active' || activityState === 'idle' || activityState === 'away') return activityState
    return 'active'
  }
}

// ═══════════════════════════════════════════════════
//  UserBehaviorPluginAdapter
// ═══════════════════════════════════════════════════

/**
 * UserBehaviorPluginAdapter — 实现 IWallpaperPlugin 契约。
 *
 * 构造方式：
 *   const adapter = new UserBehaviorPluginAdapter(userBehaviorService)
 *   WallpaperPluginRegistry.getInstance().register(adapter)
 *   await WallpaperPluginRegistry.getInstance().loadAll()
 */
export class UserBehaviorPluginAdapter implements IWallpaperPlugin {
  readonly manifest: WallpaperPluginManifest = {
    name: 'user-behavior',
    version: '1.0.0',
    description: 'UserBehavior 行为状态提供者 — 窗口焦点、空闲检测、行为模式',
    capabilities: ['behavior_provider'],
  }

  /** 行为提供者实现 */
  readonly behaviorProvider: BehaviorProviderImpl

  /** EventBus 订阅清理函数 */
  private unsubEvent: (() => void) | null = null

  constructor(behavior: {
    getEnrichedState(): {
      mode: string
      context: string
      activityState: string
      appCategory: string
      fullscreen: boolean
      focused: boolean
      idleTimeMs: number
      modeDurationMs: number
      confidence: number
    }
    markActive(): void
  }) {
    this.behaviorProvider = new BehaviorProviderImpl(behavior)
  }

  async onLoad(): Promise<void> {
    // 订阅 EventBus，当 UserBehavior 状态更新时通过插件契约通知消费者
    this.unsubEvent = eventBus.on(
      'behavior.state.updated' as any,
      () => {
        const snapshot = this.behaviorProvider.getBehaviorSnapshot()
        if (snapshot) {
          this.behaviorProvider.notify(snapshot)
        }
      },
    )
    log('INFO', 'user_behavior_wallpaper_plugin_loaded')
  }

  async onUnload(): Promise<void> {
    if (this.unsubEvent) {
      this.unsubEvent()
      this.unsubEvent = null
    }
    log('INFO', 'user_behavior_wallpaper_plugin_unloaded')
  }
}
