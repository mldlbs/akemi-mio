import { log } from '@akemi-mio/core/logger/Logger'

// =============================================================================
// 类型定义
// =============================================================================

/** 行为模式 — 由状态机综合计算得出 */
export type BehaviorMode = 'focus' | 'multitasking' | 'break'

/** 单次交互记录 */
export interface InteractionRecord {
  /** 交互时间戳 */
  readonly timestamp: number
  /** 交互时的应用类别 */
  readonly appCategory: string
  /** 窗口是否聚焦 */
  readonly focused: boolean
}

/** 自适应阈值（基于最近 N 次交互统计） */
export interface AdaptiveThresholds {
  /** 空闲判定阈值 ms — 动态调整 */
  idleThresholdMs: number
  /** 专注模式需要的连续编码时长 ms */
  focusThresholdMs: number
  /** 多任务判定阈值 — 指定时间内切换次数 */
  multitaskingSwitchCount: number
  /** 多任务判定时间窗口 ms */
  multitaskingWindowMs: number
  /** 隐私淡入开始时间 ms（进入 break 后多久开始模糊） */
  privacyFadeDelayMs: number
}

/** 行为模式快照 */
export interface BehaviorModeSnapshot {
  /** 当前模式 */
  mode: BehaviorMode
  /** 自适应阈值（当前值） */
  thresholds: AdaptiveThresholds
  /** 最近 144 次交互统计摘要 */
  stats: BehaviorStats | null
  /** 模式置信度 0-1 */
  confidence: number
  /** 模式持续时长 ms */
  modeDurationMs: number
  /** 多任务切换历史（最近几次） */
  recentSwitches: Array<{
    timestamp: number
    fromCategory: string
    toCategory: string
  }>
  /** 进入 break 后已过时长 ms（用于隐私淡入） */
  breakElapsedMs: number
}

/** 交互统计摘要 */
export interface BehaviorStats {
  /** 窗口内交互总数（最多 144） */
  totalInteractions: number
  /** 平均交互间隔 ms */
  meanIntervalMs: number
  /** 交互间隔标准差 */
  stdIntervalMs: number
  /** 应用切换次数 */
  switchCount: number
  /** 活跃时间占比 0-1 */
  activeRatio: number
  /** 当前模式在该交互窗口中的占比 */
  dominantAppCategory: string
  /** 窗口总时长 ms */
  windowDurationMs: number
}

// =============================================================================
// 默认阈值（初始值，后续根据统计动态调整）
// =============================================================================

const DEFAULT_THRESHOLDS: AdaptiveThresholds = {
  idleThresholdMs: 30_000, // 30s
  focusThresholdMs: 120_000, // 2min
  multitaskingSwitchCount: 4, // 4 次
  multitaskingWindowMs: 60_000, // 1min
  privacyFadeDelayMs: 60_000, // 1min
}

const WINDOW_SIZE = 144
const THRESHOLD_ADAPT_INTERVAL_MS = 60_000 // 每分钟重新计算一次阈值

// =============================================================================
// BehaviorStateMachine — 行为状态机
// =============================================================================
//
// 消费 UserBehaviorService 的事件，结合最近 144 次交互的滚动窗口统计，
// 计算复合行为模式（focus / multitasking / break）和自适应阈值。
//
// 使用:
//   const fsm = new BehaviorStateMachine()
//   fsm.recordInteraction({ timestamp, appCategory, focused })
//   fsm.on('mode:changed', (snapshot) => { ... })
//
//   // 在 idle check 中调用
//   const snapshot = fsm.computeMode(currentBehaviorState)
//   // snapshot.mode => 'focus' | 'multitasking' | 'break'
//
// =============================================================================

export class BehaviorStateMachine {
  private interactionBuffer: InteractionRecord[] = []
  private switchLog: BehaviorModeSnapshot['recentSwitches'] = []
  private currentMode: BehaviorMode = 'focus'
  private modeStartTime = Date.now()
  private thresholds: AdaptiveThresholds = { ...DEFAULT_THRESHOLDS }
  private lastThresholdAdaptTime = 0
  private lastAppCategory: string = 'other'
  private breakStartTime: number | null = null
  private focusStartTime: number | null = null
  private subFocused: boolean = true
  private readonly modeChangeListeners: Array<(snapshot: BehaviorModeSnapshot) => void> = []

