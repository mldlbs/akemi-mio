/**
 * WallpaperToolBridge — MCP × Wallpaper 统一接口层
 *
 * 将 Wallpaper 的行为状态与 MCP 工具执行系统双向连接：
 *
 * ── 数据流 ──
 *   Wallpaper → MCP:
 *     Wallpaper 的行为模式 (focus/multitasking/break) 作为 MCP 工具的上下文输入，
 *     工具可根据当前模式调整行为（如 break 模式自动跳过非关键操作）。
 *
 *   MCP → Wallpaper:
 *     MCP 工具执行事件 (agent.tool.*) 反向驱动 Wallpaper 的行为调整，
 *     如工具连续失败 → Wallpaper 提示告警状态，高频率工具调用 → Wallpaper 叠加层简化为专注模式。
 *
 * ── 使用方式 ──
 *   // MCP 工具端 — 通过 deps.ts 获取上下文
 *   const ctx = wallpaperToolBridge.getToolContext()
 *   if (ctx.mode === 'break') { /* 减少打扰 */ }
 *
 *   // Wallpaper 端 — 自动订阅 tool 事件
 *   // bridge 启动后自动监听 agent.tool.* 事件并更新内部状态
 *
 * ── 架构关系 ──
 *   EventBus"agent.tool.*" ──→ WallpaperToolBridge ──→ Wallpaper 行为调整
 *   EventBus"wallpaper.mode.changed" ──→ WallpaperToolBridge ──→ MCP 工具上下文
 *
 * @see WallpaperEventBridge — 处理行为→壁纸事件的另一桥接器
 * @see WallpaperBehaviorSnapshot — Wallpaper 行为快照类型
 */

import { log } from '../logger/Logger'
import { eventBus, SubscriptionTracker } from '../core/EventBus'

// ════════════════════════════════════════════════════════════
//  类型定义
// ════════════════════════════════════════════════════════════

/** Wallpaper 模式 */
export type WallpaperMode = 'focus' | 'multitasking' | 'break'

/** Wallpaper 情境 */
export type WallpaperContext = 'coding' | 'browsing' | 'resting'

/** Wallpaper 活动状态 */
export type WallpaperActivityState = 'active' | 'idle' | 'away'

/** 告警级别 */
export type ToolAlertLevel = 'normal' | 'warning' | 'error'

/** MCP 工具活动快照 */
export interface ToolActivitySnapshot {
  /** 最后调用的工具名称 */
  lastToolName: string | null
  /** 最后调用时间戳 */
  lastToolTime: number
  /** 过去 60 秒内工具失败次数 */
  toolFailuresLastMinute: number
  /** 过去 60 秒内工具成功次数 */
  toolSuccessCount: number
  /** 过去 60 秒内工具调用总次数 */
  toolCallCount: number
  /** 连续失败次数（未重置） */
  consecutiveFailures: number
  /** 失败率（0-1） */
  failureRate: number
}

/** MCP 工具可查询的完整上下文 */
export interface WallpaperToolContext {
  /** Wallpaper 行为模式 */
  mode: WallpaperMode
  /** Wallpaper 活动情境 */
  context: WallpaperContext
  /** 行为置信度 (0-1) */
  confidence: number
  /** 活动状态 */
  activityState: WallpaperActivityState
  /** MCP 工具活动快照 */
  toolActivity: ToolActivitySnapshot
  /** 综合告警级别 */
  alertLevel: ToolAlertLevel
  /** 推荐的叠加层强度 (0=隐藏, 1=全显)，供工具决策参考 */
  recommendedOverlayIntensity: number
  /** 时间戳 */
  timestamp: number
}

/** WallpaperToolBridge 状态变化事件负载 */
export interface WallpaperToolBridgeEvent {
  /** 变化类型 */
  changeType: 'mode_changed' | 'tool_activity' | 'alert_level'
  /** 当前上下文快照 */
  context: WallpaperToolContext
  /** 变化描述 */
  description: string
  /** 时间戳 */
  timestamp: number
}

// ════════════════════════════════════════════════════════════
//  常量
// ════════════════════════════════════════════════════════════

/** 工具活动统计的时间窗口（毫秒） */
const ACTIVITY_WINDOW_MS = 60_000

/** 连续失败告警阈值 */
const CONSECUTIVE_FAILURE_WARNING = 3
const CONSECUTIVE_FAILURE_ERROR = 5

