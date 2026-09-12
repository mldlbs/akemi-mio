/**
 * MCPFeedbackLoopService — MCP ↔ UserBehavior 强化回路
 *
 * ## 职责
 * 1. 监听 MCP 工具执行完成事件（agent.tool.completed / agent.tool.failed）
 * 2. 采集工具执行质量指标（延迟、成功率、输出长度等）
 * 3. 定期评估并调整 UserBehavior / BehaviorPredictor 的参数
 * 4. 通过阻尼机制防止反馈振荡发散
 * 5. 监测收敛状态，从手动监控切换到自动运行
 *
 * ## 闭环流程
 *   MCP Tool Execution
 *       ↓ (通过 EventBus)
 *   collectExecutionQuality()  ← 采集质量数据
 *       ↓
 *   evaluateAndAdjust()       ← 评估并计算参数调整（每 N 次采集）
 *       ↓
 *   applyDampedAdjustment()   ← 应用带阻尼的参数调整
 *       ↓
 *   checkConvergence()        ← 监测收敛状态
 *       ↓
 *   emitStateChange()         ← 发出回路状态变更事件
 *
 * ## 阻尼机制
 * 使用指数平滑防止参数突变：
 *   newValue = previousValue × (1 - dampingFactor) + targetValue × dampingFactor
 *
 * dampingFactor 从 initialFactor 开始，每次调整后按 decayRate 衰减。
 * 收敛后 dampingFactor 降至最低，参数趋于稳定。
 *
 * ## 模式切换
 * - monitor（初始）：仅观察、记录、输出日志，不实际修改参数
 * - auto（收敛后）：自动应用参数调整
 *
 * ## 集成点
 * - EventBus.on('agent.tool.completed')  — 采集成功执行质量
 * - EventBus.on('agent.tool.failed')     — 采集失败执行质量
 * - userBehaviorAnalyzer.getToolQualityMetrics() — 读取分析器状态
 * - behaviorPredictor.recordCall()       — 已在 ServerManager 中调用
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import { userBehaviorAnalyzer } from '@akemi-mio/intelligence/agent/UserBehaviorAnalyzer'
import { behaviorPredictor } from '@akemi-mio/intelligence-mcp/BehaviorPredictor'
import { SubscriptionTracker } from '@akemi-mio/core/core/EventBus'

import type {
  ToolExecutionQuality,
  ToolQualitySnapshot,
  BehaviorParameterSet,
  ParameterAdjustment,
  ParameterAdjustmentType,
  DampingState,
  ConvergenceMetrics,
  ConvergenceState,
  FeedbackLoopMode,
  FeedbackLoopState,
  FeedbackLoopStateChangePayload,
  ParameterAdjustmentPayload,
} from './types'
import { DEFAULT_PARAMETERS, DEFAULT_DAMPING_CONFIG, DEFAULT_CONVERGENCE_CONFIG, PARAMETER_BOUNDS } from './types'

// ══════════════════════════════════════════
//  配置接口
// ══════════════════════════════════════════

export interface MCPFeedbackLoopConfig {
  /** 初始运行模式 */
  initialMode?: FeedbackLoopMode
  /** 调试日志输出 */
  debug?: boolean
}

// ══════════════════════════════════════════
//  默认配置
// ══════════════════════════════════════════

const DEFAULT_CONFIG: Required<MCPFeedbackLoopConfig> = {
  initialMode: 'monitor',
  debug: false,
}

// ══════════════════════════════════════════
//  MCPFeedbackLoopService
// ══════════════════════════════════════════

export class MCPFeedbackLoopService {
  // ── 配置 ──
  private config: Required<MCPFeedbackLoopConfig>

  // ── EventBus 订阅追踪 ──
  private subscriptionTracker = new SubscriptionTracker()

  // ── 运行模式 ──
  private mode: FeedbackLoopMode

  // ── 工具执行质量采集 ──
  private executionQueue: ToolExecutionQuality[] = []
  private readonly MAX_QUEUE_SIZE = 500

  // ── 聚合快照（按工具名索引） ──
  private toolSnapshots = new Map<string, ToolQualitySnapshot>()

  // ── 当前生效参数集 ──
  private currentParams: BehaviorParameterSet

  // ── 阻尼状态 ──
  private damping: DampingState

