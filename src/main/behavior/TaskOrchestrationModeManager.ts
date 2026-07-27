/**
 * TaskOrchestrationModeManager — 行为驱动的动态任务编排模式管理器
 *
 * ── 职责 ──
 * 根据用户的交互行为（工具取消、重试、求助等信号），自动切换任务执行模式，
 * 使 Agent 在不同情境下提供合适粒度的交互体验。
 *
 * ── 信号类型 ──
 * - cancellation:  用户中断/取消当前工具执行（interrupt / stop）
 * - retry:         同一工具连续失败重试（consecutive failures）
 * - help:          用户明确求助或表达困惑（"怎么办"、"帮我"、"我不懂" 等）
 *
 * ── 状态机 ──
 * Normal（正常模式）
 *   → [2 次连续失败/重试] → Simplified（简化模式）
 *     → [3 次连续求助] → Guided（引导模式）
 *     → [5 轮连续成功] → Normal
 *   Guided（引导模式）
 *     → [2 轮连续无求助且无失败] → Simplified
 *     → [5 轮连续成功] → Normal
 *
 * ── 自适应行为建议 ──
 * 不同模式下向 ChatExecutor.toolLoop 提供不同建议：
 * - Normal:    无额外限制
 * - Simplified: 减少工具链长度、禁用复杂工具
 * - Guided:     增加解释步骤、插入确认性问题
 *
 * ── 集成 ──
 * const modeManager = taskOrchestrationModeManager
 * modeManager.recordToolBatchResult(toolResults)     // 每轮工具执行后调用
 * modeManager.recordUserMessage(text)                // 每轮用户消息后调用
 * const mode = modeManager.getCurrentMode()          // 获取当前模式
 * modeManager.shouldInsertProbingQuestion()          // 是否应插入确认性问题
 *
 * @module behavior
 */

import { log } from '../logger/Logger'
import { eventBus } from '../core/EventBus'

// ══════════════════════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════════════════════

/** 任务编排模式 */
export type TaskOrchestrationMode = 'normal' | 'simplified' | 'guided'

/** 行为信号类型 */
export type BehaviorSignalType = 'cancellation' | 'retry' | 'help'

/** 记录的单次行为信号 */
export interface BehaviorSignal {
  /** 信号类型 */
  type: BehaviorSignalType
  /** 信号发生时间 */
  timestamp: number
  /** 关联的工具名（cancellation/retry 时） */
  toolName?: string
  /** 关联的用户消息（help 时） */
  userMessage?: string
}

/** 模式切换事件载荷 */
export interface OrchestrationModeChangedEvent {
  /** 来源模式 */
  fromMode: TaskOrchestrationMode
  /** 目标模式 */
  toMode: TaskOrchestrationMode
  /** 切换原因 */
  reason: string
  /** 触发该次切换的信号快照 */
  signalSnapshot: {
    consecutiveCancellations: number
    consecutiveRetries: number
    consecutiveHelp: number
  }
  /** 时间戳 */
  timestamp: number
}

/** 模式管理器可配置参数 */
export interface OrchestrationConfig {
  /** 连续失败次数 → Simplified 模式的阈值（默认 2） */
  failuresToSimplify: number
  /** 连续求助次数 → Guided 模式的阈值（默认 3） */
  helpToGuide: number
  /** 连续成功轮次 → 恢复 Normal 的阈值（默认 5） */
  successToNormal: number
  /** 连续无求助/无失败轮次 → 从 Guided 降级到 Simplified 的阈值（默认 2） */
  calmToSimplified: number
  /** 信号衰减时间 ms（超过此时间的信号不再计入连续计数）（默认 5 分钟） */
  signalDecayMs: number
  /** 探测性问题是否启用（默认 true） */
  probingQuestionEnabled: boolean
}

// ══════════════════════════════════════════════════════════
//  默认配置
// ══════════════════════════════════════════════════════════

const DEFAULT_CONFIG: OrchestrationConfig = {
  failuresToSimplify: 2,
  helpToGuide: 3,
  successToNormal: 5,
  calmToSimplified: 2,
  signalDecayMs: 300_000, // 5 分钟
  probingQuestionEnabled: true,
}

/** 帮助信号检测关键词 */
const HELP_KEYWORDS = [
  /帮[我助]/, /怎么[弄做办玩]/, /如何[操作实现]/, /不懂/, /不明白/,
  /不会/, /教[我导]/, /指导/, /求助/, /help/i,
  /步骤/, /具体[说讲]/, /什么意思/, /解释/, /说明/,
  /卡[住壳]/, /进[展行]不下[去了]/, /停[住顿]/, /错了/,
  /再试/, /又[失败错]/, /还[是不]行/,
  /为什么/, /原因/, /哪里[不对错]/, /正确[的做法]?/,
]

