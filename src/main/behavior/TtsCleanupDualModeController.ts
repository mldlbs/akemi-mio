/**
 * TtsCleanupDualModeController — TTS/Plan:清理工作区 双模切换控制器
 *
 * 职责：
 * 1. 定义 TTS 和 Plan:清理工作区 两种模式的最优工作条件
 * 2. 实时监控用户活动状态 + 工作区文件状态 → 评估当前最优模式
 * 3. 在模式切换时保存/恢复状态保证无缝过渡
 * 4. 防抖处理避免频繁抖动
 * 5. 通过 EventBus 发布切换事件
 *
 * 集成方式：
 * - 由调用方（如 UserBehaviorService 或独立定时器）定期调用 evaluateConditions()
 * - 通过 onModeChange 回调通知上层
 * - 独立运行，与 DualModeController（user-behavior ↔ plan-typescript）正交
 *
 * 设计原则：
 * - TTS 是默认模式（用户活跃时使用）
 * - Plan:清理工作区 在用户空闲且工作区杂乱时自动激活
 * - 用户恢复活跃时立即切回 TTS
 * - 文件整理完成后自动切回 TTS
 *
 * 重构说明：
 * - 使用 DebounceGate 进行切换节流和评估节流
 * - 与 WorkspaceCleanupLayer 的 scanWorkspace 协作获取文件状态
 */

import { log } from '../logger/Logger'
import { eventBus } from '../core/EventBus'
import { DebounceGate } from '../core/patterns'
import type {
  TtsCleanupModeType,
  TtsCleanupSwitchDecision,
  TtsCleanupSwitchReason,
  TtsCleanupModeStateSnapshot,
  TtsCleanupDualModeSwitchEvent,
} from './TtsCleanupDualModeTypes'

// =============================================================================
// 常量
// =============================================================================

/** 切换防抖窗口 ms — 防止频繁切换 */
const SWITCH_DEBOUNCE_MS = 30_000

/** 模式切换最小间隔 ms — 再次评估前最短等待 */
const MIN_SWITCH_INTERVAL_MS = 15_000

/** 条件重新评估间隔 ms */
const EVALUATION_INTERVAL_MS = 5_000

/** 空闲判定阈值 ms — 超过此值视为用户空闲 */
const IDLE_THRESHOLD_MS = 300_000 // 5 min

/** 根目录松散文件阈值 — 超过此值触发清理 */
const ROOT_FILE_CLUTTER_THRESHOLD = 15

/** 空目录阈值 — 超过此值触发清理 */
const EMPTY_DIR_THRESHOLD = 8

/** 计划清理模式的最小置信度阈值 */
const PLAN_MODE_MIN_CONFIDENCE = 0.55

// =============================================================================
// 外部依赖类型（延迟注入）
// =============================================================================

/** 用户行为状态输入（来自 UserBehaviorService） */
export interface TtsCleanupBehaviorInput {
  activityState: string
  idleTimeMs: number
  focused: boolean
}

/** 工作区统计输入（来自 WorkspaceCleanupLayer 或 FileScanner） */
export interface TtsCleanupWorkspaceInput {
  totalFiles: number
  rootLevelFiles: string[]
  emptyDirs: string[]
}

/** TTS 状态输入（来自 TtsService） */
export interface TtsCleanupTtsInput {
  queueDepth: number
  isPlaying: boolean
}

// =============================================================================
// TtsCleanupDualModeController
// =============================================================================

export class TtsCleanupDualModeController {
  // ==================== 内部状态 ====================

  /** 当前活跃模式 */
  private currentMode: TtsCleanupModeType = 'tts'

  /** 模式开始时间戳 */
  private modeStartTime = Date.now()

  /** 上次切换到 tts 的状态快照 */
  private lastTtsSnapshot: TtsCleanupModeStateSnapshot | null = null