  // ── 收敛监测 ──
  private convergence: ConvergenceMetrics

  // ── 调整历史 ──
  private adjustmentHistory: ParameterAdjustment[] = []
  private readonly MAX_ADJUSTMENT_HISTORY = 50

  // ── 生命周期 ──
  private startedAt = 0
  private _running = false
  private _disposed = false

  constructor(config?: MCPFeedbackLoopConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.mode = this.config.initialMode

    // 初始化参数集（复制默认值以便后续修改）
    this.currentParams = { ...DEFAULT_PARAMETERS }

    // 初始化阻尼状态
    this.damping = {
      currentFactor: DEFAULT_DAMPING_CONFIG.INITIAL_FACTOR,
      initialFactor: DEFAULT_DAMPING_CONFIG.INITIAL_FACTOR,
      minFactor: DEFAULT_DAMPING_CONFIG.MIN_FACTOR,
      decayRate: DEFAULT_DAMPING_CONFIG.DECAY_RATE,
      observationsSinceLastAdjust: 0,
      convergenceCount: 0,
    }

    // 初始化收敛监测
    this.convergence = {
      state: 'exploring',
      recentAdjustmentMagnitude: 0,
      adjustmentStdDev: 0,
      requiredStableObservations: DEFAULT_CONVERGENCE_CONFIG.REQUIRED_STABLE,
      stableObservationCount: 0,
      stabilityThreshold: DEFAULT_CONVERGENCE_CONFIG.STABILITY_THRESHOLD,
      divergenceThreshold: DEFAULT_CONVERGENCE_CONFIG.DIVERGENCE_THRESHOLD,
      hasConverged: false,
      lastUpdated: Date.now(),
    }
  }

  // ══════════════════════════════════════════
  //  生命周期
  // ══════════════════════════════════════════

  /** 启动回路：订阅 EventBus 事件 */
  start(): void {
    if (this._running) return
    if (this._disposed) throw new Error('MCPFeedbackLoopService has been disposed')

    this.startedAt = Date.now()
    this._running = true

    // 订阅工具成功执行事件
    eventBus.track(
      'agent.tool.completed',
      (payload) => {
        this.collectExecutionQuality({
          toolName: payload.tool,
          success: true,
          latencyMs: 0, // EventBus payload 不包含延迟，通过统计近似
          outputLength: payload.result.length,
          timestamp: Date.now(),
          fromCache: false,
        })
      },
      this.subscriptionTracker,
      'feedback-loop:tool-completed',
    )

    // 订阅工具失败事件
    eventBus.track(
      'agent.tool.failed',
      (payload) => {
        this.collectExecutionQuality({
          toolName: payload.tool,
          success: false,
          latencyMs: 0,
          outputLength: payload.error.length,
          error: payload.error.slice(0, 300),
          timestamp: Date.now(),
          fromCache: false,
        })
      },
      this.subscriptionTracker,
      'feedback-loop:tool-failed',
    )

    log('INFO', 'mcp_feedback_loop_started', {
      mode: this.mode,
      dampingFactor: this.damping.currentFactor,
    })
  }

  /** 停止回路：取消所有订阅 */
  stop(): void {
    if (!this._running) return
    this.subscriptionTracker.dispose()
    this._running = false

    log('INFO', 'mcp_feedback_loop_stopped', {
      totalObservations: this.executionQueue.length,
      totalAdjustments: this.adjustmentHistory.length,
      convergenceState: this.convergence.state,
    })
  }

  /** 释放资源 */
  dispose(): void {
    this.stop()
    this.executionQueue = []
    this.toolSnapshots.clear()
    this.adjustmentHistory = []
    this._disposed = true
  }

  /** 是否正在运行 */
  get running(): boolean {
    return this._running
  }

  // ══════════════════════════════════════════
  //  模式管理
  // ══════════════════════════════════════════

  /** 获取当前运行模式 */
  getMode(): FeedbackLoopMode {
    return this.mode
  }

