/**
 * ToolFeedbackLoop — MCP ↔ UserBehavior 强化回路
 *
 * 职责：
 * 1. 订阅 EventBus 的 agent.tool.completed / agent.tool.failed 事件
 * 2. 将 MCP 工具执行结果作为反馈信号消费，记录到 UserBehaviorAnalyzer
 * 3. 使用 EMA（指数移动平均）跟踪每个工具的执行质量指标
 * 4. 应用阻尼机制防止反馈振荡发散
 * 5. 调整 UserBehaviorAnalyzer 的 suppress/confirm 策略
 * 6. 收敛后自动运行，初始阶段支持人工监控
 *
 * 回路循环：
 *   MCP 工具执行 → EventBus 事件 → ToolFeedbackLoop
 *     → UserBehaviorAnalyzer 质量记录 → 阻尼分析
 *     → suppress/confirm 调整 → 影响下次 MCP 执行
 *
 * 阻尼机制：
 * - EMA 平滑：alpha 默认 0.3，可配置
 * - 最小样本量：达到前不输出调整
 * - 收敛检测：EMA 变化率持续低于阈值
 * - 振荡防护：方向变化超过 N 次/窗口时降低 alpha
 * - 滞回区：suppress/confirm 状态切换需跨越阈值带
 */

import { log } from '../logger/Logger'
import { eventBus } from '../core/EventBus'
import type { EventPayload } from '../core/EventBus'
import { userBehaviorAnalyzer } from '../agent/UserBehaviorAnalyzer'

// ══════════════════════════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════════════════════════

/** 单次工具执行反馈记录（内部使用） */
interface ToolFeedbackSample {
  toolName: string
  success: boolean
  timestamp: number
  error?: string
}

/** ETF（指数移动平均）质量状态 */
interface EMAQualityState {
  /** 当前 EMA 成功率（0-1） */
  emaSuccessRate: number
  /** 累计样本数 */
  sampleCount: number
  /** 上次更新时间戳 */
  lastUpdated: number
  /** 最近 N 次方向变化（用于振荡检测） */
  recentDirectionChanges: number[]
  /** 上一次的 EMA 值（用于收敛检测） */
  prevEmaValue: number
  /** 当前是否已被抑制 */
  isSuppressed: boolean
  /** 当前是否已被确认 */
  isConfirmed: boolean
  /** 上次策略调整时间戳 */
  lastAdjustmentTime: number
  /** 平滑后的平均延迟 ms（预留字段） */
  smoothedLatencyMs?: number
  /** 错误模式标签（最新 N 条错误的关键词） */
  recentErrorPatterns: string[]
}

// ══════════════════════════════════════════════════════════════
//  配置常量
// ══════════════════════════════════════════════════════════════

/** EMA 平滑因子（默认 0.3 = 更依赖近期数据） */
const DEFAULT_ALPHA = 0.3

/** 最小样本量：达到后输出第一次调整建议 */
const MIN_SAMPLES_FOR_ADJUSTMENT = 5

/** 抑制触发阈值：EMA 成功率低于此值触发自动抑制 */
const SUPPRESS_THRESHOLD = 0.4

/** 取消抑制阈值：EMA 成功率高于此值取消抑制（滞回区 [0.4, 0.65]） */
const UNSUPPRESS_THRESHOLD = 0.65

/** 自动确认阈值：EMA 成功率高于此值且样本充足时自动确认 */
const AUTO_CONFIRM_THRESHOLD = 0.9

/** 取消确认阈值：EMA 成功率低于此值取消确认（滞回区 [0.75, 0.9]） */
const UNCONFIRM_THRESHOLD = 0.75

/** 收敛检测：最近 N 个样本的 EMA 变化率均低于此值视为收敛 */
const CONVERGENCE_RATE_THRESHOLD = 0.02

/** 收敛检测窗口大小 */
const CONVERGENCE_WINDOW = 5

/** 振荡防护：最近 N 个样本中方向变化超过此值 → 降低 alpha */
const OSCILLATION_DIRECTION_CHANGES = 4

/** 振荡检测窗口 */
const OSCILLATION_WINDOW = 10