  /** 上次切换到 plan-cleanup 的状态快照 */
  private lastCleanupSnapshot: TtsCleanupModeStateSnapshot | null = null

  /** 缓存最近一次评估指标 */
  private lastTriggerMetrics: TtsCleanupSwitchDecision['triggerMetrics'] | null = null

  /** 模式变更监听器 */
  private readonly modeChangeListeners: Array<(decision: TtsCleanupSwitchDecision) => void> = []

  /**
   * 切换防抖门控 — 确保两次切换之间至少间隔 MIN_SWITCH_INTERVAL_MS。
   */
  private readonly switchGate = new DebounceGate({
    maxFrequencyMs: MIN_SWITCH_INTERVAL_MS,
    loggerName: 'tts_cleanup_switch',
  })

  /**
   * 评估节阀门控 — 确保两次条件评估之间至少间隔 EVALUATION_INTERVAL_MS。
   */
  private readonly evaluationGate = new DebounceGate({
    maxFrequencyMs: EVALUATION_INTERVAL_MS,
    loggerName: 'tts_cleanup_eval',
  })

  // ==================== 公共 API ====================

  /** 获取当前模式 */
  getCurrentMode(): TtsCleanupModeType {
    return this.currentMode
  }

  /** 获取当前模式的中文名称 */
  getCurrentModeLabel(): string {
    return this.currentMode === 'tts'
      ? 'TTS 语音交互模式'
      : '工作区清理计划模式'
  }

  /** 获取模式已持续时长 ms */
  getModeDurationMs(): number {
    return Date.now() - this.modeStartTime
  }

  /** 获取上次评估的触发指标 */
  getLastTriggerMetrics(): TtsCleanupSwitchDecision['triggerMetrics'] | null {
    return this.lastTriggerMetrics
  }

  /** 获取最后一次切换的 TTS 快照 */
  getLastTtsSnapshot(): TtsCleanupModeStateSnapshot | null {
    return this.lastTtsSnapshot
  }

  /** 获取最后一次切换的 Cleanup 快照 */
  getLastCleanupSnapshot(): TtsCleanupModeStateSnapshot | null {
    return this.lastCleanupSnapshot
  }

  /**
   * 注册模式变更监听器
   * 返回取消函数
   */
  onModeChange(listener: (decision: TtsCleanupSwitchDecision) => void): () => void {
    this.modeChangeListeners.push(listener)
    return () => {
      const idx = this.modeChangeListeners.indexOf(listener)
      if (idx >= 0) this.modeChangeListeners.splice(idx, 1)
    }
  }

  /**
   * 强制切换到指定模式（手动覆盖）
   */
  forceSwitchMode(targetMode: TtsCleanupModeType): TtsCleanupSwitchDecision | null {
    if (targetMode === this.currentMode) return null

    const decision: TtsCleanupSwitchDecision = {
      fromMode: this.currentMode,
      toMode: targetMode,
      reason: 'manual_override',
      confidence: 1.0,
      triggerMetrics: this.lastTriggerMetrics ?? {
        activityState: 'active',
        idleTimeMs: 0,
        interactionRate: 0,
        rootLevelFileCount: 0,
        emptyDirCount: 0,
        totalFileCount: 0,
        ttsQueueDepth: 0,
      },
      debounceMs: 0,
    }

    this.executeSwitch(decision)
    return decision
  }

  // ==================== 核心：条件评估 ====================