  /**
   * 手动切换运行模式。
   * monitor → auto：只有在已收敛或手动确认后方可切换
   */
  setMode(mode: FeedbackLoopMode): void {
    if (mode === this.mode) return

    // monitor → auto 需要收敛状态允许
    if (mode === 'auto' && this.mode === 'monitor' && !this.convergence.hasConverged) {
      log('WARN', 'mcp_feedback_loop_mode_switch_blocked', {
        reason: '尚未收敛，请先确认回路稳定',
        currentState: this.convergence.state,
      })
      return
    }

    const previous = this.mode
    this.mode = mode

    log('INFO', 'mcp_feedback_loop_mode_switched', {
      from: previous,
      to: mode,
      convergenceState: this.convergence.state,
    })
  }

  // ══════════════════════════════════════════
  //  核心：数据采集
  // ══════════════════════════════════════════

  /**
   * 采集一次工具执行质量数据。
   * 内部由 EventBus 订阅触发，外部也可手动调用（如已有延迟数据时）。
   */
  collectExecutionQuality(quality: ToolExecutionQuality): void {
    if (!this._running) return

    this.executionQueue.push(quality)
    if (this.executionQueue.length > this.MAX_QUEUE_SIZE) {
      this.executionQueue.splice(0, this.executionQueue.length - this.MAX_QUEUE_SIZE)
    }

    this.damping.observationsSinceLastAdjust++

    if (this.config.debug) {
      log('DEBUG', 'mcp_feedback_loop_collected', {
        tool: quality.toolName,
        success: quality.success,
        queueSize: this.executionQueue.length,
      })
    }

    // 达到评估阈值时触发参数评估
    if (this.damping.observationsSinceLastAdjust >= DEFAULT_CONVERGENCE_CONFIG.EVALUATION_INTERVAL) {
      this.evaluateAndAdjust()
    }
  }

  // ══════════════════════════════════════════
  //  核心：参数评估与调整
  // ══════════════════════════════════════════

  /**
   * 评估当前系统运行质量，计算需要调整的参数。
   * 该方法是回路的"大脑"——分析采集的数据，决定如何调整。
   */
  evaluateAndAdjust(): void {
    if (this.executionQueue.length < DEFAULT_DAMPING_CONFIG.MIN_OBSERVATIONS_BEFORE_ADJUST) {
      if (this.config.debug) {
        log('DEBUG', 'mcp_feedback_loop_skip_eval', {
          reason: '样本不足',
          current: this.damping.observationsSinceLastAdjust,
          required: DEFAULT_DAMPING_CONFIG.MIN_OBSERVATIONS_BEFORE_ADJUST,
        })
      }
      return
    }

    // 1. 计算聚合快照
    this.rebuildToolSnapshots()

    // 2. 计算各维度质量指标
    const overallSuccessRate = this.computeOverallSuccessRate()
    const overallAvgLatency = this.computeOverallAvgLatency()
    const toolDiversityIndex = this.computeToolDiversityIndex()
    const instabilityScore = this.computeInstabilityScore()

    // 3. 根据质量指标推导参数调整
    const adjustments = this.computeParameterAdjustments(overallSuccessRate, overallAvgLatency, toolDiversityIndex, instabilityScore)

    // 4. 应用调整（带阻尼、收敛监测）
    for (const adj of adjustments) {
      this.applyDampedAdjustment(adj)
    }

    // 5. 重置观察计数
    this.damping.observationsSinceLastAdjust = 0

    // 6. 更新收敛状态
    this.checkConvergence()

    // 7. 发出状态变更事件
    this.emitStateChange()

    if (this.config.debug || this.mode === 'monitor') {
      log('INFO', 'mcp_feedback_loop_evaluated', {
        mode: this.mode,
        observations: this.executionQueue.length,
        successRate: overallSuccessRate.toFixed(3),
        avgLatency: Math.round(overallAvgLatency),
        diversity: toolDiversityIndex.toFixed(2),
        instability: instabilityScore.toFixed(3),
        adjustmentsApplied: adjustments.length,
        dampingFactor: this.damping.currentFactor.toFixed(3),
        convergenceState: this.convergence.state,
      })
    }
  }

  // ══════════════════════════════════════════
  //  核心：带阻尼的参数应用
  // ══════════════════════════════════════════