/** 振荡时降低到的基础 alpha */
const OSCILLATION_REDUCED_ALPHA = 0.1

/** 评估周期 ms（默认 30s，不每次事件都评估） */
const EVALUATION_INTERVAL_MS = 30_000

/** 错误模式提取：错误中匹配以下关键词时记录 */
const ERROR_PATTERNS = [
  { pattern: /timeout|超时|timed? ?out/i, label: 'timeout' },
  { pattern: /not found|不存在|找不到|no such/i, label: 'not_found' },
  { pattern: /permission|denied|forbidden|拒绝|权限/i, label: 'permission' },
  { pattern: /connection|refused|断开|connect/i, label: 'connection' },
  { pattern: /parse|syntax|invalid|格式|语法|无效/i, label: 'parse_error' },
  { pattern: /memory|OOM|out of memory/i, label: 'memory' },
  { pattern: /rate limit|too many|限流|频率/i, label: 'rate_limit' },
]

// ══════════════════════════════════════════════════════════════
//  ToolFeedbackLoop
// ══════════════════════════════════════════════════════════════

export interface ToolFeedbackLoopConfig {
  /** EMA 平滑因子（0-1），默认 0.3 */
  alpha?: number
  /** 最小样本量，默认 5 */
  minSamples?: number
  /** 抑制阈值，默认 0.4 */
  suppressThreshold?: number
  /** 取消抑制阈值（滞回区上限），默认 0.65 */
  unsuppressThreshold?: number
  /** 自动确认阈值，默认 0.9 */
  autoConfirmThreshold?: number
  /** 评估间隔 ms，默认 30000 */
  evaluationIntervalMs?: number
  /** 调试模式 */
  debug?: boolean
  /** 初始运行模式：'manual'（人工监控）| 'auto'（自动运行） */
  mode?: 'manual' | 'auto'
}

export interface ToolQualityReport {
  toolName: string
  emaSuccessRate: number
  sampleCount: number
  isSuppressed: boolean
  isConfirmed: boolean
  lastAdjustmentTime: number
  errorPatterns: string[]
  convergenceStatus: 'converging' | 'stable' | 'oscillating' | 'insufficient_data'
  recommendedAction: 'none' | 'suppress' | 'unsuppress' | 'confirm' | 'unconfirm'
}

export interface FeedbackLoopDiagnostics {
  mode: 'manual' | 'auto'
  alpha: number
  totalSamplesTracked: number
  toolsTracked: string[]
  suppressedTools: string[]
  confirmedTools: string[]
  recentAdjustments: Array<{ tool: string; action: string; at: number; reason: string }>
  reports: ToolQualityReport[]
}

export class ToolFeedbackLoop {
  private config: Required<ToolFeedbackLoopConfig>
  private qualityStates = new Map<string, EMAQualityState>()
  private disposers: Array<() => void> = []
  private lastEvaluationTime = 0
  private recentAdjustments: Array<{ tool: string; action: string; at: number; reason: string }> = []
  private static readonly MAX_ADJUSTMENTS = 50

  constructor(config?: ToolFeedbackLoopConfig) {
    this.config = {
      alpha: config?.alpha ?? DEFAULT_ALPHA,
      minSamples: config?.minSamples ?? MIN_SAMPLES_FOR_ADJUSTMENT,
      suppressThreshold: config?.suppressThreshold ?? SUPPRESS_THRESHOLD,
      unsuppressThreshold: config?.unsuppressThreshold ?? UNSUPPRESS_THRESHOLD,
      autoConfirmThreshold: config?.autoConfirmThreshold ?? AUTO_CONFIRM_THRESHOLD,
      evaluationIntervalMs: config?.evaluationIntervalMs ?? EVALUATION_INTERVAL_MS,
      debug: config?.debug ?? false,
      mode: config?.mode ?? 'manual',
    }
    log('INFO', 'tool_feedback_loop_created', {
      mode: this.config.mode,
      alpha: this.config.alpha,
      minSamples: this.config.minSamples,
    })
  }

  // ══════════════════════════════════════════════════════════════
  //  生命周期
  // ══════════════════════════════════════════════════════════════

