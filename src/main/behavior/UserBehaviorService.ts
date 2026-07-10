import { BrowserWindow } from 'electron'
import { log } from '../logger/Logger'
import { getMainWindow } from '../core/Lifecycle'
import { eventBus, type EventPayload } from '../core/EventBus'
import { behaviorStateMachine, type BehaviorMode, type AdaptiveThresholds } from './BehaviorStateMachine'
import { dualModeController, type ModeType } from './DualModeController'
import { planTypeScriptExecutor } from '../learning/PlanTypeScriptExecutor'
import { AppWindowPolling } from './app-window-polling'
import type { AppCategory } from './app-window-polling'
// Re-export AppCategory for backward compatibility (external consumers import via behavior/index.ts)
export type { AppCategory } from './app-window-polling'

// =============================================================================
// 类型定义
// =============================================================================

export type ActivityState = 'active' | 'idle' | 'away'

/**
 * 活动情境 — 由 UserBehaviorService 根据窗口类别、空闲状态及行为模式综合判定。
 * - coding:   正在编程，窗口聚焦且活跃
 * - browsing: 正在浏览网页/文档，窗口聚焦且活跃
 * - resting:  空闲、离开或休息模式（不活跃）
 */
export type ActivityContext = 'coding' | 'browsing' | 'resting'

export interface UserBehaviorState {
  /** 活动状态 */
  activityState: ActivityState
  /** 全屏状态 */
  fullscreen: boolean
  /** 窗口是否聚焦 */
  focused: boolean
  /** 当前前台应用类别 */
  appCategory: AppCategory
  /** 前台窗口标题 */
  windowTitle: string
  /** 距上次活动毫秒数 */
  idleTimeMs: number
}

/** 行为模式模式 */
export type { BehaviorMode } from './BehaviorStateMachine'

/** 推送到渲染进程的增强行为状态 */
export interface EnrichedBehaviorState extends UserBehaviorState {
  /** 综合行为模式 */
  mode: BehaviorMode
  /** 活动情境（coding / browsing / resting） */
  context: ActivityContext
  /** 当前自适应阈值 */
  thresholds: AdaptiveThresholds
  /** 模式持续时长 ms */
  modeDurationMs: number
  /** 模式置信度 0-1 */
  confidence: number
  /** 进入 break 后已过时长 ms */
  breakElapsedMs: number
  /** 最近应用切换（最多 5 条） */
  recentSwitches: Array<{
    fromCategory: string
    toCategory: string
  }>
  /** 双模切换系统当前模式 */
  dualMode: {
    mode: ModeType
    modeLabel: string
    durationMs: number
  }
}

// =============================================================================
// 默认状态
// =============================================================================

const DEFAULT_STATE: UserBehaviorState = {
  activityState: 'active',
  fullscreen: false,
  focused: true,
  appCategory: 'other',
  windowTitle: '',
  idleTimeMs: 0,
}

// =============================================================================
// UserBehaviorService — 用户行为追踪与状态发布
// =============================================================================
//
// 追踪:
//   - 窗口焦点 (focus/blur)
//   - 全屏状态 (enter-full-screen / leave-full-screen)
//   - 前台应用类别 (通过 PowerShell 获取活动窗口标题)
//   - 用户空闲状态 (基于活动时间戳)
//
// 发布:
//   - IPC 'behavior:state' → 渲染进程
//   - EventBus 'behavior.state.updated' → 主进程其他服务
//
// 使用:
//   const behavior = new UserBehaviorService()
//   behavior.start()
//   behavior.getState() // => UserBehaviorState
//

export class UserBehaviorService {
  private state: UserBehaviorState = { ...DEFAULT_STATE }
  private lastActivityTime = Date.now()
  private idleCheckTimer: ReturnType<typeof setInterval> | null = null
  private readonly appPolling: AppWindowPolling
  private mainWindow: BrowserWindow | null = null
  private lastComputedMode: BehaviorMode = 'focus'

  // ── 双模切换评估 —— 在 idle checker 中半周期运行一次 ──
  private dualModeEvalCounter = 0
  private static readonly DUAL_MODE_EVAL_EVERY_N_TICKS = 3 // 每 ~6s 评估一次

  // ── 双模切的事件订阅清理 ──
  private eventSubscriptions: (() => void)[] = []

  // ── 阈值常量 ──
  private static readonly AWAY_THRESHOLD_MS = 300_000 // 5min → away
  private static readonly CHECK_INTERVAL_MS = 2_000 // idle 检查间隔

  // ── 全屏检测状态（避免重复事件） ──
  private lastFullscreenState: boolean = false

  constructor() {
    this.mainWindow = getMainWindow()
    this.appPolling = new AppWindowPolling({
      pollIntervalMs: 5_000,
      // 窗口聚焦时不轮询（用户在用我们的应用时，不需要检测前台窗口变化）
      shouldPoll: () => !this.state.focused,
    })
  }

