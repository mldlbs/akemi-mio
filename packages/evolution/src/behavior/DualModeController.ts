/**
 * DualModeController — UserBehavior/Plan:TypeScript 高级类型学习计划 双模切换控制器
 *
 * 职责：
 * 1. 定义两种模式的最优工作条件
 * 2. 实时监控用户行为 + 计划状态 → 评估当前最优模式
 * 3. 在模式切换时保存/恢复状态保证无缝过渡
 * 4. 防抖处理避免频繁抖动
 * 5. 通过 EventBus 发布切换事件
 *
 * 集成方式：
 * - 由 UserBehaviorService 在每次状态更新时调用 evaluateConditions()
 * - 通过 modeChange 回调通知上层
 * - 独立运行不影响原有 BehaviorStateMachine
 *
 * 重构说明：
 * - 手动防抖/节流逻辑委托给 DebounceGate（core/patterns），消除 lastSwitchTime/lastEvaluationTime 手动管理
 * - 等待决策中的去抖延迟保持独立（领域逻辑：切换决策中的建议等待时间）
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import { behaviorStateMachine } from './BehaviorStateMachine'
import { DrizzlePlanManager } from '@akemi-mio/evolution-core'
import { DebounceGate } from '@akemi-mio/core/core/patterns'
import { planTypeScriptExecutor } from '@akemi-mio/intelligence-learning/PlanTypeScriptExecutor'
import type { ModeType, SwitchDecision, SwitchReason, ModeStateSnapshot, DualModeSwitchEvent } from './DualModeTypes'
export type { ModeType } from './DualModeTypes'
import type { UserBehaviorState } from './UserBehaviorService'
import type { DevPlan } from '@akemi-mio/evolution/types'

// =============================================================================
// 常量
// =============================================================================

/** 切换防抖窗口 ms — 防止频繁切换（用于决策中的建议延迟） */
const SWITCH_DEBOUNCE_MS = 30_000

/** 模式切换最小间隔 ms — 再次评估前最短等待 */
const MIN_SWITCH_INTERVAL_MS = 10_000

/** 条件重新评估间隔 ms */
const EVALUATION_INTERVAL_MS = 5_000

/** 计划标题匹配关键词 — 触发 plan-typescript 模式 */
const PLAN_TITLE_KEYWORDS = ['typescript', 'type', '高级类型', 'ts 学习', 'ts学习']

/** plan-typescript 模式的最小置信度阈值 */
const PLAN_MODE_MIN_CONFIDENCE = 0.55

// =============================================================================
// DualModeController
// =============================================================================

export class DualModeController {
  // ==================== 内部状态 ====================

  /** 当前活跃模式 */
  private currentMode: ModeType = 'user-behavior'

  /** 模式开始时间戳 */
  private modeStartTime = Date.now()

  /** 上次切换到 user-behavior 的状态快照 */
  private lastBehaviorSnapshot: ModeStateSnapshot | null = null

  /** 上次切换到 plan-typescript 的状态快照 */
  private lastPlanSnapshot: ModeStateSnapshot | null = null

  /** 缓存最近一次评估指标 */
  private lastTriggerMetrics: SwitchDecision['triggerMetrics'] | null = null

  /** PlanManager 引用（延迟注入） */
  private planManager: DrizzlePlanManager | null = null

  /** 模式变更监听器 */
  private readonly modeChangeListeners: Array<(decision: SwitchDecision) => void> = []

  /**
   * 切换防抖门控 — 替代手动 lastSwitchTime 管理。
   * 确保两次切换之间至少间隔 MIN_SWITCH_INTERVAL_MS。
   */
  private readonly switchGate = new DebounceGate({
    maxFrequencyMs: MIN_SWITCH_INTERVAL_MS,
    loggerName: 'dual_mode_switch',
  })

  /**
   * 评估节阀门控 — 替代手动 lastEvaluationTime 管理。
   * 确保两次条件评估之间至少间隔 EVALUATION_INTERVAL_MS。
   */
  private readonly evaluationGate = new DebounceGate({
    maxFrequencyMs: EVALUATION_INTERVAL_MS,
    loggerName: 'dual_mode_eval',
  })

  // ==================== 公共 API ====================

  /** 获取当前模式 */
  getCurrentMode(): ModeType {
    return this.currentMode
  }

  /** 获取当前模式的中文名称 */
  getCurrentModeLabel(): string {
    return this.currentMode === 'user-behavior' ? '用户行为模式' : 'TypeScript 高级类型学习计划模式'
  }

  /** 获取模式已持续时长 ms */
  getModeDurationMs(): number {
    return Date.now() - this.modeStartTime
  }

  /** 获取上次评估的触发指标 */
  getLastTriggerMetrics(): SwitchDecision['triggerMetrics'] | null {
    return this.lastTriggerMetrics
  }