  // ==================== 公共 API ====================

  /**
   * 记录一次用户交互（输入事件 / 窗口事件 / 应用切换）
   */
  recordInteraction(record: InteractionRecord): void {
    const prevCategory = this.lastAppCategory

    // 检测应用切换
    if (prevCategory !== record.appCategory && this.interactionBuffer.length > 0) {
      this.switchLog.push({
        timestamp: record.timestamp,
        fromCategory: prevCategory,
        toCategory: record.appCategory,
      })
      // 只保留最近 20 条
      if (this.switchLog.length > 20) {
        this.switchLog.shift()
      }
    }

    this.lastAppCategory = record.appCategory
    this.subFocused = record.focused

    // 追加到滚动窗口
    this.interactionBuffer.push(record)
    if (this.interactionBuffer.length > WINDOW_SIZE) {
      this.interactionBuffer.shift()
    }

    // 根据激活状态更新 break/focus 计时
    if (record.focused) {
      if (this.breakStartTime !== null) {
        this.breakStartTime = null
      }
    }
  }

  /**
   * 注册模式变更监听器
   */
  onModeChange(listener: (snapshot: BehaviorModeSnapshot) => void): () => void {
    this.modeChangeListeners.push(listener)
    return () => {
      const idx = this.modeChangeListeners.indexOf(listener)
      if (idx >= 0) this.modeChangeListeners.splice(idx, 1)
    }
  }

  /**
   * 根据当前用户行为状态计算行为模式
   *
   * @param activityState 当前活动状态
   * @param appCategory 当前应用类别
   * @param idleTimeMs 空闲时长
   * @param focused 窗口是否聚焦
   * @returns 模式快照
   */
  computeMode(activityState: 'active' | 'idle' | 'away', appCategory: string, idleTimeMs: number, focused: boolean): BehaviorModeSnapshot {
    // 自适应阈值更新（每分钟一次）
    this.adaptThresholds()

    const stats = this.computeStats()
    const prevMode = this.currentMode
    let newMode: BehaviorMode

    // ── 模式判定逻辑（优先级从高到低） ──

    if (activityState === 'away' || activityState === 'idle') {
      // 长时间离开 / 空闲 → break
      newMode = 'break'
      if (this.breakStartTime === null) {
        this.breakStartTime = Date.now()
      }
    } else if (this.isMultitasking(stats)) {
      // 频繁切换应用 + 较高交互频率 → multitasking
      newMode = 'multitasking'
      this.breakStartTime = null
    } else if (this.isFocused(appCategory, focused)) {
      // 编码 / 深度阅读 + 窗口聚焦 → focus
      newMode = 'focus'
      this.breakStartTime = null
    } else {
      // 默认 → focus（低干扰）
      newMode = 'focus'
      this.breakStartTime = null
    }

    // 更新模式和计时
    if (newMode !== prevMode) {
      this.currentMode = newMode
      this.modeStartTime = Date.now()
      if (newMode === 'break' && this.breakStartTime === null) {
        this.breakStartTime = Date.now()
      }
    }

    const snapshot: BehaviorModeSnapshot = {
      mode: this.currentMode,
      thresholds: { ...this.thresholds },
      stats,
      confidence: this.computeConfidence(newMode, stats),
      modeDurationMs: Date.now() - this.modeStartTime,
      recentSwitches: [...this.switchLog.slice(-5)],
      breakElapsedMs: this.breakStartTime !== null ? Date.now() - this.breakStartTime : 0,
    }

    // 模式变更通知
    if (newMode !== prevMode) {
      log('INFO', 'behavior_mode_changed', {
        from: prevMode,
        to: newMode,
        confidence: snapshot.confidence.toFixed(2),
        stats: stats ? { total: stats.totalInteractions, switches: stats.switchCount } : null,
      })
      this.notifyListeners(snapshot)
    }

    return snapshot
  }