/** 工具失败率告警阈值 */
const FAILURE_RATE_WARNING = 0.4
const FAILURE_RATE_ERROR = 0.6

// ════════════════════════════════════════════════════════════
//  WallpaperToolBridge
// ════════════════════════════════════════════════════════════

export class WallpaperToolBridge {
  private static instance: WallpaperToolBridge
  private subs = new SubscriptionTracker()
  private _started = false

  // Wallpaper 状态
  private mode: WallpaperMode = 'focus'
  private context: WallpaperContext = 'coding'
  private activityState: WallpaperActivityState = 'active'
  private confidence = 0.7

  // MCP 工具活动追踪
  private toolEvents: Array<{ name: string; success: boolean; time: number }> = []
  private consecutiveFailures = 0
  private lastToolName: string | null = null
  private lastToolTime = 0

  /** 是否已启动 */
  get started(): boolean {
    return this._started
  }

  // ══════════════════════════════════════════════════════════
  //  单例
  // ══════════════════════════════════════════════════════════

  static getInstance(): WallpaperToolBridge {
    if (!WallpaperToolBridge.instance) {
      WallpaperToolBridge.instance = new WallpaperToolBridge()
    }
    return WallpaperToolBridge.instance
  }

  // ══════════════════════════════════════════════════════════
  //  生命周期
  // ══════════════════════════════════════════════════════════

  /**
   * 启动桥接器。
   * 订阅 Wallpaper 模式变化事件和 MCP 工具执行事件。
   */
  start(): void {
    if (this._started) return
    this._started = true

    // 订阅 Wallpaper 模式变化
    eventBus.track(
      'wallpaper.mode.changed' as any,
      (payload: any) => {
        this.mode = payload.mode ?? this.mode
        this.context = payload.context ?? this.context
        this.confidence = payload.confidence ?? this.confidence
        log('DEBUG', 'wptb_wallpaper_mode_updated', { mode: this.mode, context: this.context })
      },
      this.subs,
      'wptb:wallpaper_mode',
    )

    // 订阅 MCP 工具调用事件
    eventBus.track(
      'agent.tool.invoked' as any,
      (payload: any) => {
        this.lastToolName = payload.tool ?? null
        this.lastToolTime = Date.now()
      },
      this.subs,
      'wptb:tool_invoked',
    )

    // 订阅 MCP 工具完成事件
    eventBus.track(
      'agent.tool.completed' as any,
      (payload: any) => {
        this.recordToolEvent(payload.tool ?? 'unknown', true)
      },
      this.subs,
      'wptb:tool_completed',
    )

    // 订阅 MCP 工具失败事件
    eventBus.track(
      'agent.tool.failed' as any,
      (payload: any) => {
        this.recordToolEvent(payload.tool ?? 'unknown', false)
      },
      this.subs,
      'wptb:tool_failed',
    )

    log('INFO', 'wallpaper_tool_bridge_started')
  }

  /** 停止桥接器，清理所有订阅 */
  stop(): void {
    this.subs.dispose()
    this._started = false
    this.toolEvents = []
    this.consecutiveFailures = 0
    log('INFO', 'wallpaper_tool_bridge_stopped')
  }

  // ══════════════════════════════════════════════════════════
  //  公共查询接口 — MCP 工具使用
  // ══════════════════════════════════════════════════════════

  /**
   * 获取当前 Wallpaper × MCP 上下文快照。
   * MCP 工具通过此方法获取 Wallpaper 状态和自身活动统计的融合视图。
   */
  getToolContext(): WallpaperToolContext {
    const toolActivity = this.computeToolActivity()
    return {
      mode: this.mode,
      context: this.context,
      confidence: this.confidence,
      activityState: this.activityState,
      toolActivity,
      alertLevel: this.computeAlertLevel(toolActivity),
      recommendedOverlayIntensity: this.computeRecommendedIntensity(),
      timestamp: Date.now(),
    }
  }