  /**
   * 根据用户行为状态 + 工作区状态评估是否需要切换模式。
   *
   * 调用方应在空闲检测循环中定期调用此方法（建议约每 6s 一次）。
   * 内置节流控制，调用频率高于 EVALUATION_INTERVAL_MS 会被静默跳过。
   *
   * @param behavior 用户行为状态（来自 UserBehaviorService）
   * @param workspace 工作区统计（来自 WorkspaceCleanupLayer）
   * @param ttsState TTS 当前状态（来自 TtsService，可选）
   * @returns 切换决策，null 表示不需要切换
   */
  evaluateConditions(
    behavior: TtsCleanupBehaviorInput,
    workspace: TtsCleanupWorkspaceInput | null,
    ttsState?: TtsCleanupTtsInput | null,
  ): TtsCleanupSwitchDecision | null {
    // ── 节流控制：距上次切换不足最小间隔，跳过 ──
    if (this.switchGate.isThrottled()) return null

    // ── 节流控制：距上次评估不足间隔，跳过 ──
    if (this.evaluationGate.isThrottled()) return null
    this.evaluationGate.markExecution()

    // 收集当前指标
    const rootLevelCount = workspace?.rootLevelFiles.length ?? 0
    const emptyDirCount = workspace?.emptyDirs.length ?? 0
    const totalFileCount = workspace?.totalFiles ?? 0
    const ttsQueueDepth = ttsState?.queueDepth ?? 0
    const interactionRate = behavior.idleTimeMs > 0
      ? Math.round(60000 / Math.max(behavior.idleTimeMs, 1000))
      : 30 // 没有空闲说明一直在交互

    const metrics: TtsCleanupSwitchDecision['triggerMetrics'] = {
      activityState: behavior.activityState,
      idleTimeMs: behavior.idleTimeMs,
      interactionRate,
      rootLevelFileCount: rootLevelCount,
      emptyDirCount,
      totalFileCount,
      ttsQueueDepth,
    }
    this.lastTriggerMetrics = metrics

    // ── 判定是否应切换到 plan-cleanup ──
    if (this.currentMode === 'tts') {
      const shouldSwitch = this.evaluateCleanupModeConditions(metrics, behavior)
      if (shouldSwitch) {
        return this.buildDecision(
          'tts', 'plan-cleanup', 'user_idle_long',
          shouldSwitch.confidence, metrics, shouldSwitch.debounceMs,
        )
      }
    }

    // ── 判定是否应切回 tts ──
    if (this.currentMode === 'plan-cleanup') {
      const shouldSwitchBack = this.evaluateTtsModeConditions(metrics, behavior)
      if (shouldSwitchBack) {
        return this.buildDecision(
          'plan-cleanup', 'tts', shouldSwitchBack.reason,
          shouldSwitchBack.confidence, metrics, shouldSwitchBack.debounceMs,
        )
      }
    }

    return null
  }