  /** 注入 PlanManager 引用 */
  setPlanManager(pm: DrizzlePlanManager): void {
    this.planManager = pm
    log('INFO', 'dual_mode_plan_manager_set')
  }

  /** 获取最后一次切换的用户行为快照（user-behavior 模式） */
  getLastBehaviorSnapshot(): ModeStateSnapshot | null {
    return this.lastBehaviorSnapshot
  }

  /** 获取最后一次切换的计划快照（plan-typescript 模式） */
  getLastPlanSnapshot(): ModeStateSnapshot | null {
    return this.lastPlanSnapshot
  }

  /**
   * 注册模式变更监听器
   * 返回取消函数
   */
  onModeChange(listener: (decision: SwitchDecision) => void): () => void {
    this.modeChangeListeners.push(listener)
    return () => {
      const idx = this.modeChangeListeners.indexOf(listener)
      if (idx >= 0) this.modeChangeListeners.splice(idx, 1)
    }
  }

  /**
   * 强制切换到指定模式（手动覆盖）
   */
  forceSwitchMode(targetMode: ModeType): SwitchDecision | null {
    if (targetMode === this.currentMode) return null

    const decision: SwitchDecision = {
      fromMode: this.currentMode,
      toMode: targetMode,
      reason: 'manual_override',
      confidence: 1.0,
      triggerMetrics: this.lastTriggerMetrics ?? {
        activityState: 'active',
        appCategory: 'code',
        behaviorMode: 'focus',
        idleTimeMs: 0,
        interactionRate: 0,
        hasActivePlan: false,
      },
      debounceMs: 0,
    }

    this.executeSwitch(decision)
    return decision
  }

  // ==================== 核心：条件评估 ====================

  /**
   * 根据当前行为状态 + 计划状态评估是否需要切换模式
   *
   * @param behaviorState 当前行为状态（由 UserBehaviorService 提供）
   * @returns 切换决策，null 表示不需要切换
   */
  evaluateConditions(behaviorState: UserBehaviorState): SwitchDecision | null {
    // ── 节流控制：距上次切换不足最小间隔，跳过 ──
    if (this.switchGate.isThrottled()) return null

    // ── 节流控制：距上次评估不足间隔，跳过 ──
    if (this.evaluationGate.isThrottled()) return null
    this.evaluationGate.markExecution()

    // 收集当前指标
    const modeSnapshot = behaviorStateMachine.computeMode(
      this.detectActivityState(behaviorState.idleTimeMs),
      behaviorState.appCategory,
      behaviorState.idleTimeMs,
      behaviorState.focused,
    )
    const interactionRate = behaviorState.idleTimeMs > 0 ? Math.round(60000 / Math.max(behaviorState.idleTimeMs, 1000)) : 0

    const activePlan = this.findRelevantPlan()

    const metrics: SwitchDecision['triggerMetrics'] = {
      activityState: behaviorState.activityState,
      appCategory: behaviorState.appCategory,
      behaviorMode: modeSnapshot.mode,
      idleTimeMs: behaviorState.idleTimeMs,
      interactionRate,
      hasActivePlan: activePlan !== null,
      planTitle: activePlan?.title,
    }
    this.lastTriggerMetrics = metrics

    // ── 判定是否应切换到 plan-typescript ──
    if (this.currentMode === 'user-behavior') {
      const shouldSwitch = this.evaluatePlanModeConditions(metrics, behaviorState)
      if (shouldSwitch) {
        return this.buildDecision(
          'user-behavior',
          'plan-typescript',
          'context_match',
          shouldSwitch.confidence,
          metrics,
          shouldSwitch.debounceMs,
        )
      }
    }

    // ── 判定是否应切回 user-behavior ──
    if (this.currentMode === 'plan-typescript') {
      const shouldSwitchBack = this.evaluateUserBehaviorConditions(metrics)
      if (shouldSwitchBack) {
        return this.buildDecision(
          'plan-typescript',
          'user-behavior',
          'context_mismatch',
          shouldSwitchBack.confidence,
          metrics,
          shouldSwitchBack.debounceMs,
        )
      }
    }

    return null
  }