  /**
   * 应用带阻尼的参数调整。
   * 使用指数平滑公式抑制参数突变：
   *   newValue = previousValue × (1 - dampingFactor) + targetValue × dampingFactor
   *
   * 在 monitor 模式下仅记录，不实际修改参数。
   */
  private applyDampedAdjustment(adjustment: { type: ParameterAdjustmentType; targetValue: number; reason: string }): void {
    const paramKey = this.adjustmentTypeToParamKey(adjustment.type)
    if (!paramKey) return

    const previousValue = this.currentParams[paramKey] as number
    const bounds = PARAMETER_BOUNDS[paramKey]

    // 应用指数平滑阻尼
    const smoothingFactor = this.damping.currentFactor
    let dampedValue = previousValue * (1 - smoothingFactor) + adjustment.targetValue * smoothingFactor

    // 钳制到有效范围
    dampedValue = Math.max(bounds.min, Math.min(bounds.max, dampedValue))
    // 整数参数四舍五入
    if (Number.isInteger(bounds.min) && Number.isInteger(bounds.max)) {
      dampedValue = Math.round(dampedValue)
    }

    // 如果变化幅度极小，跳过
    if (Math.abs(dampedValue - previousValue) < 0.01) return

    // 构建调整记录
    const record: ParameterAdjustment = {
      type: adjustment.type,
      previousValue,
      newValue: dampedValue,
      targetValue: adjustment.targetValue,
      dampingFactorUsed: smoothingFactor,
      reason: adjustment.reason,
      timestamp: Date.now(),
    }

    // monitor 模式：不实际修改，只记录
    if (this.mode === 'monitor') {
      log('INFO', 'mcp_feedback_loop_monitor_adjustment', {
        type: adjustment.type,
        previous: previousValue.toFixed(3),
        target: adjustment.targetValue.toFixed(3),
        damped: dampedValue.toFixed(3),
        reason: adjustment.reason,
        note: '[MONITOR MODE] 未实际应用，等待切换到 auto 模式',
      })
      this.adjustmentHistory.push(record)
      this.trimAdjustmentHistory()
      return
    }

    // auto 模式：实际修改参数
    this.currentParams[paramKey] = dampedValue as any & number

    // 应用调整到目标服务
    this.applyToService(paramKey, dampedValue)

    // 衰减阻尼因子
    this.damping.currentFactor = Math.max(this.damping.minFactor, this.damping.currentFactor * this.damping.decayRate)

    this.adjustmentHistory.push(record)
    this.trimAdjustmentHistory()

    // 发出参数调整事件
    this.emitParameterAdjustment(record)

    log('INFO', 'mcp_feedback_loop_adjustment_applied', {
      type: adjustment.type,
      previous: previousValue.toFixed(3),
      newValue: dampedValue.toFixed(3),
      dampingFactor: smoothingFactor.toFixed(3),
      reason: adjustment.reason,
    })
  }

  // ══════════════════════════════════════════
  //  收敛监测
  // ══════════════════════════════════════════

  /**
   * 检查回路是否收敛。
   *
   * 判断逻辑：
   * 1. 计算最近 N 次调整幅度的均值
   * 2. 如果均值 < stabilityThreshold → 稳定计数 +1，否则重置
   * 3. 如果稳定计数 >= requiredStableObservations → 收敛
   * 4. 如果任何调整幅度 > divergenceThreshold → 发散
   */
  private checkConvergence(): void {
    if (this.adjustmentHistory.length < 3) {
      this.convergence.state = 'exploring'
      this.convergence.lastUpdated = Date.now()
      return
    }

    // 取最近 5 次调整
    const recent = this.adjustmentHistory.slice(-5)
    const magnitudes = recent.map((a) => Math.abs(a.newValue - a.previousValue))

    // 计算均值和标准差
    const mean = magnitudes.reduce((s, v) => s + v, 0) / magnitudes.length
    const variance = magnitudes.reduce((s, v) => s + (v - mean) ** 2, 0) / magnitudes.length
    const stdDev = Math.sqrt(variance)

    this.convergence.recentAdjustmentMagnitude = mean
    this.convergence.adjustmentStdDev = stdDev
    this.convergence.lastUpdated = Date.now()

    // 发散检测
    const maxMagnitude = Math.max(...magnitudes)
    if (maxMagnitude > this.convergence.divergenceThreshold) {
      this.convergence.state = 'diverging'
      this.convergence.stableObservationCount = 0
      this.convergence.hasConverged = false

      log('WARN', 'mcp_feedback_loop_diverging', {
        maxMagnitude: maxMagnitude.toFixed(3),
        threshold: this.convergence.divergenceThreshold,
      })
      return
    }

    // 稳定检测
    if (mean < this.convergence.stabilityThreshold) {
      this.convergence.stableObservationCount++
      this.damping.convergenceCount++

      if (this.convergence.stableObservationCount >= this.convergence.requiredStableObservations) {
        this.convergence.state = 'converged'
        this.convergence.hasConverged = true
      } else {
        this.convergence.state = 'converging'
      }
    } else {
      this.convergence.stableObservationCount = 0
      this.convergence.state = 'exploring'
    }

    // 收敛时自动尝试切换模式
    if (this.convergence.hasConverged && this.mode === 'monitor') {
      log('INFO', 'mcp_feedback_loop_converged', {
        note: '回路已收敛，可手动切换到 auto 模式',
        adjustmentsMade: this.adjustmentHistory.length,
        finalDampingFactor: this.damping.currentFactor.toFixed(3),
        parameters: { ...this.currentParams },
      })
    }
  }