  /**
   * 评估是否满足切换到 plan-cleanup（工作区清理计划）模式的条件。
   *
   * 触发条件（需要同时满足或因子加权达标）：
   * 1. 用户处于 idle 或 away 状态 >= 5min
   * 2. 工作区松散文件多于阈值
   * 3. 空目录多于阈值
   * 4. TTS 队列为空或接近空（无待播报内容）
   * 5. 交互频率低（< 5次/分钟）
   */
  private evaluateCleanupModeConditions(
    metrics: TtsCleanupSwitchDecision['triggerMetrics'],
    behavior: TtsCleanupBehaviorInput,
  ): { confidence: number; debounceMs: number } | null {
    let confidence = 0.0
    const activeFactors: boolean[] = []

    // 因子 1：用户空闲或离开（高权重）
    if (behavior.activityState === 'away') {
      confidence += 0.30
      activeFactors.push(true)
    } else if (behavior.activityState === 'idle' && metrics.idleTimeMs >= IDLE_THRESHOLD_MS) {
      confidence += 0.25
      activeFactors.push(true)
    } else if (behavior.activityState === 'idle') {
      confidence += 0.10 // 短暂空闲，权重低
      activeFactors.push(false)
    }

    // 因子 2：根目录松散文件超过阈值
    if (metrics.rootLevelFileCount >= ROOT_FILE_CLUTTER_THRESHOLD) {
      const excess = metrics.rootLevelFileCount - ROOT_FILE_CLUTTER_THRESHOLD
      // 超出越多，权重越高
      confidence += Math.min(0.30, 0.10 + excess * 0.02)
      activeFactors.push(true)
      log('DEBUG', 'tts_cleanup_file_clutter_detected', {
        rootLevelFiles: metrics.rootLevelFileCount,
        threshold: ROOT_FILE_CLUTTER_THRESHOLD,
      })
    }

    // 因子 3：空目录超过阈值
    if (metrics.emptyDirCount >= EMPTY_DIR_THRESHOLD) {
      confidence += Math.min(0.20, 0.05 + (metrics.emptyDirCount - EMPTY_DIR_THRESHOLD) * 0.02)
      activeFactors.push(true)
    }

    // 因子 4：TTS 队列空或接近空（没有正在播报的内容）
    if (metrics.ttsQueueDepth === 0) {
      confidence += 0.15
      activeFactors.push(true)
    } else if (metrics.ttsQueueDepth <= 3) {
      confidence += 0.05
      activeFactors.push(false)
    } else {
      // 队列深 → 不应切换，有内容要播报
      return null
    }

    // 因子 5：交互频率低
    if (metrics.interactionRate < 5) {
      confidence += 0.10
      activeFactors.push(true)
    }

    // 因子 6：窗口不聚焦（避免在用户活跃时打断）
    if (!behavior.focused) {
      confidence += 0.05
      activeFactors.push(false)
    }

    // 至少需要 3 个积极因子且置信度达标
    const positiveCount = activeFactors.filter(Boolean).length
    if (positiveCount >= 3 && confidence >= PLAN_MODE_MIN_CONFIDENCE) {
      log('INFO', 'tts_cleanup_eval_switch_to_cleanup', {
        confidence: confidence.toFixed(2),
        factors: positiveCount,
        idleMs: metrics.idleTimeMs,
        rootFiles: metrics.rootLevelFileCount,
        emptyDirs: metrics.emptyDirCount,
      })
      return { confidence, debounceMs: SWITCH_DEBOUNCE_MS }
    }

    return null
  }

  /**
   * 评估是否应切回 tts（TTS 语音交互）模式。
   *
   * 触发条件（任一满足即可）：
   * 1. 用户恢复活跃（从 idle/away → active）
   * 2. 交互频率升高（> 5次/分钟）
   * 3. 窗口重新聚焦
   * 4. TTS 有新内容入队
   */
  private evaluateTtsModeConditions(
    metrics: TtsCleanupSwitchDecision['triggerMetrics'],
    behavior: TtsCleanupBehaviorInput,
  ): { confidence: number; reason: TtsCleanupSwitchReason; debounceMs: number } | null {
    let confidence = 0.0
    let reason: TtsCleanupSwitchReason = 'user_became_active'

    // 条件 1：用户恢复到 active 状态
    if (behavior.activityState === 'active') {
      confidence += 0.40
      reason = 'user_became_active'
    }

    // 条件 2：交互频率升高
    if (metrics.interactionRate >= 5) {
      confidence += 0.25
      reason = 'user_became_active'
    }

    // 条件 3：窗口聚焦
    if (behavior.focused) {
      confidence += 0.15
      if (confidence > 0.25) reason = 'user_became_active'
    }

    // 条件 4：TTS 队列有内容（可能外部注入了语音请求）
    if (metrics.ttsQueueDepth > 0) {
      confidence += 0.20
      if (metrics.ttsQueueDepth >= 3) {
        reason = 'tts_queue_deep'
      }
    }

    if (confidence >= 0.50) {
      // 用户恢复活跃 → 立即切换（短防抖）
      const debounceMs = reason === 'user_became_active' ? 3_000 : 10_000
      log('INFO', 'tts_cleanup_eval_switch_to_tts', {
        confidence: confidence.toFixed(2),
        reason,
        idleMs: metrics.idleTimeMs,
        interactionRate: metrics.interactionRate,
      })
      return { confidence, reason, debounceMs }
    }

    return null
  }