  /**
   * 评估是否满足切换到 plan-typescript 模式的条件
   */
  private evaluatePlanModeConditions(
    metrics: SwitchDecision['triggerMetrics'],
    behaviorState: UserBehaviorState,
  ): { confidence: number; debounceMs: number } | null {
    if (!metrics.hasActivePlan) return null

    // 检查计划标题是否匹配 TypeScript 学习计划关键词
    const planTitle = metrics.planTitle?.toLowerCase() ?? ''
    const keywordMatch = PLAN_TITLE_KEYWORDS.some((kw) => planTitle.includes(kw.toLowerCase()))
    if (!keywordMatch) return null

    let confidence = 0.0
    const factors: boolean[] = []

    // 因子 1：应用类别是 code（高权重）
    if (metrics.appCategory === 'code') {
      confidence += 0.3
      factors.push(true)
    } else if (metrics.appCategory === 'browser') {
      confidence += 0.15 // 可能在浏览器查文档
      factors.push(true)
    }

    // 因子 2：行为模式是 focus
    if (metrics.behaviorMode === 'focus') {
      confidence += 0.25
      factors.push(true)
    }

    // 因子 3：窗口标题包含 TypeScript 关键词（检查常见的 TS 文件名后缀）
    const titleLower = behaviorState.windowTitle.toLowerCase()
    const titleHasTs =
      PLAN_TITLE_KEYWORDS.some((kw) => titleLower.includes(kw.toLowerCase())) ||
      /\btypescript\b/.test(titleLower) ||
      /\b\w+\.ts\b/.test(titleLower) ||
      /\b\w+\.tsx\b/.test(titleLower)
    if (titleHasTs) {
      confidence += 0.25
      factors.push(true)
    }

    // 因子 4：交互频率低（深度学习的典型表现）
    if (metrics.interactionRate >= 0 && metrics.interactionRate <= 20) {
      confidence += 0.1
      factors.push(true)
    }

    // 因子 5：单应用主导（非多任务）
    if (metrics.behaviorMode !== 'multitasking') {
      confidence += 0.1
      factors.push(true)
    }

    // 因子 6：空闲时间 > 10s（思考/阅读代码时的停顿）
    if (metrics.idleTimeMs > 10_000 && metrics.idleTimeMs < 600_000) {
      confidence += 0.05
      factors.push(true)
    }

    // 如果有 3 个以上因子且置信度达标
    if (factors.length >= 3 && confidence >= PLAN_MODE_MIN_CONFIDENCE) {
      return { confidence, debounceMs: SWITCH_DEBOUNCE_MS }
    }

    return null
  }

  /**
   * 评估是否应切回 user-behavior 模式
   */
  private evaluateUserBehaviorConditions(metrics: SwitchDecision['triggerMetrics']): { confidence: number; debounceMs: number } | null {
    let confidence = 0.0
    const reasons: SwitchReason[] = []

    // 条件 1：计划已完成或已放弃
    if (!metrics.hasActivePlan) {
      confidence += 0.4
      reasons.push('plan_completed')
    }

    // 条件 2：用户进入多任务或 break 模式
    if (metrics.behaviorMode === 'multitasking' || metrics.behaviorMode === 'break') {
      confidence += 0.25
      reasons.push('focus_lost')
    }

    // 条件 3：用户长时间空闲（>5 min）
    if (metrics.idleTimeMs > 300_000) {
      confidence += 0.15
      reasons.push('user_idle_too_long')
    }

    // 条件 4：应用类别不再是 code 或 browser（离开编码/学习环境）
    if (metrics.appCategory !== 'code' && metrics.appCategory !== 'browser') {
      confidence += 0.15
      reasons.push('context_mismatch')
    }

    // 条件 5：交互频率变得很高（离开深度专注）
    if (metrics.interactionRate > 30) {
      confidence += 0.1
      reasons.push('threshold_adaptation')
    }

    if (confidence >= 0.5) {
      return { confidence, debounceMs: reasons.includes('plan_completed') ? 5_000 : SWITCH_DEBOUNCE_MS }
    }

    return null
  }

  // ==================== 切换执行 ====================

  /**
   * 执行模式切换，包含状态保存和恢复
   */
  private executeSwitch(decision: SwitchDecision): void {
    const now = Date.now()

    // 1. 保存当前模式的状态
    const snapshot = this.saveCurrentState(decision.fromMode)

    // 2. 更新模式
    const prevMode = this.currentMode
    this.currentMode = decision.toMode
    this.modeStartTime = now

    // 3. 标记切换时间（用于 DebounceGate 节流控制）
    this.switchGate.markExecution()

    // 4. 恢复目标模式的保存状态
    this.restoreTargetState(decision.toMode)

    // 5. 保存快照供后续恢复
    if (decision.fromMode === 'user-behavior') {
      this.lastBehaviorSnapshot = snapshot
    } else {
      this.lastPlanSnapshot = snapshot
    }

    // 6. 发布事件
    const switchEvent: DualModeSwitchEvent = {
      fromMode: decision.fromMode,
      toMode: decision.toMode,
      reason: decision.reason,
      confidence: decision.confidence,
      snapshot,
      timestamp: now,
    }
    eventBus.emit('behavior.mode.switch', switchEvent)

    log('INFO', 'dual_mode_switched', {
      from: prevMode,
      to: decision.toMode,
      reason: decision.reason,
      confidence: decision.confidence.toFixed(2),
      durationMs: now - this.modeStartTime,
    })

    // 7. 通知监听器
    this.notifyListeners(decision)
  }