  /**
   * 获取建议的工具适配行为。
   * 工具可在执行前调用此方法决定是否需要调整行为。
   */
  getToolAdaptation(): {
    /** 是否建议跳过当前操作（如 break 模式下非关键任务） */
    shouldSkipNonCritical: boolean
    /** 是否建议降低操作频率 */
    shouldThrottle: boolean
    /** 是否建议进入安全模式（仅执行只读操作） */
    shouldEnterSafeMode: boolean
    /** 建议原因 */
    reason: string
  } {
    const ctx = this.getToolContext()
    const reasons: string[] = []

    if (ctx.mode === 'break') {
      reasons.push('用户处于休息模式')
    }
    if (ctx.toolActivity.consecutiveFailures >= CONSECUTIVE_FAILURE_WARNING) {
      reasons.push(`工具连续失败 ${ctx.toolActivity.consecutiveFailures} 次`)
    }
    if (ctx.alertLevel === 'error') {
      reasons.push('工具执行出现严重错误')
    }

    return {
      shouldSkipNonCritical: ctx.mode === 'break' || ctx.alertLevel === 'error',
      shouldThrottle: ctx.toolActivity.failureRate > FAILURE_RATE_WARNING,
      shouldEnterSafeMode: ctx.alertLevel === 'error' || ctx.toolActivity.consecutiveFailures >= CONSECUTIVE_FAILURE_ERROR,
      reason: reasons.length > 0 ? reasons.join('；') : '正常',
    }
  }

  /**
   * 重置连续失败计数（工具在成功恢复后调用）。
   */
  resetConsecutiveFailures(): void {
    this.consecutiveFailures = 0
  }

  // ══════════════════════════════════════════════════════════
  //  内部方法
  // ══════════════════════════════════════════════════════════

  /**
   * 记录一次工具执行事件。
   */
  private recordToolEvent(toolName: string, success: boolean): void {
    const now = Date.now()
    this.toolEvents.push({ name: toolName, success, time: now })
    this.lastToolName = toolName
    this.lastToolTime = now

    if (success) {
      this.consecutiveFailures = 0
    } else {
      this.consecutiveFailures++
    }

    // 裁剪过期事件
    this.pruneToolEvents()
  }

  /**
   * 裁剪超出时间窗口的工具事件。
   */
  private pruneToolEvents(): void {
    const cutoff = Date.now() - ACTIVITY_WINDOW_MS
    while (this.toolEvents.length > 0 && this.toolEvents[0].time < cutoff) {
      this.toolEvents.shift()
    }
  }

  /**
   * 计算时间窗口内的工具活动统计。
   */
  private computeToolActivity(): ToolActivitySnapshot {
    this.pruneToolEvents()
    const failures = this.toolEvents.filter((e) => !e.success).length
    const successes = this.toolEvents.filter((e) => e.success).length
    const total = failures + successes

    return {
      lastToolName: this.lastToolName,
      lastToolTime: this.lastToolTime,
      toolFailuresLastMinute: failures,
      toolSuccessCount: successes,
      toolCallCount: total,
      consecutiveFailures: this.consecutiveFailures,
      failureRate: total > 0 ? failures / total : 0,
    }
  }

  /**
   * 根据工具活动计算告警级别。
   */
  private computeAlertLevel(activity: ToolActivitySnapshot): ToolAlertLevel {
    if (activity.consecutiveFailures >= CONSECUTIVE_FAILURE_ERROR) return 'error'
    if (activity.consecutiveFailures >= CONSECUTIVE_FAILURE_WARNING) return 'warning'
    if (activity.failureRate > FAILURE_RATE_ERROR) return 'error'
    if (activity.failureRate > FAILURE_RATE_WARNING) return 'warning'
    return 'normal'
  }

  /**
   * 计算推荐的叠加层强度。
   * 工具高频率调用 → 降低叠加层避免干扰；
   * 工具频繁失败 → 提高叠加层显示告警；
   * 用户休息 → 降低叠加层。
   */
  private computeRecommendedIntensity(): number {
    // 基础值：根据模式
    const baseIntensity: Record<WallpaperMode, number> = {
      focus: 0.3,
      multitasking: 0.6,
      break: 0.8,
    }
    let intensity = baseIntensity[this.mode]

    // 工具活跃时降低强度
    const activity = this.computeToolActivity()
    if (activity.toolCallCount > 10) intensity = Math.max(0.1, intensity - 0.2)
    if (activity.toolCallCount > 20) intensity = Math.max(0.05, intensity - 0.3)

    // 工具持续失败时提高强度（告警可见性）
    if (activity.consecutiveFailures >= CONSECUTIVE_FAILURE_WARNING) {
      intensity = Math.min(1.0, intensity + 0.2)
    }

    return Math.round(intensity * 100) / 100
  }
}

// ════════════════════════════════════════════════════════════
//  全局单例
// ════════════════════════════════════════════════════════════

export const wallpaperToolBridge = WallpaperToolBridge.getInstance()