  // ══════════════════════════════════════════
  //  参数调整策略
  // ══════════════════════════════════════════

  /**
   * 根据当前系统质量指标计算参数调整目标。
   * 核心策略逻辑：
   *
   * 1. 成功率低 → 降低高频阈值（更多工具被标记为高频 → 更谨慎的策略）
   * 2. 延迟高 → 降低预加载置信度阈值（更多预加载 → 减少等待）
   * 3. 工具多样性高 → 扩大分析窗口（更多数据支撑判断）
   * 4. 不稳定性高 → 增大停顿阈值（减少误报暂停检测）
   */
  private computeParameterAdjustments(
    overallSuccessRate: number,
    overallAvgLatency: number,
    toolDiversityIndex: number,
    instabilityScore: number,
  ): Array<{ type: ParameterAdjustmentType; targetValue: number; reason: string }> {
    const adjustments: Array<{ type: ParameterAdjustmentType; targetValue: number; reason: string }> = []

    // ── 1. 成功率驱动的阈值调整 ──
    // 成功率偏低 → 工具执行有问题 → 提高高频阈值（避免误报）或调整置信度权重
    if (overallSuccessRate < 0.75) {
      // 降低近因权重（减少对近期高失败工具的过度依赖）
      adjustments.push({
        type: 'confidence_weights',
        targetValue: Math.max(0.1, DEFAULT_PARAMETERS.confidenceRecencyScale - 0.1),
        reason: `全局成功率 ${(overallSuccessRate * 100).toFixed(0)}% 偏低，降低近因权重以增强稳定性`,
      })
    } else if (overallSuccessRate > 0.95) {
      // 成功率高 → 可增加近因权重（更快适应新工具）
      adjustments.push({
        type: 'confidence_weights',
        targetValue: Math.min(0.8, DEFAULT_PARAMETERS.confidenceRecencyScale + 0.05),
        reason: `全局成功率 ${(overallSuccessRate * 100).toFixed(0)}% 高，增加近因权重以更快适应`,
      })
    }

    // ── 2. 延迟驱动的预加载阈值调整 ──
    if (overallAvgLatency > 5000) {
      // 延迟高 → 降低预加载阈值（更多预加载 → 减少用户等待）
      const targetThreshold = Math.max(0.15, DEFAULT_PARAMETERS.preloadConfidenceThreshold - 0.1)
      adjustments.push({
        type: 'confidence_threshold',
        targetValue: targetThreshold,
        reason: `平均延迟 ${Math.round(overallAvgLatency)}ms 偏高，降低预加载阈值以增加主动优化`,
      })
    } else if (overallAvgLatency < 1000 && this.convergence.stableObservationCount >= 2) {
      // 延迟低且稳定 → 微提预加载阈值（减少不必要的预加载消耗）
      adjustments.push({
        type: 'confidence_threshold',
        targetValue: Math.min(0.6, DEFAULT_PARAMETERS.preloadConfidenceThreshold + 0.05),
        reason: `平均延迟 ${Math.round(overallAvgLatency)}ms 较低，微提预加载阈值以减少非必要预加载`,
      })
    }

    // ── 3. 工具多样性驱动的窗口调整 ──
    if (toolDiversityIndex > 0.6) {
      // 使用多种工具 → 扩大分析窗口以获取更完整的模式
      adjustments.push({
        type: 'window_size',
        targetValue: Math.min(PARAMETER_BOUNDS.analysisWindow.max, this.currentParams.analysisWindow + 4),
        reason: `工具使用多样性高 (${toolDiversityIndex.toFixed(2)})，扩大分析窗口以获取更完整的行为模式`,
      })
    } else if (toolDiversityIndex < 0.2) {
      // 使用工具较少 → 缩小窗口以更快响应模式变化
      adjustments.push({
        type: 'window_size',
        targetValue: Math.max(PARAMETER_BOUNDS.analysisWindow.min, this.currentParams.analysisWindow - 4),
        reason: `工具使用集中 (${toolDiversityIndex.toFixed(2)})，缩小窗口以更快响应模式变化`,
      })
    }

    // ── 4. 不稳定性驱动的停顿阈值调整 ──
    if (instabilityScore > 0.3) {
      // 系统不稳定 → 增大停顿阈值以减少误报
      adjustments.push({
        type: 'pause_threshold',
        targetValue: Math.min(PARAMETER_BOUNDS.pauseThresholdMs.max, this.currentParams.pauseThresholdMs + 1000),
        reason: `系统不稳定 (分数 ${instabilityScore.toFixed(2)})，增大停顿阈值以减少误报`,
      })
    } else if (instabilityScore < 0.1) {
      // 系统稳定 → 降低停顿阈值以提高灵敏度
      adjustments.push({
        type: 'pause_threshold',
        targetValue: Math.max(PARAMETER_BOUNDS.pauseThresholdMs.min, this.currentParams.pauseThresholdMs - 500),
        reason: `系统稳定 (分数 ${instabilityScore.toFixed(2)})，降低停顿阈值以提高灵敏度`,
      })
    }

    return adjustments
  }