  // ==================== 生命周期 ====================

  start(): void {
    this.setupWindowListeners()
    this.startIdleChecker()
    this.appPolling.start((title, category) => {
      if (title !== this.state.windowTitle) {
        this.updateState({ windowTitle: title, appCategory: category })
      }
    })
    this.setupPlanEventSubscriptions()
    this.lastActivityTime = Date.now()
    log('INFO', 'behavior_service_started', {
      idleThresholdMs: behaviorStateMachine.getThresholds().idleThresholdMs,
      awayThresholdMs: UserBehaviorService.AWAY_THRESHOLD_MS,
    })
  }

  stop(): void {
    this.clearTimer(this.idleCheckTimer)
    this.appPolling.stop()
    this.idleCheckTimer = null
    this.disposeEventSubscriptions()
    log('INFO', 'behavior_service_stopped')
  }

  /** 获取当前行为状态快照 */
  getState(): UserBehaviorState {
    return { ...this.state, idleTimeMs: Date.now() - this.lastActivityTime }
  }

  /** 获取当前增强行为状态（含模式 + 情境信息） */
  getEnrichedState(): EnrichedBehaviorState {
    const base = this.getState()
    const snapshot = behaviorStateMachine.computeMode(
      base.activityState,
      base.appCategory,
      base.idleTimeMs,
      base.focused,
    )
    this.lastComputedMode = snapshot.mode

    const dualMode = dualModeController.getCurrentMode()

    return {
      ...base,
      mode: snapshot.mode,
      context: this.detectActivityContext(base.activityState, base.appCategory, snapshot.mode),
      thresholds: snapshot.thresholds,
      modeDurationMs: snapshot.modeDurationMs,
      confidence: snapshot.confidence,
      breakElapsedMs: snapshot.breakElapsedMs,
      recentSwitches: snapshot.recentSwitches.map((s) => ({
        fromCategory: s.fromCategory,
        toCategory: s.toCategory,
      })),
      dualMode: {
        mode: dualMode,
        modeLabel: dualMode === 'user-behavior' ? '用户行为模式' : 'TypeScript 高级类型学习计划模式',
        durationMs: dualModeController.getModeDurationMs(),
      },
    }
  }

  /** 获取行为状态机引用（供其他服务调用） */
  getStateMachine(): typeof behaviorStateMachine {
    return behaviorStateMachine
  }

  /** 标记用户活动（供外部调用，如 IPC handler 接收到交互时） */
  markActive(): void {
    this.lastActivityTime = Date.now()
    behaviorStateMachine.recordInteraction({
      timestamp: Date.now(),
      appCategory: this.state.appCategory,
      focused: this.state.focused,
    })
  }

  /**
   * 检测当前活动情境。
   * 综合窗口类别、空闲状态及行为模式，映射为三种情境之一。
   */
  private detectActivityContext(
    activityState: ActivityState,
    appCategory: AppCategory,
    mode: BehaviorMode,
  ): ActivityContext {
    // 休息 / 空闲 / 离开 → resting
    if (activityState === 'idle' || activityState === 'away' || mode === 'break') {
      return 'resting'
    }

    // 编码窗口 + 活跃 → coding
    if (appCategory === 'code') {
      return 'coding'
    }

    // 浏览器 + 活跃 → browsing
    if (appCategory === 'browser') {
      return 'browsing'
    }

    // 多媒体/通讯默认归为 browsing（仍在信息消费中）
    if (appCategory === 'media' || appCategory === 'communication') {
      return 'browsing'
    }

    // 其他类别 → 按行为模式推断
    if (mode === 'multitasking') {
      return 'browsing'
    }

    return 'resting'
  }

  // ==================== 窗口事件监听 ====================

  private setupWindowListeners(): void {
    const win = this.mainWindow
    if (!win) return

    win.on('focus', () => {
      this.markActive()
      this.updateState({ focused: true })
    })

    win.on('blur', () => {
      this.recordInteraction()
      this.updateState({ focused: false })
    })

    win.on('enter-full-screen', () => {
      this.recordInteraction()
      this.lastFullscreenState = true
      this.updateState({ fullscreen: true })
    })

    win.on('leave-full-screen', () => {
      this.recordInteraction()
      this.lastFullscreenState = false
      this.updateState({ fullscreen: false })
    })

    win.on('maximize', () => this.recordInteraction())
    win.on('unmaximize', () => this.recordInteraction())

    // WebContents 上的输入事件
    win.webContents.on('input-event', () => {
      this.markActive()
    })
  }

  // ==================== 空闲检测 ====================

