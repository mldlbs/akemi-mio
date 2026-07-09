/**
 * WallpaperEventBridge — 壁纸事件总线桥接器
 *
 * 在 EventBus 的 Wallpaper 端提供标准化的事件发布能力：
 * 1. 监听从 UserBehaviorService / BehaviorStateMachine 发出的原始行为事件
 * 2. 转换为带版本号的标准 Wallpaper Schema 事件
 * 3. 监听 Plan:TypeScript 事件，维护壁纸侧的订阅数据
 *
 * Schema 版本约定：
 * - 所有 Wallpaper 事件 payload 包含 version 字段
 * - version=1: 初始架构，包含 mode、context、confidence、timestamp
 * - version 增加 = 新增必填字段（消费者必须检查 version 决定如何解析）
 * - 新增可选字段不 bump version（用 ? 标记）
 *
 * 使用示例：
 *   const bridge = new WallpaperEventBridge()
 *   bridge.start(monitoringService)
 *   // bridge 自动订阅并转发事件
 *   bridge.stop()
 */

import { log } from '../logger/Logger'
import { eventBus, SubscriptionTracker } from '../core/EventBus'
import type { EventPayload } from '../core/EventBus'
import { MonitoringService } from '../monitoring/MonitoringService'

// =============================================================================
// 常量
// =============================================================================

/** 当前 Wallpaper Schema 版本 */
export const WALLPAPER_SCHEMA_VERSION = 1

/** 当前 Plan Schema 版本 */
export const PLAN_SCHEMA_VERSION = 1

// =============================================================================
// 类型：Schema 版本检查工具
// =============================================================================

/**
 * 检查事件 payload 的 version 字段是否匹配预期版本。
 * 用于 Schema 演进兼容性检查：
 * - 消费者先检查 version，再决定如何解析 payload
 * - version 低于预期 = 旧格式，使用默认值填充新字段
 * - version 高于预期 = 新格式，消费者只消费自己认识的字段
 */
export function checkSchemaVersion(
  actualVersion: number,
  expectedVersion: number,
  eventName: string,
): 'exact' | 'ahead' | 'behind' {
  if (actualVersion === expectedVersion) return 'exact'
  if (actualVersion > expectedVersion) {
    log('DEBUG', 'schema_version_ahead', { event: eventName, actual: actualVersion, expected: expectedVersion })
    return 'ahead'
  }
  log('DEBUG', 'schema_version_behind', { event: eventName, actual: actualVersion, expected: expectedVersion })
  return 'behind'
}

// =============================================================================
// WallpaperEventBridge
// =============================================================================

export class WallpaperEventBridge {
  private subs = new SubscriptionTracker()
  private monitoringService: MonitoringService | null = null
  /** 缓存上次壁纸模式，用于去重 */
  private lastMode: string | null = null
  /** 缓存上次锁定状态，用于去重 */
  private lastLocked: boolean | null = null
  private _started = false

  /** 是否已启动 */
  get started(): boolean {
    return this._started
  }

  /**
   * 启动桥接器。
   * 在 AppRuntime 中所有依赖服务就绪后调用。
   */
  start(monitoringService?: MonitoringService): void {
    if (this._started) return
    this._started = true

    if (monitoringService) {
      this.monitoringService = monitoringService
    }

    this.subscribeBehaviorEvents()
    this.subscribePlanEvents()

    log('INFO', 'wallpaper_event_bridge_started')
  }

  /** 停止桥接器，清理所有订阅 */
  stop(): void {
    this.subs.dispose()
    this._started = false
    this.lastMode = null
    this.lastLocked = null
    log('INFO', 'wallpaper_event_bridge_stopped')
  }

  // ==================== 从原始事件转发为 Wallpaper Schema 事件 ====================

  /**
   * 订阅 UserBehaviorService 发出的原始 behavior 事件，
   * 转换为带版本号的标准 wallpaper.mode.changed 事件。
   */
  private subscribeBehaviorEvents(): void {
    // ── behavior.state.updated → 检测模式变化 → wallpaper.mode.changed ──
    eventBus.track(
      'behavior.state.updated' as any,
      (raw: any) => {
        // 从原始 payload 提取模式信息
        const activityState: string = raw.activityState ?? 'active'
        const fullscreen: boolean = raw.fullscreen ?? false
        const appCategory: string = raw.appCategory ?? 'other'
        const focused: boolean = raw.focused ?? true
        const idleTimeMs: number = raw.idleTimeMs ?? 0

        // 推断行为模式（与 BehaviorStateMachine 逻辑一致）
        const mode = this.inferBehaviorMode(activityState, fullscreen, appCategory, idleTimeMs, focused)
        const context = this.inferActivityContext(activityState, appCategory, mode)
        const confidence = mode === 'break' && idleTimeMs > 60_000 ? 0.9 : 0.7

        // 去重：模式没有变化则跳过
        const modeKey = `${mode}:${context}`
        if (modeKey === this.lastMode) return
        this.lastMode = modeKey

        // 发射版本化事件
        eventBus.emit('wallpaper.mode.changed', {
          version: WALLPAPER_SCHEMA_VERSION,
          mode,
          context,
          confidence,
          timestamp: Date.now(),
        })
      },
      this.subs,
      'wpeb:behavior_state',
    )

    // ── behavior.mode.switch → wallpaper.mode.changed ──
    // 双模系统切换时也发射壁纸模式事件
    eventBus.track(
      'behavior.mode.switch' as any,
      (raw: any) => {
        const mode = raw.toMode === 'plan-typescript' ? 'focus' : 'multitasking'
        const context: 'coding' | 'browsing' | 'resting' =
          mode === 'focus' ? 'coding' : 'browsing'
        const confidence = raw.confidence ?? 0.8

        const modeKey = `${mode}:${context}`
        if (modeKey === this.lastMode) return
        this.lastMode = modeKey

        eventBus.emit('wallpaper.mode.changed', {
          version: WALLPAPER_SCHEMA_VERSION,
          mode,
          context,
          confidence,
          timestamp: Date.now(),
        })
      },
      this.subs,
      'wpeb:mode_switch',
    )
  }