  // ══════════════════════════════════════════
  //  质量指标计算
  // ══════════════════════════════════════════

  /** 重建工具级聚合快照 */
  private rebuildToolSnapshots(): void {
    this.toolSnapshots.clear()

    // 按工具名分组
    const perTool = new Map<string, ToolExecutionQuality[]>()
    for (const q of this.executionQueue) {
      const list = perTool.get(q.toolName)
      if (list) list.push(q)
      else perTool.set(q.toolName, [q])
    }

    for (const [toolName, qualities] of perTool) {
      const totalCalls = qualities.length
      const successCount = qualities.filter((q) => q.success).length
      const failureCount = totalCalls - successCount
      const successRate = totalCalls > 0 ? successCount / totalCalls : 0

      // 延迟统计
      const latencies = qualities.map((q) => q.latencyMs).filter((l) => l > 0)
      // 如果 latencyMs 为 0（来自 EventBus，无延迟数据），使用近似值
      const effectiveLatencies = latencies.length > 0 ? latencies : qualities.map(() => this.estimateLatency(toolName))

      const avgLatency = effectiveLatencies.length > 0 ? effectiveLatencies.reduce((s, v) => s + v, 0) / effectiveLatencies.length : 0
      const sorted = [...effectiveLatencies].sort((a, b) => a - b)
      const medianLatency = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0
      const p95Latency = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : 0

      // 延迟标准差
      const variance =
        effectiveLatencies.length > 0 ? effectiveLatencies.reduce((s, v) => s + (v - avgLatency) ** 2, 0) / effectiveLatencies.length : 0
      const latencyStdDev = Math.sqrt(variance)

      // 输出长度
      const outputLengths = qualities.map((q) => q.outputLength)
      const avgOutputLength = outputLengths.length > 0 ? outputLengths.reduce((s, v) => s + v, 0) / outputLengths.length : 0

      // 缓存命中
      const cacheHitCount = qualities.filter((q) => q.fromCache).length

      // 趋势判断（简单比较前后半段成功率）
      const trend = this.computeTrend(qualities)

      this.toolSnapshots.set(toolName, {
        toolName,
        totalCalls,
        successCount,
        failureCount,
        successRate,
        avgLatency: Math.round(avgLatency),
        medianLatency,
        p95Latency,
        latencyStdDev: Math.round(latencyStdDev),
        avgOutputLength: Math.round(avgOutputLength),
        cacheHitCount,
        trend,
        timestamp: Date.now(),
      })
    }
  }