  private startIdleChecker(): void {
    this.idleCheckTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastActivityTime

      // 使用状态机的动态 idle 阈值
      const dynamicIdleThreshold = behaviorStateMachine.getThresholds().idleThresholdMs

      let newState: ActivityState
      if (elapsed >= UserBehaviorService.AWAY_THRESHOLD_MS) {
        newState = 'away'
      } else if (elapsed >= dynamicIdleThreshold) {
        newState = 'idle'
      } else {
        newState = 'active'
      }

      if (newState !== this.state.activityState) {
        this.updateState({ activityState: newState, idleTimeMs: elapsed })
      } else {
        // 只更新 idleTimeMs 不触发完整推送（防抖内部处理）
        this.state.idleTimeMs = elapsed
      }

      // ── 双模切换条件评估（半周期执行以降低开销） ──
      this.dualModeEvalCounter++
      if (this.dualModeEvalCounter >= UserBehaviorService.DUAL_MODE_EVAL_EVERY_N_TICKS) {
        this.dualModeEvalCounter = 0
        const decision = dualModeController.evaluateConditions(this.getState())
        if (decision) {
          log('INFO', 'dual_mode_auto_switch', {
            from: decision.fromMode,
            to: decision.toMode,
            reason: decision.reason,
            confidence: decision.confidence.toFixed(2),
          })
        }
      }
    }, UserBehaviorService.CHECK_INTERVAL_MS)
  }

  // ==================== 内部方法 ====================

  /**
   * 记录一次交互到状态机（用于窗口切换、全屏变化等显式事件）
   */
  private recordInteraction(): void {
    behaviorStateMachine.recordInteraction({
      timestamp: Date.now(),
      appCategory: this.state.appCategory,
      focused: this.state.focused,
    })
  }

  private updateState(patch: Partial<UserBehaviorState>): void {
    const prev = { ...this.state }
    Object.assign(this.state, patch)

    const changed =
      patch.activityState !== prev.activityState ||
      patch.fullscreen !== prev.fullscreen ||
      patch.focused !== prev.focused ||
      patch.appCategory !== prev.appCategory

    // 只有重要状态变化时才推送 + 发出事件
    if (changed) {
      this.pushEnrichedState()
      eventBus.emit('behavior.state.updated', this.getState())
    }
  }

  /**
   * 推送增强行为状态（含模式、自适应阈值等）到渲染进程
   */
  private pushEnrichedState(): void {
    const win = this.mainWindow
    if (!win || win.isDestroyed()) return
    try {
      const enriched = this.getEnrichedState()
      win.webContents.send('behavior:state', enriched)
    } catch (err: any) {
      log('WARN', 'behavior_push_failed', { error: String(err) })
    }
  }

  // ==================== 双模切换：事件订阅 ====================

  /**
   * 订阅计划创建/完成事件，在计划状态变化时触发双模切换评估
   * 注入点：步骤完成时同步到学习系统（对应 ASR feedUserTextToHotwords）
   */
  private setupPlanEventSubscriptions(): void {
    this.eventSubscriptions.push(
      eventBus.on('agent.plan.created', (p: EventPayload['agent.plan.created']) => {
        log('INFO', 'dual_mode_plan_created_trigger_eval', { planId: p.planId, title: p.title })
        this.evaluateDualModeNow()
      }),
    )
    this.eventSubscriptions.push(
      eventBus.on('agent.plan.completed', (p: EventPayload['agent.plan.completed']) => {
        log('INFO', 'dual_mode_plan_completed_trigger_eval', { planId: p.planId })
        // 计划完成：应用遗忘曲线衰减
        planTypeScriptExecutor.applyForgettingDecay()
        this.evaluateDualModeNow()
      }),
    )
    this.eventSubscriptions.push(
      eventBus.on('agent.plan.step', (p: EventPayload['agent.plan.step']) => {
        // ── 学习系统注入：步骤完成反馈 ──
        if (p.status === 'done' || p.status === 'failed') {
          planTypeScriptExecutor.onPlanStepCompleted(
            `步骤 ${p.stepIndex}`,
            p.status === 'done',
          )
          // 每 3 步检查一次自适应调整
          if (p.stepIndex > 0 && p.stepIndex % 3 === 0) {
            planTypeScriptExecutor.autoAdjustStrategy()
          }
        }
        // 双模切换评估（每 5 步一次）
        if (p.stepIndex % 5 === 0) {
          this.evaluateDualModeNow()
        }
      }),
    )
  }

  /** 执行一次双模切换评估 */
  private evaluateDualModeNow(): void {
    const decision = dualModeController.evaluateConditions(this.getState())
    if (decision) {
      log('INFO', 'dual_mode_event_triggered_switch', {
        from: decision.fromMode,
        to: decision.toMode,
        reason: decision.reason,
        confidence: decision.confidence.toFixed(2),
      })
    }
  }

  /** 清理事件订阅 */
  private disposeEventSubscriptions(): void {
    for (const dispose of this.eventSubscriptions) {
      try {
        dispose()
      } catch {
        // 静默清理
      }
    }
    this.eventSubscriptions = []
  }

  private clearTimer(timer: ReturnType<typeof setInterval> | null): void {
    if (timer) clearInterval(timer)
  }
}