  /** 启动反馈回路：订阅 EventBus 工具事件 */
  start(): void {
    this.disposers.push(
      eventBus.on('agent.tool.completed', (p: EventPayload['agent.tool.completed']) => this.onToolCompleted(p)),
      eventBus.on('agent.tool.failed', (p: EventPayload['agent.tool.failed']) => this.onToolFailed(p)),
    )
    log('INFO', 'tool_feedback_loop_started', {
      mode: this.config.mode,
    })
  }

  /** 停止反馈回路：取消所有订阅 */
  stop(): void {
    for (const dispose of this.disposers) {
      try { dispose() } catch { /* 静默清理 */ }
    }
    this.disposers = []
    this.qualityStates.clear()
    log('INFO', 'tool_feedback_loop_stopped')
  }

  /** 切换运行模式 */
  setMode(mode: 'manual' | 'auto'): void {
    this.config.mode = mode
    log('INFO', 'tool_feedback_loop_mode_changed', { mode })
  }

  /** 更新配置 */
  updateConfig(patch: Partial<ToolFeedbackLoopConfig>): void {
    if (patch.alpha !== undefined) this.config.alpha = patch.alpha
    if (patch.minSamples !== undefined) this.config.minSamples = patch.minSamples
    if (patch.suppressThreshold !== undefined) this.config.suppressThreshold = patch.suppressThreshold
    if (patch.unsuppressThreshold !== undefined) this.config.unsuppressThreshold = patch.unsuppressThreshold
    if (patch.autoConfirmThreshold !== undefined) this.config.autoConfirmThreshold = patch.autoConfirmThreshold
    if (patch.evaluationIntervalMs !== undefined) this.config.evaluationIntervalMs = patch.evaluationIntervalMs
    if (patch.debug !== undefined) this.config.debug = patch.debug
    if (patch.mode !== undefined) this.config.mode = patch.mode
    log('INFO', 'tool_feedback_loop_config_updated', { alpha: this.config.alpha, mode: this.config.mode })
  }

  // ══════════════════════════════════════════════════════════════
  //  事件处理
  // ══════════════════════════════════════════════════════════════

  private onToolCompleted(p: EventPayload['agent.tool.completed']): void {
    this.recordSample(p.tool, true, undefined)
  }

  private onToolFailed(p: EventPayload['agent.tool.failed']): void {
    this.recordSample(p.tool, false, p.error)
  }