// ══════════════════════════════════════════════════════════
//  TaskOrchestrationModeManager
// ══════════════════════════════════════════════════════════

export class TaskOrchestrationModeManager {
  private config: OrchestrationConfig
  private currentMode: TaskOrchestrationMode = 'normal'
  private modeStartTime = Date.now()

  /** 信号滚动缓冲区（最多保留 50 条） */
  private signalBuffer: BehaviorSignal[] = []

  /** 连续成功轮次（用于恢复判定） */
  private consecutiveSuccessRounds = 0

  /** 连续无求助且无失败的轮次（用于 Guided → Simplified 降级） */
  private consecutiveCalmRounds = 0

  /** 当前轮是否有失败/重试 */
  private currentRoundHasFailure = false

  /** 当前轮是否有求助信号 */
  private currentRoundHasHelp = false

  /** 最近一次模式变更的原因 */
  private lastModeChangeReason = 'startup'

  /** 模式变更监听器 */
  private readonly modeChangeListeners: Array<(event: OrchestrationModeChangedEvent) => void> = []

  constructor(config?: Partial<OrchestrationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  // ══════════════════════════════════════════════════════════
  //  公共 API
  // ══════════════════════════════════════════════════════════

  /** 获取当前编排模式 */
  getCurrentMode(): TaskOrchestrationMode {
    return this.currentMode
  }

  /** 获取当前模式的本地化名称 */
  getCurrentModeLabel(): string {
    const labels: Record<TaskOrchestrationMode, string> = {
      normal: '正常模式',
      simplified: '简化模式',
      guided: '引导模式',
    }
    return labels[this.currentMode]
  }

  /** 获取模式已持续时长 ms */
  getModeDurationMs(): number {
    return Date.now() - this.modeStartTime
  }

  /** 获取当前信号统计 */
  getSignalStats(): {
    consecutiveCancellations: number
    consecutiveRetries: number
    consecutiveHelp: number
    totalSignals: number
  } {
    return {
      consecutiveCancellations: this.countConsecutive('cancellation'),
      consecutiveRetries: this.countConsecutive('retry'),
      consecutiveHelp: this.countConsecutive('help'),
      totalSignals: this.signalBuffer.length,
    }
  }

  /** 获取当前配置 */
  getConfig(): Readonly<OrchestrationConfig> {
    return { ...this.config }
  }

  /** 更新配置 */
  updateConfig(patch: Partial<OrchestrationConfig>): void {
    this.config = { ...this.config, ...patch }
  }

  /**
   * 注册模式变更监听器
   * @returns disposer 函数
   */
  onModeChange(listener: (event: OrchestrationModeChangedEvent) => void): () => void {
    this.modeChangeListeners.push(listener)
    return () => {
      const idx = this.modeChangeListeners.indexOf(listener)
      if (idx >= 0) this.modeChangeListeners.splice(idx, 1)
    }
  }

  // ══════════════════════════════════════════════════════════
  //  信号记录
  // ══════════════════════════════════════════════════════════

  /**
   * 记录新一轮工具执行结果。
   * ChatExecutor 在每轮 toolResults 返回后调用。
   * 根据成功/失败情况自动检测 cancellation 和 retry 信号。
   */
  recordToolBatchResult(
    toolResults: Array<{ name: string; success: boolean; error?: string }>,
  ): void {
    this.currentRoundHasFailure = false

    const allSuccess = toolResults.length > 0 && toolResults.every((r) => r.success)

    if (allSuccess) {
      // 全部成功 → 增加连续成功计数
      this.consecutiveSuccessRounds++
      this.consecutiveCalmRounds++
    } else {
      this.consecutiveSuccessRounds = 0

      // 有失败 → 记录重试信号
      const failedTools = toolResults.filter((r) => !r.success)
      for (const ft of failedTools) {
        this.addSignal('retry', ft.name)
      }
      this.currentRoundHasFailure = true
      this.consecutiveCalmRounds = 0
    }

    // 衰减老化信号
    this.decaySignals()

    // 评估模式切换
    this.evaluateTransition('tool_batch_completed')
  }

  /**
   * 记录取消信号（用户中断工具执行）。
   * ChatExecutor 收到中断时调用。
   */
  recordCancellation(toolName?: string): void {
    this.addSignal('cancellation', toolName)
    this.consecutiveSuccessRounds = 0
    this.evaluateTransition('cancellation')
  }

  /**
   * 记录用户消息并检测求助/困惑信号。
   * ChatExecutor.run() 收到用户消息时调用。
   */
  recordUserMessage(text: string): void {
    // 检测求助信号
    if (this.detectHelpSignal(text)) {
      this.addSignal('help', undefined, text)
      this.currentRoundHasHelp = true
      this.consecutiveCalmRounds = 0
      this.evaluateTransition('help_signal')
    }
  }

  /**
   * 记录一次明确的帮助请求（供外部调用，如用户点击"帮助"按钮）。
   */
  recordExplicitHelp(): void {
    this.addSignal('help')
    this.currentRoundHasHelp = true
    this.consecutiveCalmRounds = 0
    this.evaluateTransition('explicit_help')
  }

  /**
   * 标记新一轮的开始（重置本轮状态）。
   * 在 toolLoop 每轮开始时调用。
   */
  startNewRound(): void {
    this.currentRoundHasFailure = false
    this.currentRoundHasHelp = false
  }

  // ══════════════════════════════════════════════════════════
  //  查询接口（供 ChatExecutor.toolLoop 使用）
  // ══════════════════════════════════════════════════════════

  /**
   * 判断是否应插入一个探测性问题来确认用户意图。
   * 条件：连续 3 次求助信号且当前处于 simplified 或 guided 模式。
   */
  shouldInsertProbingQuestion(): boolean {
    if (!this.config.probingQuestionEnabled) return false
    const consecutiveHelp = this.countConsecutive('help')
    return consecutiveHelp >= this.config.helpToGuide
  }

  /**
   * 获取当前模式下针对 toolLoop 的行为建议。
   */
  getModeRecommendations(): {
    /** 是否应减少工具调用链长度 */
    reduceToolChain: boolean
    /** 是否应增加解释步骤 */
    addExplanation: boolean
    /** 是否应注入简单提示 */
    simplifyPrompt: boolean
    /** 是否应插入确认性问题 */
    insertProbingQuestion: boolean
    /** 探测性问题文本（仅在 shouldInsertProbingQuestion 为 true 时有效） */
    probingQuestionText: string
    /** 建议的额外 system prompt 片段 */
    extraPromptModules: string[]
  } {
    const signalStats = this.getSignalStats()
    const shouldProbe = this.shouldInsertProbingQuestion()

    switch (this.currentMode) {
      case 'simplified':
        return {
          reduceToolChain: true,
          addExplanation: false,
          simplifyPrompt: true,
          insertProbingQuestion: shouldProbe,
          probingQuestionText: this.buildProbingQuestion(),
          extraPromptModules: [
            '【简化模式】请使用最简短的步骤完成任务，每次只调用 1-2 个关键工具。',
            '避免复杂的多步骤工具链，优先使用直接方法。',
          ],
        }
      case 'guided':
        return {
          reduceToolChain: true,
          addExplanation: true,
          simplifyPrompt: true,
          insertProbingQuestion: shouldProbe,
          probingQuestionText: this.buildProbingQuestion(),
          extraPromptModules: [
            '【引导模式】请在每一步执行前解释即将执行的操作及其目的。',
            '使用分步方式，每完成一小步就确认用户是否理解。',
            '如果用户表示困惑，请主动询问具体哪个部分需要进一步说明。',
          ],
        }
      default: // normal
        return {
          reduceToolChain: false,
          addExplanation: false,
          simplifyPrompt: false,
          insertProbingQuestion: shouldProbe,
          probingQuestionText: '',
          extraPromptModules: [],
        }
    }
  }

  /**
   * 重置管理器状态（如会话切换时）。
   */
  reset(): void {
    this.currentMode = 'normal'
    this.modeStartTime = Date.now()
    this.signalBuffer = []
    this.consecutiveSuccessRounds = 0
    this.consecutiveCalmRounds = 0
    this.currentRoundHasFailure = false
    this.currentRoundHasHelp = false
    this.lastModeChangeReason = 'reset'
    log('INFO', 'orchestration_mode_reset')
  }

  // ══════════════════════════════════════════════════════════
  //  内部方法
  // ══════════════════════════════════════════════════════════

  /**
   * 添加一条行为信号记录。
   */
  private addSignal(type: BehaviorSignalType, toolName?: string, userMessage?: string): void {
    const signal: BehaviorSignal = {
      type,
      timestamp: Date.now(),
      toolName,
      userMessage,
    }
    this.signalBuffer.push(signal)
    if (this.signalBuffer.length > 50) {
      this.signalBuffer.shift()
    }
    log('DEBUG', 'orchestration_signal_recorded', {
      type,
      toolName,
      signalCount: this.signalBuffer.length,
    })
  }

  /**
   * 衰减老化信号：移除超出衰减时间的信号。
   */
  private decaySignals(): void {
    const cutoff = Date.now() - this.config.signalDecayMs
    const before = this.signalBuffer.length
    this.signalBuffer = this.signalBuffer.filter((s) => s.timestamp > cutoff)
    if (this.signalBuffer.length < before) {
      log('DEBUG', 'orchestration_signals_decayed', {
        removed: before - this.signalBuffer.length,
        remaining: this.signalBuffer.length,
      })
    }
  }

  /**
   * 计算指定类型信号的连续出现次数。
   * 从信号缓冲区尾部向前扫描，只统计连续同类型信号。
   */
  private countConsecutive(type: BehaviorSignalType): number {
    let count = 0
    for (let i = this.signalBuffer.length - 1; i >= 0; i--) {
      if (this.signalBuffer[i].type === type) {
        count++
      } else {
        break // 类型变了就不再连续
      }
    }
    return count
  }

  /**
   * 检测用户消息是否包含求助/困惑信号。
   */
  private detectHelpSignal(text: string): boolean {
    if (!text || text.length < 2) return false
    return HELP_KEYWORDS.some((pattern) => pattern.test(text))
  }

  /**
   * 评估并执行模式切换。
   */
  private evaluateTransition(trigger: string): void {
    const prevMode = this.currentMode
    let newMode: TaskOrchestrationMode | null = null
    let reason = ''

    const consecutiveCancellations = this.countConsecutive('cancellation')
    const consecutiveRetries = this.countConsecutive('retry')
    const consecutiveHelp = this.countConsecutive('help')

    switch (this.currentMode) {
      case 'normal':
        // Normal → Simplified: 连续 2 次失败/重试
        if (consecutiveRetries >= this.config.failuresToSimplify || consecutiveCancellations >= this.config.failuresToSimplify) {
          newMode = 'simplified'
          reason = `检测到连续 ${consecutiveRetries} 次重试 / ${consecutiveCancellations} 次取消，切换为简化模式`
        }
        break

      case 'simplified':
        // Simplified → Guided: 连续 3 次求助
        if (consecutiveHelp >= this.config.helpToGuide) {
          newMode = 'guided'
          reason = `检测到连续 ${consecutiveHelp} 次求助信号，切换为引导模式`
        }
        // Simplified → Normal: 连续 5 轮全部成功
        else if (this.consecutiveSuccessRounds >= this.config.successToNormal) {
          newMode = 'normal'
          reason = `连续 ${this.consecutiveSuccessRounds} 轮全部成功，恢复正常模式`
        }
        break

      case 'guided':
        // Guided → Simplified: 连续 2 轮无求助且无失败
        if (this.consecutiveCalmRounds >= this.config.calmToSimplified) {
          newMode = 'simplified'
          reason = `连续 ${this.consecutiveCalmRounds} 轮平静无异常，降级为简化模式`
        }
        // Guided → Normal: 连续 5 轮全部成功
        else if (this.consecutiveSuccessRounds >= this.config.successToNormal) {
          newMode = 'normal'
          reason = `连续 ${this.consecutiveSuccessRounds} 轮全部成功，恢复正常模式`
        }
        break
    }

    if (newMode && newMode !== prevMode) {
      this.transitionTo(newMode, reason, {
        consecutiveCancellations,
        consecutiveRetries,
        consecutiveHelp,
      })
    }
  }

  /**
   * 执行模式切换。
   */
  private transitionTo(
    newMode: TaskOrchestrationMode,
    reason: string,
    signalSnapshot: OrchestrationModeChangedEvent['signalSnapshot'],
  ): void {
    const fromMode = this.currentMode
    this.currentMode = newMode
    this.modeStartTime = Date.now()
    this.lastModeChangeReason = reason
    this.consecutiveSuccessRounds = 0
    this.consecutiveCalmRounds = 0

    const event: OrchestrationModeChangedEvent = {
      fromMode,
      toMode: newMode,
      reason,
      signalSnapshot,
      timestamp: Date.now(),
    }

    // 日志
    log('INFO', 'orchestration_mode_changed', {
      from: fromMode,
      to: newMode,
      reason,
      signals: signalSnapshot,
    })

    // 发射 EventBus 事件
    eventBus.emit('behavior.orchestration.mode_changed' as any, event)

    // 通知监听器
    this.notifyListeners(event)
  }

  /**
   * 构建探测性问题文本。
   */
  private buildProbingQuestion(): string {
    return '我发现您可能对这个任务有疑问。请问您希望我：\n1. 换个更简单的方式解释当前步骤？\n2. 确认一下您想要的具体目标是什么？\n3. 把任务拆分成更小的步骤一步步来？'
  }

  /**
   * 通知所有模式变更监听器。
   */
  private notifyListeners(event: OrchestrationModeChangedEvent): void {
    for (const listener of this.modeChangeListeners) {
      try {
        listener(event)
      } catch (err: any) {
        log('WARN', 'orchestration_mode_listener_error', { error: String(err) })
      }
    }
  }
}

// ══════════════════════════════════════════════════════════
//  全局单例
// ══════════════════════════════════════════════════════════

/**
 * 全局 TaskOrchestrationModeManager 单例。
 * ChatExecutor 在启动时引用此实例。
 */
export const taskOrchestrationModeManager = new TaskOrchestrationModeManager()