  /** 获取当前模式 */
  getCurrentMode(): BehaviorMode {
    return this.currentMode
  }

  /** 获取当前阈值 */
  getThresholds(): AdaptiveThresholds {
    return { ...this.thresholds }
  }

  /** 重置状态 */
  reset(): void {
    this.interactionBuffer = []
    this.switchLog = []
    this.currentMode = 'focus'
    this.modeStartTime = Date.now()
    this.thresholds = { ...DEFAULT_THRESHOLDS }
    this.lastThresholdAdaptTime = 0
    this.lastAppCategory = 'other'
    this.breakStartTime = null
    this.focusStartTime = null
    this.subFocused = true
  }

  // ==================== 内部方法 ====================

  /**
   * 从滚动窗口计算统计摘要
   */
  private computeStats(): BehaviorStats | null {
    const buf = this.interactionBuffer
    if (buf.length < 3) return null

    // 窗口时间跨度
    const firstTime = buf[0].timestamp
    const lastTime = buf[buf.length - 1].timestamp
    const windowDurationMs = Math.max(1, lastTime - firstTime)

    // 交互间隔
    const intervals: number[] = []
    let switchCount = 0
    let activeSamples = 0
    const categoryCounts = new Map<string, number>()

    for (let i = 1; i < buf.length; i++) {
      const interval = buf[i].timestamp - buf[i - 1].timestamp
      intervals.push(interval)

      if (buf[i].appCategory !== buf[i - 1].appCategory) {
        switchCount++
      }

      if (buf[i].focused) {
        activeSamples++
      }
    }

    // 各类别计数
    for (const r of buf) {
      categoryCounts.set(r.appCategory, (categoryCounts.get(r.appCategory) || 0) + 1)
    }

    const total = buf.length
    const meanIntervalMs = intervals.length > 0 ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0

    const stdIntervalMs =
      intervals.length > 1 ? Math.sqrt(intervals.reduce((sum, v) => sum + (v - meanIntervalMs) ** 2, 0) / intervals.length) : 0

    // 主导应用类别
    let dominantCategory = 'other'
    let maxCount = 0
    for (const [cat, count] of categoryCounts) {
      if (count > maxCount) {
        maxCount = count
        dominantCategory = cat
      }
    }

    return {
      totalInteractions: total,
      meanIntervalMs: Math.round(meanIntervalMs),
      stdIntervalMs: Math.round(stdIntervalMs),
      switchCount,
      activeRatio: total > 0 ? activeSamples / total : 0,
      dominantAppCategory: dominantCategory,
      windowDurationMs,
    }
  }

  /**
   * 自适应阈值计算（基于统计数据的均值 ± 标准差）
   */
  private adaptThresholds(): void {
    const now = Date.now()
    if (now - this.lastThresholdAdaptTime < THRESHOLD_ADAPT_INTERVAL_MS) return
    this.lastThresholdAdaptTime = now

    const stats = this.computeStats()
    if (!stats || stats.totalInteractions < 10) return

    // idleThreshold: 基于平均交互间隔 + 1.5σ
    // 用户交互越快 → 空闲阈值降低（更快判定 idle）
    const newIdleThreshold = Math.max(
      10_000, // 最低 10s
      Math.min(
        120_000, // 最高 120s
        Math.round(stats.meanIntervalMs + stats.stdIntervalMs * 1.5),
      ),
    )

    // focusThreshold: 基于用户主要编码 session 长度
    // 使用平均交互间隔 × 编码相关交互比例
    const codeRatio = stats.dominantAppCategory === 'code' ? 1.0 : 0.6
    const newFocusThreshold = Math.max(30_000, Math.min(300_000, Math.round(stats.meanIntervalMs * 4 * codeRatio)))

    // multitaskingSwitchCount: 基于窗口内切换频率
    // 如果用户平时换应用多 → 提高阈值减少误判
    const switchRate = stats.switchCount / Math.max(1, stats.windowDurationMs / 60_000)
    const newSwitchCount = Math.max(
      2,
      Math.min(
        10,
        Math.round(switchRate * 1.2), // 略高于平均切换率的阈值
      ),
    )

    this.thresholds = {
      ...this.thresholds,
      idleThresholdMs: newIdleThreshold,
      focusThresholdMs: newFocusThreshold,
      multitaskingSwitchCount: newSwitchCount,
    }

    log('DEBUG', 'behavior_thresholds_adapted', {
      prevIdle: this.thresholds.idleThresholdMs,
      newIdle: newIdleThreshold,
      prevFocus: this.thresholds.focusThresholdMs,
      newFocus: newFocusThreshold,
      switchCount: newSwitchCount,
      meanIntervalMs: stats.meanIntervalMs,
    })
  }