  // ==================== 切换执行 ====================

  /**
   * 执行模式切换，包含状态保存和恢复
   */
  private executeSwitch(decision: TtsCleanupSwitchDecision): void {
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
    if (decision.fromMode === 'tts') {
      this.lastTtsSnapshot = snapshot
    } else {
      this.lastCleanupSnapshot = snapshot
    }

    // 6. 发布事件
    const switchEvent: TtsCleanupDualModeSwitchEvent = {
      fromMode: decision.fromMode,
      toMode: decision.toMode,
      reason: decision.reason,
      confidence: decision.confidence,
      snapshot,
      timestamp: now,
    }
    eventBus.emit('behavior.mode.switch', {
      fromMode: switchEvent.fromMode,
      toMode: switchEvent.toMode,
      reason: switchEvent.reason,
      confidence: switchEvent.confidence,
    } as any)

    log('INFO', 'tts_cleanup_mode_switched', {
      from: prevMode,
      to: decision.toMode,
      reason: decision.reason,
      confidence: decision.confidence.toFixed(2),
      durationMs: now - this.modeStartTime,
      triggerMetrics: decision.triggerMetrics,
    })

    // 7. 通知监听器
    this.notifyListeners(decision)
  }

  /**
   * 保存指定模式的当前状态快照
   */
  private saveCurrentState(mode: TtsCleanupModeType): TtsCleanupModeStateSnapshot {
    return {
      mode,
      startedAt: this.modeStartTime,
      savedAt: Date.now(),
      durationMs: Date.now() - this.modeStartTime,
      workspaceStats: null, // 由调用方填充
      ttsQueueDepth: this.lastTriggerMetrics?.ttsQueueDepth ?? 0,
      metadata: {},
    }
  }

  /**
   * 恢复到目标模式时需要的状态恢复操作。
   *
   * plan-cleanup → tts：
   *   在切回 TTS 模式时，如果清理任务正在进行中，应暂停并保存进度。
   * tts → plan-cleanup：
   *   在进入清理模式时，暂停 TTS 流式输出以防噪声。
   */
  private restoreTargetState(targetMode: TtsCleanupModeType): void {
    if (targetMode === 'plan-cleanup') {
      // 进入清理模式：TTS 应暂停或降低优先级
      log('INFO', 'tts_cleanup_restore_cleanup', {
        action: 'pause_tts_for_cleanup',
      })
    } else {
      // 回到 TTS 模式：恢复正常的对话节奏
      log('INFO', 'tts_cleanup_restore_tts', {
        action: 'resume_tts_normal_mode',
      })
    }
  }

  /**
   * 构建切换决策对象
   */
  private buildDecision(
    from: TtsCleanupModeType,
    to: TtsCleanupModeType,
    reason: TtsCleanupSwitchReason,
    confidence: number,
    metrics: TtsCleanupSwitchDecision['triggerMetrics'],
    debounceMs: number,
  ): TtsCleanupSwitchDecision {
    return { fromMode: from, toMode: to, reason, confidence, triggerMetrics: metrics, debounceMs }
  }

  // ==================== 监听器通知 ====================

  private notifyListeners(decision: TtsCleanupSwitchDecision): void {
    for (const listener of this.modeChangeListeners) {
      try {
        listener(decision)
      } catch (err: any) {
        log('WARN', 'tts_cleanup_listener_error', { error: String(err) })
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
      lastTriggerMetrics: this.lastTriggerMetrics,
      lastTtsSnapshotAge: this.lastTtsSnapshot
        ? Date.now() - this.lastTtsSnapshot.savedAt
        : null,
      lastCleanupSnapshotAge: this.lastCleanupSnapshot
        ? Date.now() - this.lastCleanupSnapshot.savedAt
        : null,
    }
  }
}

// =============================================================================
// 全局单例
// =============================================================================

export const ttsCleanupDualModeController = new TtsCleanupDualModeController()