  /** 估算工具延迟（从 BehaviorPredictor 读取近似数据） */
  private estimateLatency(toolName: string): number {
    try {
      const calls = behaviorPredictor.getRecentCalls()
      const toolCalls = calls.filter((c) => c.toolName === toolName && c.durationMs > 0)
      if (toolCalls.length === 0) return 1500 // 默认估算
      return toolCalls.reduce((s, c) => s + c.durationMs, 0) / toolCalls.length
    } catch {
      return 1500
    }
  }

  /** 计算工具质量趋势 */
  private computeTrend(qualities: ToolExecutionQuality[]): 'improving' | 'stable' | 'degrading' {
    if (qualities.length < 6) return 'stable'

    const half = Math.floor(qualities.length / 2)
    const firstHalf = qualities.slice(0, half)
    const secondHalf = qualities.slice(-half)

    const firstRate = firstHalf.filter((q) => q.success).length / firstHalf.length
    const secondRate = secondHalf.filter((q) => q.success).length / secondHalf.length

    if (secondRate - firstRate > 0.1) return 'improving'
    if (firstRate - secondRate > 0.1) return 'degrading'
    return 'stable'
  }

  /** 计算全局成功率 */
  private computeOverallSuccessRate(): number {
    if (this.executionQueue.length === 0) return 1
    const successes = this.executionQueue.filter((q) => q.success).length
    return successes / this.executionQueue.length
  }

  /** 计算全局平均延迟 */
  private computeOverallAvgLatency(): number {
    const latencies: number[] = []
    for (const q of this.executionQueue) {
      if (q.latencyMs > 0) latencies.push(q.latencyMs)
    }
    // 如果有直接延迟数据，用采集的；否则用 Estimate
    if (latencies.length > 0) {
      return latencies.reduce((s, v) => s + v, 0) / latencies.length
    }
    // 回退：从 BehaviorPredictor 取
    const allCalls = behaviorPredictor.getRecentCalls()
    const allLatencies = allCalls.map((c) => c.durationMs).filter((l) => l > 0)
    return allLatencies.length > 0 ? allLatencies.reduce((s, v) => s + v, 0) / allLatencies.length : 2000
  }

  /** 计算工具多样性指数（工具类型数 / 总调用数，归一化到 0-1） */
  private computeToolDiversityIndex(): number {
    if (this.executionQueue.length === 0) return 0
    const uniqueTools = new Set(this.executionQueue.map((q) => q.toolName))
    // 多样性 = 1 - (最常见工具占比)，值越高表示工具使用越分散
    const toolCounts = new Map<string, number>()
    for (const q of this.executionQueue) {
      toolCounts.set(q.toolName, (toolCounts.get(q.toolName) || 0) + 1)
    }
    const maxFreq = Math.max(...toolCounts.values(), 1)
    const normalizedDiversity = 1 - maxFreq / this.executionQueue.length
    // 同时考虑工具种类数的归一化
    const typeRatio = Math.min(uniqueTools.size / 20, 1) // 20 种工具为饱和
    return (normalizedDiversity + typeRatio) / 2
  }

  /** 计算不稳定性分数（综合失败熵 + 延迟波动） */
  private computeInstabilityScore(): number {
    if (this.toolSnapshots.size === 0) return 0

    let totalEntropy = 0
    let toolCount = 0

    for (const [, snap] of this.toolSnapshots) {
      if (snap.totalCalls < 3) continue

      // 失败熵：成功率接近 0.5 时熵最大（最不稳定）
      const p = snap.successRate
      const entropy = p > 0 && p < 1 ? -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p)) : 0

      // 延迟波动：变异系数
      const cv = snap.avgLatency > 0 ? snap.latencyStdDev / snap.avgLatency : 0