  /**
   * 记录一次工具执行样本到内部状态机 + UserBehaviorAnalyzer。
   * 这是反馈回路的入口：MCP 输出 → UserBehavior 消费。
   */
  private recordSample(toolName: string, success: boolean, error?: string): void {
    const now = Date.now()

    // 1. 输出到 UserBehaviorAnalyzer（记录质量信息）
    userBehaviorAnalyzer.recordToolCallResult(toolName, success, error)

    // 2. 更新内部 EMA 状态
    let state = this.qualityStates.get(toolName)
    if (!state) {
      state = {
        emaSuccessRate: success ? 1 : 0,
        sampleCount: 1,
        lastUpdated: now,
        recentDirectionChanges: [],
        prevEmaValue: success ? 1 : 0,
        isSuppressed: false,
        isConfirmed: false,
        lastAdjustmentTime: 0,
        recentErrorPatterns: [],
      }
      this.qualityStates.set(toolName, state)
    } else {
      const prevEma = state.emaSuccessRate
      state.sampleCount++
      state.prevEmaValue = prevEma

      // 检测方向变化（用于振荡防护）
      const newEma = this.computeEMA(prevEma, success ? 1 : 0)
      const direction = newEma > prevEma ? 1 : (newEma < prevEma ? -1 : 0)
      if (direction !== 0) {
        state.recentDirectionChanges.push(direction)
        // 保持窗口大小
        if (state.recentDirectionChanges.length > OSCILLATION_WINDOW) {
          state.recentDirectionChanges = state.recentDirectionChanges.slice(-OSCILLATION_WINDOW)
        }
      }

      state.emaSuccessRate = newEma
      state.lastUpdated = now

      // 记录错误模式
      if (!success && error) {
        this.recordErrorPattern(state, error)
      }
    }

    // 3. 定期执行策略评估（节流）
    if (now - this.lastEvaluationTime >= this.config.evaluationIntervalMs) {
      this.lastEvaluationTime = now
      this.evaluateAll().catch((err) =>
        log('WARN', 'tool_feedback_evaluation_error', { error: String(err) })
      )
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  EMA 计算
  // ══════════════════════════════════════════════════════════════

  /**
   * 计算 EMA：new = α × value + (1-α) × prev
   * 自动根据振荡状态调整 alpha。
   */
  private computeEMA(prev: number, value: number): number {
    const alpha = this.getEffectiveAlpha()
    return alpha * value + (1 - alpha) * prev
  }

  /**
   * 获取当前有效 alpha。
   * 如果检测到振荡，降低 alpha 以增加阻尼。
   */
  private getEffectiveAlpha(): number {
    if (this.detectOscillation()) {
      return OSCILLATION_REDUCED_ALPHA
    }
    return this.config.alpha
  }

  /**
   * 振荡检测：如果大多数工具的方向变化频繁，降低全局 alpha。
   * 检查所有样本充足的工具在振荡窗口内的方向变化次数。
   */
  private detectOscillation(): boolean {
    let oscillatingCount = 0
    let qualifiedCount = 0

    for (const state of this.qualityStates.values()) {
      if (state.sampleCount < this.config.minSamples) continue
      qualifiedCount++

      const changes = state.recentDirectionChanges.slice(-OSCILLATION_WINDOW)
      if (changes.length < 4) continue

      // 计算方向变化次数（相邻方向不同的次数）
      let flipCount = 0
      for (let i = 1; i < changes.length; i++) {
        if (changes[i] !== 0 && changes[i] !== changes[i - 1]) {
          flipCount++
        }
      }
      if (flipCount >= OSCILLATION_DIRECTION_CHANGES) {
        oscillatingCount++
      }
    }

    // 如果有至少一个工具在振荡，降低 alpha
    return oscillatingCount > 0 && qualifiedCount > 0
  }

  // ══════════════════════════════════════════════════════════════
  //  策略评估
  // ══════════════════════════════════════════════════════════════

  /**
   * 评估所有工具的质量状态，输出调整建议。
   * auto 模式：自动执行调整
   * manual 模式：仅记录日志供人工监控
   */
  private async evaluateAll(): Promise<void> {
    const reports = this.generateReports()
    const adjustments: Array<{ tool: string; action: string; reason: string }> = []

    for (const report of reports) {
      if (report.recommendedAction === 'none') continue

      adjustments.push({
        tool: report.toolName,
        action: report.recommendedAction,
        reason: this.describeRecommendation(report),
      })

      // auto 模式：执行调整
      if (this.config.mode === 'auto') {
        this.applyAdjustment(report)
      }
    }

    // 记录日志
    if (adjustments.length > 0) {
      log('INFO', 'tool_feedback_adjustments', {
        mode: this.config.mode,
        count: adjustments.length,
        adjustments: adjustments.map((a) => `${a.tool}→${a.action}`).join(', '),
        applied: this.config.mode === 'auto',
      })

      if (this.config.debug) {
        for (const adj of adjustments) {
          log('DEBUG', 'tool_feedback_adjustment_detail', adj)
        }
      }
    }
  }

  /**
   * 生成所有工具的质量报告。
   * 包含收敛状态和建议动作。
   */
  generateReports(): ToolQualityReport[] {
    const reports: ToolQualityReport[] = []

    for (const [toolName, state] of this.qualityStates) {
      const convergenceStatus = this.detectConvergence(state)
      const recommendedAction = this.determineRecommendedAction(state, convergenceStatus)

      reports.push({
        toolName,
        emaSuccessRate: Math.round(state.emaSuccessRate * 1000) / 1000,
        sampleCount: state.sampleCount,
        isSuppressed: state.isSuppressed,
        isConfirmed: state.isConfirmed,
        lastAdjustmentTime: state.lastAdjustmentTime,
        errorPatterns: [...state.recentErrorPatterns],
        convergenceStatus,
        recommendedAction,
      })
    }

    // 按样本量降序排列
    reports.sort((a, b) => b.sampleCount - a.sampleCount)

    return reports
  }

  /**
   * 检测单个工具的收敛状态。
   */
  private detectConvergence(state: EMAQualityState): ToolQualityReport['convergenceStatus'] {
    if (state.sampleCount < this.config.minSamples) {
      return 'insufficient_data'
    }

    // 检查振荡
    const changes = state.recentDirectionChanges.slice(-OSCILLATION_WINDOW)
    if (changes.length >= 4) {
      let flipCount = 0
      for (let i = 1; i < changes.length; i++) {
        if (changes[i] !== 0 && changes[i] !== changes[i - 1]) {
          flipCount++
        }
      }
      if (flipCount >= OSCILLATION_DIRECTION_CHANGES) {
        return 'oscillating'
      }
    }

    // 检查收敛：最近 CONVERGENCE_WINDOW 个样本的变化率
    const recentChanges = state.recentDirectionChanges.slice(-CONVERGENCE_WINDOW)
    if (recentChanges.length < CONVERGENCE_WINDOW) {
      return 'converging'
    }

    // 如果所有最近的方向变化都是 0（稳定）或变化率极小
    const allStable = recentChanges.every((c) => c === 0)
    if (allStable) {
      return 'stable'
    }

    return 'converging'
  }

  /**
   * 根据质量状态和收敛状态决定建议动作。
   * 使用滞回区避免频繁切换。
   */
  private determineRecommendedAction(
    state: EMAQualityState,
    convergenceStatus: ToolQualityReport['convergenceStatus'],
  ): ToolQualityReport['recommendedAction'] {
    if (state.sampleCount < this.config.minSamples) {
      return 'none'
    }

    const rate = state.emaSuccessRate
    const { suppressThreshold, unsuppressThreshold, autoConfirmThreshold, unconfirmThreshold } = this.config

    // 当前已抑制 → 检查是否可以取消抑制
    if (state.isSuppressed) {
      if (rate >= unsuppressThreshold && convergenceStatus !== 'oscillating') {
        return 'unsuppress'
      }
      return 'none'
    }

    // 当前已确认 → 检查是否需要取消确认
    if (state.isConfirmed) {
      if (rate < unconfirmThreshold && convergenceStatus !== 'oscillating') {
        return 'unconfirm'
      }
      return 'none'
    }

    // 未抑制也未确认 → 检查是否需要抑制或确认
    if (rate < suppressThreshold && convergenceStatus !== 'oscillating') {
      return 'suppress'
    }

    if (rate >= autoConfirmThreshold && convergenceStatus === 'stable') {
      return 'confirm'
    }

    return 'none'
  }

  /**
   * 执行一项调整（auto 模式）。
   */
  private applyAdjustment(report: ToolQualityReport): void {
    const state = this.qualityStates.get(report.toolName)
    if (!state) return

    const now = Date.now()
    const reason = this.describeRecommendation(report)

    switch (report.recommendedAction) {
      case 'suppress':
        userBehaviorAnalyzer.suppressTool(report.toolName)
        state.isSuppressed = true
        state.lastAdjustmentTime = now
        break

      case 'unsuppress':
        userBehaviorAnalyzer.unsuppressTool(report.toolName)
        state.isSuppressed = false
        state.lastAdjustmentTime = now
        break

      case 'confirm':
        userBehaviorAnalyzer.confirmTool(report.toolName)
        state.isConfirmed = true
        state.lastAdjustmentTime = now
        break

      case 'unconfirm':
        userBehaviorAnalyzer.unconfirmTool(report.toolName)
        state.isConfirmed = false
        state.lastAdjustmentTime = now
        break
    }

    this.recordAdjustment(report.toolName, report.recommendedAction, reason)
  }

  /**
   * 生成可读的推荐原因描述。
   */
  private describeRecommendation(report: ToolQualityReport): string {
    const rate = (report.emaSuccessRate * 100).toFixed(0)
    const samples = report.sampleCount

    switch (report.recommendedAction) {
      case 'suppress':
        return `成功率 ${rate}%（${samples} 样本），低于抑制阈值 ${(this.config.suppressThreshold * 100).toFixed(0)}%`
      case 'unsuppress':
        return `成功率已恢复至 ${rate}%（${samples} 样本），高于取消抑制阈值 ${(this.config.unsuppressThreshold * 100).toFixed(0)}%`
      case 'confirm':
        return `成功率稳定在 ${rate}%（${samples} 样本），高于确认阈值 ${(this.config.autoConfirmThreshold * 100).toFixed(0)}%`
      case 'unconfirm':
        return `成功率降至 ${rate}%（${samples} 样本），低于取消确认阈值 ${(this.config.unconfirmThreshold * 100).toFixed(0)}%`
      default:
        return '无需调整'
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  错误模式跟踪
  // ══════════════════════════════════════════════════════════════

  private recordErrorPattern(state: EMAQualityState, error: string): void {
    if (!error) return
    for (const { pattern, label } of ERROR_PATTERNS) {
      if (pattern.test(error)) {
        // 保持最近 3 个错误模式
        state.recentErrorPatterns.push(label)
        if (state.recentErrorPatterns.length > 3) {
          state.recentErrorPatterns = state.recentErrorPatterns.slice(-3)
        }
        break
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  调整记录
  // ══════════════════════════════════════════════════════════════

  private recordAdjustment(tool: string, action: string, reason: string): void {
    this.recentAdjustments.push({ tool, action, at: Date.now(), reason })
    if (this.recentAdjustments.length > ToolFeedbackLoop.MAX_ADJUSTMENTS) {
      this.recentAdjustments = this.recentAdjustments.slice(-ToolFeedbackLoop.MAX_ADJUSTMENTS)
    }
  }

  // ══════════════════════════════════════════════════════════════
  //  诊断接口
  // ══════════════════════════════════════════════════════════════

  /**
   * 获取当前反馈回路诊断信息供人工监控。
   * manual 模式下通过此接口查看建议，决定是否手动执行。
   */
  getDiagnostics(): FeedbackLoopDiagnostics {
    return {
      mode: this.config.mode,
      alpha: this.getEffectiveAlpha(),
      totalSamplesTracked: this.qualityStates.size,
      toolsTracked: Array.from(this.qualityStates.keys()),
      suppressedTools: userBehaviorAnalyzer.getSuppressedTools(),
      confirmedTools: userBehaviorAnalyzer.getConfirmedTools(),
      recentAdjustments: [...this.recentAdjustments].reverse(),
      reports: this.generateReports(),
    }
  }

  /**
   * 手动执行一项调整建议（manual 模式用）。
   * 返回是否执行成功。
   */
  applyManualAdjustment(toolName: string, action: ToolQualityReport['recommendedAction']): boolean {
    if (action === 'none') return false

    const report = this.generateReports().find((r) => r.toolName === toolName)
    if (!report) return false

    const virtualReport: ToolQualityReport = {
      ...report,
      recommendedAction: action,
    }

    this.applyAdjustment(virtualReport)
    log('INFO', 'tool_feedback_manual_adjustment', { tool: toolName, action })
    return true
  }

  /**
   * 重置某个工具的质量跟踪状态。
   */
  resetToolState(toolName: string): void {
    this.qualityStates.delete(toolName)
    log('INFO', 'tool_feedback_reset_tool', { tool: toolName })
  }

  /**
   * 重置所有工具的跟踪状态。
   */
  resetAll(): void {
    this.qualityStates.clear()
    this.recentAdjustments = []
    this.lastEvaluationTime = 0
    log('INFO', 'tool_feedback_reset_all')
  }

  /**
   * 获取当前配置的只读副本。
   */
  getConfig(): Readonly<ToolFeedbackLoopConfig> {
    return { ...this.config }
  }
}

// ══════════════════════════════════════════════════════════════
//  全局单例
// ══════════════════════════════════════════════════════════════

/** 全局单例，供 AppRuntime / ChatExecutor 初始化时启动 */
export const toolFeedbackLoop = new ToolFeedbackLoop({
  mode: 'manual', // 初始为人工监控模式
})