  /**
   * 订阅 Plan:TypeScript 事件，传递给壁纸监控系统。
   */
  private subscribePlanEvents(): void {
    // ── plan.ts.step.completed → 推送给壁纸监控系统 ──
    eventBus.track(
      'plan.ts.step.completed' as any,
      (payload: any) => {
        this.onPlanStepCompleted(payload)
      },
      this.subs,
      'wpeb:plan_step',
    )

    // ── plan.ts.progress.updated → 推送给壁纸监控系统 ──
    eventBus.track(
      'plan.ts.progress.updated' as any,
      (payload: any) => {
        this.onPlanProgressUpdated(payload)
      },
      this.subs,
      'wpeb:plan_progress',
    )

    // ── plan.ts.focus.synced → 推送给壁纸监控系统 ──
    eventBus.track(
      'plan.ts.focus.synced' as any,
      (payload: any) => {
        log('INFO', 'wpeb_plan_focus_synced', {
          focusCategories: payload.focusCategories?.slice(0, 3),
          version: payload.version,
        })
      },
      this.subs,
      'wpeb:plan_focus',
    )
  }

  // ==================== Plan 事件处理 ====================

  /**
   * 处理学习步骤完成事件：更新监控数据中的计划进度。
   * Schema 版本检查确保兼容性。
   */
  private onPlanStepCompleted(payload: any): void {
    const versionCheck = checkSchemaVersion(
      payload.version ?? 0,
      PLAN_SCHEMA_VERSION,
      'plan.ts.step.completed',
    )

    if (versionCheck === 'behind') {
      // 旧版本 Schema — 使用备选字段名
      const stepDescription = payload.stepDescription ?? payload.step ?? payload.description ?? ''
      const success = payload.success ?? true
      log('INFO', 'wpeb_plan_step_legacy_schema', { stepDescription: stepDescription.slice(0, 40), success })
    } else {
      // 当前或新版本 Schema — 标准解析
      log('DEBUG', 'wpeb_plan_step_completed', {
        success: payload.success,
        concepts: payload.concepts?.slice(0, 3),
        version: payload.version,
      })
    }
  }

  /**
   * 处理学习进度更新事件。
   */
  private onPlanProgressUpdated(payload: any): void {
    const versionCheck = checkSchemaVersion(
      payload.version ?? 0,
      PLAN_SCHEMA_VERSION,
      'plan.ts.progress.updated',
    )

    if (versionCheck !== 'behind') {
      log('DEBUG', 'wpeb_plan_progress', {
        mastery: Math.round(payload.overallMastery * 100) + '%',
        mastered: `${payload.masteredCount}/${payload.totalItems}`,
      })
    }
  }

  // ==================== 推断方法 ====================

  /**
   * 从行为状态推断壁纸模式。
   * 与 BehaviorStateMachine 的 computeMode 对齐但更轻量。
   */
  private inferBehaviorMode(
    activityState: string,
    fullscreen: boolean,
    appCategory: string,
    idleTimeMs: number,
    focused: boolean,
  ): 'focus' | 'multitasking' | 'break' {
    if (idleTimeMs >= 300_000) return 'break'
    if (activityState === 'idle' || activityState === 'away') return 'break'
    if (fullscreen || (appCategory === 'code' && focused)) return 'focus'
    if (appCategory === 'media') return 'break'
    return 'multitasking'
  }

  /**
   * 从行为状态推断活动情境。
   * 与 UserBehaviorService.detectActivityContext 逻辑一致。
   */
  private inferActivityContext(
    activityState: string,
    appCategory: string,
    mode: string,
  ): 'coding' | 'browsing' | 'resting' {
    if (activityState === 'idle' || activityState === 'away' || mode === 'break') {
      return 'resting'
    }
    if (appCategory === 'code') return 'coding'
    if (appCategory === 'browser' || appCategory === 'media' || appCategory === 'communication') {
      return 'browsing'
    }
    return 'resting'
  }
}