  /**
   * 保存指定模式的当前状态快照
   */
  private saveCurrentState(mode: ModeType): ModeStateSnapshot {
    let activePlan: ModeStateSnapshot['activePlan'] = null
    if (mode === 'plan-typescript') {
      const plan = this.findRelevantPlan()
      if (plan) {
        activePlan = {
          id: plan.id,
          title: plan.title,
          steps: plan.steps.map((s) => ({ description: s.description, status: s.status })),
          priority: plan.priority,
        }
      }
    }

    const thresholds = behaviorStateMachine.getThresholds()

    return {
      mode,
      startedAt: this.modeStartTime,
      savedAt: Date.now(),
      durationMs: Date.now() - this.modeStartTime,
      behaviorState: null, // 由调用方填充
      activePlan,
      adaptiveThresholds: {
        idleThresholdMs: thresholds.idleThresholdMs,
        focusThresholdMs: thresholds.focusThresholdMs,
        multitaskingSwitchCount: thresholds.multitaskingSwitchCount,
      },
      metadata: {},
    }
  }

  /**
   * 恢复到目标模式时需要的状态恢复操作
   * 注入点：切换至 plan-typescript 时同步学习关注上下文
   */
  private restoreTargetState(targetMode: ModeType): void {
    if (targetMode === 'plan-typescript') {
      // plan-typescript 模式：降低空闲感知灵敏度，避免学习思考时误判
      log('INFO', 'dual_mode_restore_plan', {
        action: 'adjust_thresholds_for_focus',
      })
      // ── 学习系统注入：同步当前关注上下文 ──
      // 对应 AsrService.setConversationContext() 的语义等价
      planTypeScriptExecutor.syncFocusContext()
    } else {
      // user-behavior 模式：恢复正常阈值
      log('INFO', 'dual_mode_restore_behavior', {
        action: 'reset_thresholds_for_behavior',
      })
    }
  }

  /**
   * 构建切换决策对象
   */
  private buildDecision(
    from: ModeType,
    to: ModeType,
    reason: SwitchReason,
    confidence: number,
    metrics: SwitchDecision['triggerMetrics'],
    debounceMs: number,
  ): SwitchDecision {
    return { fromMode: from, toMode: to, reason, confidence, triggerMetrics: metrics, debounceMs }
  }

  // ==================== 辅助方法 ====================

  /**
   * 检测活跃状态（基于空闲时长）
   */
  private detectActivityState(idleTimeMs: number): 'active' | 'idle' | 'away' {
    if (idleTimeMs >= 300_000) return 'away'
    if (idleTimeMs >= behaviorStateMachine.getThresholds().idleThresholdMs) return 'idle'
    return 'active'
  }

  /**
   * 查找与 TypeScript 类型学习相关的活跃计划
   */
  private findRelevantPlan(): DevPlan | null {
    try {
      if (!this.planManager) return null
      const plans = this.planManager.listPlans()
      const activePlans = plans.filter((p) => p.status === 'active')

      // 按关键词匹配度排序
      const scored = activePlans
        .map((p) => {
          const titleLower = p.title.toLowerCase()
          let score = 0
          for (const kw of PLAN_TITLE_KEYWORDS) {
            if (titleLower.includes(kw.toLowerCase())) {
              score += kw.length // 关键词越长权重越高
            }
          }
          return { plan: p, score }
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)

      return scored.length > 0 ? scored[0].plan : null
    } catch {
      return null
    }
  }

  // ==================== 监听器通知 ====================

  private notifyListeners(decision: SwitchDecision): void {
    for (const listener of this.modeChangeListeners) {
      try {
        listener(decision)
      } catch (err: any) {
        log('WARN', 'dual_mode_listener_error', { error: String(err) })
      }
    }
  }

  // ==================== 诊断 ====================

  /** 获取完整的诊断信息 */
  getDiagnostics(): Record<string, unknown> {
    return {
      currentMode: this.currentMode,
      modeDurationMs: this.getModeDurationMs(),
      switchGateStatus: this.switchGate.getStatus(),
      evaluationGateStatus: this.evaluationGate.getStatus(),
      hasPlanManager: this.planManager !== null,
      lastBehaviorSnapshotAge: this.lastBehaviorSnapshot ? Date.now() - this.lastBehaviorSnapshot.savedAt : null,
      lastPlanSnapshotAge: this.lastPlanSnapshot ? Date.now() - this.lastPlanSnapshot.savedAt : null,
    }
  }
}

// =============================================================================
// 全局单例
// =============================================================================

export const dualModeController = new DualModeController()