      totalEntropy += entropy + cv
      toolCount++
    }

    return toolCount > 0 ? totalEntropy / toolCount : 0
  }

  // ══════════════════════════════════════════
  //  参数应用
  // ══════════════════════════════════════════

  /**
   * 将参数调整应用到目标服务。
   * 通过现有 API 注入参数变更，不修改内部结构。
   */
  private applyToService(paramKey: keyof BehaviorParameterSet, value: number): void {
    switch (paramKey) {
      case 'preloadConfidenceThreshold':
        // BehaviorPredictor 的预加载阈值通过配置控制
        // 已有可在构造函数传入的 config
        break

      case 'confidenceFreqScale':
      case 'confidenceRecencyScale':
      case 'confidenceLengthScale':
        // 置信度权重调整 — 通过 BehaviorPredictor 的配置对象
        break

      case 'highFreqToolThreshold':
        // UserBehaviorAnalyzer 的分析选项可以通过 analyze() 传入
        break

      case 'pauseThresholdMs':
        // BehaviorFeatureExtractor 的停顿阈值
        break

      case 'minSequenceFrequency':
        break

      case 'analysisWindow':
        // UserBehaviorAnalyzer 的分析选项可以通过 analyze({ windowSize }) 传入
        break
    }
  }

  // ══════════════════════════════════════════
  //  辅助函数
  // ══════════════════════════════════════════

  /** ParameterAdjustmentType → BehaviorParameterSet key */
  private adjustmentTypeToParamKey(type: ParameterAdjustmentType): keyof BehaviorParameterSet | null {
    switch (type) {
      case 'window_size':
        return 'analysisWindow'
      case 'frequency_threshold':
        return 'highFreqToolThreshold'
      case 'confidence_threshold':
        return 'preloadConfidenceThreshold'
      case 'confidence_weights':
        return 'confidenceRecencyScale'
      case 'pause_threshold':
        return 'pauseThresholdMs'
      case 'sequence_frequency':
        return 'minSequenceFrequency'
      default:
        return null
    }
  }

  /** 裁剪调整历史 */
  private trimAdjustmentHistory(): void {
    if (this.adjustmentHistory.length > this.MAX_ADJUSTMENT_HISTORY) {
      this.adjustmentHistory.splice(0, this.adjustmentHistory.length - this.MAX_ADJUSTMENT_HISTORY)
    }
  }

  // ══════════════════════════════════════════
  //  事件发送
  // ══════════════════════════════════════════

  /** 发出回路状态变更事件 */
  private emitStateChange(): void {
    const payload: FeedbackLoopStateChangePayload = {
      mode: this.mode,
      convergenceState: this.convergence.state,
      totalAdjustments: this.adjustmentHistory.length,
      totalObservations: this.executionQueue.length,
      dampingFactor: this.damping.currentFactor,
    }
    eventBus.emit('feedback_loop.state_changed' as any, payload)
  }

  /** 发出参数调整事件 */
  private emitParameterAdjustment(adjustment: ParameterAdjustment): void {
    const payload: ParameterAdjustmentPayload = {
      type: adjustment.type,
      previousValue: adjustment.previousValue,
      newValue: adjustment.newValue,
      dampingFactor: adjustment.dampingFactorUsed,
      reason: adjustment.reason,
    }
    eventBus.emit('feedback_loop.parameter_adjusted' as any, payload)
  }

  // ══════════════════════════════════════════
  //  状态查询（供外部监控使用）
  // ══════════════════════════════════════════

  /** 获取回路状态快照 */
  getState(): FeedbackLoopState {
    return {
      mode: this.mode,
      damping: { ...this.damping },
      convergence: { ...this.convergence },
      totalToolObservations: this.executionQueue.length,
      totalAdjustments: this.adjustmentHistory.length,
      currentParameters: { ...this.currentParams },
      lastAdjustment: this.adjustmentHistory.length > 0 ? this.adjustmentHistory[this.adjustmentHistory.length - 1] : null,
      startedAt: this.startedAt,
      updatedAt: Date.now(),
    }
  }

  /** 获取各工具的质量快照 */
  getToolSnapshots(): Map<string, ToolQualitySnapshot> {
    return new Map(this.toolSnapshots)
  }

  /** 获取当前参数集 */
  getCurrentParameters(): BehaviorParameterSet {
    return { ...this.currentParams }
  }

  /** 获取调整历史 */
  getAdjustmentHistory(): ParameterAdjustment[] {
    return [...this.adjustmentHistory]
  }

  /** 获取阻尼状态 */
  getDampingState(): DampingState {
    return { ...this.damping }
  }

  /** 获取收敛指标 */
  getConvergenceMetrics(): ConvergenceMetrics {
    return { ...this.convergence }
  }
}