  /**
   * 判断是否处于多任务模式
   */
  private isMultitasking(stats: BehaviorStats | null): boolean {
    if (!stats || stats.totalInteractions < 5) return false

    // 检查最近的多任务信号
    const recentWindow = this.interactionBuffer.slice(-Math.min(20, this.interactionBuffer.length))
    const recentSwitchCount = this.countRecentSwitches(recentWindow)

    // 条件:
    // 1. 频繁应用切换（最后一分钟超过阈值）
    // 2. 平均交互间隔短（活跃交互）
    // 3. 不是单一编码专注
    const shortInterval = stats.meanIntervalMs < 60_000
    const manySwitches = recentSwitchCount >= this.thresholds.multitaskingSwitchCount
    const notDeepFocus = stats.dominantAppCategory !== 'code' || stats.meanIntervalMs < 10_000 // 即使 code 但操作太频繁也算多任务

    return shortInterval && (manySwitches || (notDeepFocus && stats.totalInteractions > 20))
  }

  /**
   * 判断是否处于专注模式
   */
  private isFocused(appCategory: string, focused: boolean): boolean {
    if (!focused) return false
    if (appCategory !== 'code') return false

    // 检查最近交互窗口中编码占比
    const codeSamples = this.interactionBuffer.filter((r) => r.appCategory === 'code').length
    const codeRatio = this.interactionBuffer.length > 0 ? codeSamples / this.interactionBuffer.length : 0

    return codeRatio >= 0.6
  }

  /**
   * 计算模式置信度
   */
  private computeConfidence(mode: BehaviorMode, stats: BehaviorStats | null): number {
    if (!stats || stats.totalInteractions < 3) return 0.3

    switch (mode) {
      case 'focus': {
        const codeRatio = stats.dominantAppCategory === 'code' ? 0.3 : 0
        const activeBonus = stats.activeRatio > 0.7 ? 0.2 : 0
        const stable = stats.switchCount <= 2 ? 0.2 : 0
        return Math.min(1, 0.4 + codeRatio + activeBonus + stable)
      }
      case 'multitasking': {
        const switchRatio = Math.min(1, stats.switchCount / 10) * 0.4
        const active = stats.activeRatio > 0.5 ? 0.2 : 0
        const intervalBonus = stats.meanIntervalMs < 30_000 ? 0.2 : 0
        return Math.min(1, 0.2 + switchRatio + active + intervalBonus)
      }
      case 'break': {
        // break 由空闲检测直接触发，置信度较高
        return 0.85
      }
    }
  }

  /**
   * 统计最近 N 个交互中的应用切换次数
   */
  private countRecentSwitches(recent: InteractionRecord[]): number {
    let count = 0
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].appCategory !== recent[i - 1].appCategory) {
        count++
      }
    }
    return count
  }

  /**
   * 通知所有模式变更监听器
   */
  private notifyListeners(snapshot: BehaviorModeSnapshot): void {
    for (const listener of this.modeChangeListeners) {
      try {
        listener(snapshot)
      } catch (err: any) {
        log('WARN', 'behavior_mode_listener_error', { error: String(err) })
      }
    }
  }
}

// =============================================================================
// 全局单例
// =============================================================================

export const behaviorStateMachine = new BehaviorStateMachine()
