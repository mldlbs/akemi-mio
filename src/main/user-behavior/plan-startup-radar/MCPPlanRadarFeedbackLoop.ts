/**
 * MCPPlanRadarFeedbackLoop — MCP ↔ Plan:创业雷达 Telegram Bot 开发 强化回路
 *
 * ## 闭环流程
 *
 *   MCP Tool Execution（radar_scan / radar_analyze / 其他工具）
 *       ↓ (通过 EventBus)
 *   collectExecutionQuality()  ← 采集工具执行质量
 *       ↓
 *   updateRadarObservation()   ← 关联到雷达信号采集
 *       ↓
 *   evaluateAndAdjust()        ← 评估并计算参数调整（每 N 次采集）
 *       ↓
 *   applyDampedAdjustment()    ← 应用带阻尼的参数调整
 *       ↓
 *   checkConvergence()         ← 监测收敛状态
 *       ↓
 *   emitStateChange()          ← 发出回路状态变更事件
 *       ↓
 *   调整后的参数影响下一次 MCP 工具执行
 *
 * ## 阻尼机制
 *
 * 使用指数平滑防止参数突变振荡发散：
 *   newValue = previousValue × (1 - dampingFactor) + targetValue × dampingFactor
 *
 * dampingFactor 从 initialFactor 开始，每次调整后按 decayRate 衰减。
 * 收敛后 dampingFactor 降至最低，参数趋于稳定。
 *
 * ## 模式切换
 *
 * - monitor（初始）：仅观察、记录、输出日志，不实际修改参数
 * - auto（收敛后）：自动应用参数调整到 StartupRadarAdapter
 *
 * ## 集成点
 *
 * - EventBus.on('agent.tool.completed')  — 采集成功执行质量
 * - EventBus.on('agent.tool.failed')     — 采集失败执行质量
 * - startupRadarAdapter.getLastSnapshot() — 读取当前雷达快照
 * - startupRadarAdapter.scan()            — 可传递调整后的参数
 */
import { log } from '../../logger/Logger'
import { eventBus } from '../../core/EventBus'
import { SubscriptionTracker } from '../../core/EventBus'
import { startupRadarAdapter } from '../../startup-radar/PlanStartupRadarAdapter'
import type { RadarScanResult } from '../../startup-radar/types'

import type {
  RadarFeedbackLoopMode,
  RadarConvergenceState,
  RadarParameterSet,
  RadarAdjustmentType,
  RadarParameterAdjustment,
  RadarDampingState,
  RadarConvergenceMetrics,
  RadarFeedbackLoopState,
  RadarLoopStateChangePayload,
  RadarParameterAdjustmentPayload,
} from './types'
import {
  RADAR_DEFAULT_PARAMETERS,
  RADAR_DEFAULT_DAMPING_CONFIG,
  RADAR_DEFAULT_CONVERGENCE_CONFIG,
  RADAR_PARAMETER_BOUNDS,
} from './types'

// ════════════════════════════════════════════════════════════════
//  配置接口
// ════════════════════════════════════════════════════════════════

export interface MCPPlanRadarLoopConfig {
  /** 初始运行模式 */
  initialMode?: RadarFeedbackLoopMode
  /** 调试日志输出 */
  debug?: boolean
}

// ════════════════════════════════════════════════════════════════
//  默认配置
// ════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: Required<MCPPlanRadarLoopConfig> = {
  initialMode: 'monitor',
  debug: false,
}

// ════════════════════════════════════════════════════════════════
//  内部类型
// ════════════════════════════════════════════════════════════════

/** 单次工具执行的质量评价 */
interface ToolExecQuality {
  toolName: string
  success: boolean
  latencyMs: number
  outputLength: number
  error?: string
  timestamp: number
  /** 是否为雷达相关工具 */
  isRadarTool: boolean
  /** 如果是雷达工具，关联的信号数（从结果解析） */
  signalCount?: number
}

/** 工具在窗口内的聚合指标 */
interface ToolSnapshot {
  totalCalls: number
  successCount: number
  successRate: number
  avgLatency: number
  /** 是否与雷达相关 */
  isRadarTool: boolean
  /** 关联信号数均值 */
  avgSignalCount: number
}

// ════════════════════════════════════════════════════════════════
//  MCPPlanRadarFeedbackLoop
// ════════════════════════════════════════════════════════════════

export class MCPPlanRadarFeedbackLoop {
  // ── 配置 ──
  private config: Required<MCPPlanRadarLoopConfig>

  // ── EventBus 订阅追踪 ──
  private subscriptionTracker = new SubscriptionTracker()

  // ── 运行模式 ──
  private mode: RadarFeedbackLoopMode

  // ── 工具执行质量采集 ──
  private executionQueue: ToolExecQuality[] = []
  private readonly MAX_QUEUE_SIZE = 500

  // ── 工具聚合快照 ──
  private toolSnapshots = new Map<string, ToolSnapshot>()

  // ── 雷达信号观察缓存 ──
  private radarScanResults: RadarScanResult[] = []
  private readonly MAX_RADAR_RESULTS = 50

  // ── 当前生效参数集 ──
  private currentParams: RadarParameterSet

  // ── 阻尼状态 ──
  private damping: RadarDampingState

  // ── 收敛监测 ──
  private convergence: RadarConvergenceMetrics

  // ── 调整历史 ──
  private adjustmentHistory: RadarParameterAdjustment[] = []
  private readonly MAX_ADJUSTMENT_HISTORY = 50

  // ── 生命周期 ──
  private startedAt = 0
  private _running = false
  private _disposed = false

  constructor(config?: MCPPlanRadarLoopConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.mode = this.config.initialMode

    // 初始化参数集（深拷贝默认值）
    this.currentParams = {
      ...RADAR_DEFAULT_PARAMETERS,
      sourceWeights: { ...RADAR_DEFAULT_PARAMETERS.sourceWeights },
    }

    // 初始化阻尼状态
    this.damping = {
      currentFactor: RADAR_DEFAULT_DAMPING_CONFIG.INITIAL_FACTOR,
      initialFactor: RADAR_DEFAULT_DAMPING_CONFIG.INITIAL_FACTOR,
      minFactor: RADAR_DEFAULT_DAMPING_CONFIG.MIN_FACTOR,
      decayRate: RADAR_DEFAULT_DAMPING_CONFIG.DECAY_RATE,
      observationsSinceLastAdjust: 0,
      convergenceCount: 0,
    }

    // 初始化收敛监测
    this.convergence = {
      state: 'exploring',
      recentAdjustmentMagnitude: 0,
      adjustmentStdDev: 0,
      requiredStableObservations: RADAR_DEFAULT_CONVERGENCE_CONFIG.REQUIRED_STABLE,
      stableObservationCount: 0,
      stabilityThreshold: RADAR_DEFAULT_CONVERGENCE_CONFIG.STABILITY_THRESHOLD,
      divergenceThreshold: RADAR_DEFAULT_CONVERGENCE_CONFIG.DIVERGENCE_THRESHOLD,
      hasConverged: false,
      lastUpdated: Date.now(),
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  生命周期
  // ════════════════════════════════════════════════════════════════

  /** 启动回路：订阅 EventBus 事件 */
  start(): void {
    if (this._running) return
    if (this._disposed) throw new Error('MCPPlanRadarFeedbackLoop has been disposed')

    this.startedAt = Date.now()
    this._running = true

    // 订阅工具成功执行事件
    eventBus.track(
      'agent.tool.completed',
      (payload: any) => {
        this.collectExecutionQuality({
          toolName: payload.tool,
          success: true,
          latencyMs: payload.latencyMs ?? 0,
          outputLength: (payload.result ?? '').length,
          timestamp: Date.now(),
          isRadarTool: this.isRadarToolName(payload.tool),
          signalCount: this.extractSignalCount(payload.tool, payload.result),
        })
      },
      this.subscriptionTracker,
      'mcp-plan-radar-loop:tool-completed',
    )

    // 订阅工具失败事件
    eventBus.track(
      'agent.tool.failed',
      (payload: any) => {
        this.collectExecutionQuality({
          toolName: payload.tool,
          success: false,
          latencyMs: 0,
          outputLength: (payload.error ?? '').length,
          error: (payload.error ?? '').slice(0, 300),
          timestamp: Date.now(),
          isRadarTool: this.isRadarToolName(payload.tool),
        })
      },
      this.subscriptionTracker,
      'mcp-plan-radar-loop:tool-failed',
    )

    // 订阅雷达扫描完成事件（从 StartupRadarAdapter 的信号就绪通知）
    // 通过适配器的 onSignalsReady 获取
    try {
      const dispose = startupRadarAdapter.onSignalsReady((result: RadarScanResult) => {
        this.onRadarScanCompleted(result)
      })
      // onSignalsReady 返回 () => void 用于取消订阅
      // 我们用 subscriptionTracker 追踪，但 onSignalsReady 不在 EventBus 上
      // 所以直接存储清理函数
      this._radarDispose = dispose
    } catch {
      // 适配器可能尚未初始化
      log('WARN', 'mcp_plan_radar_loop_startup_radar_unavailable')
    }

    log('INFO', 'mcp_plan_radar_loop_started', {
      mode: this.mode,
      dampingFactor: this.damping.currentFactor,
    })
  }

  /** onSignalsReady 取消订阅句柄 */
  private _radarDispose: (() => void) | null = null

  /** 停止回路：取消所有订阅 */
  stop(): void {
    if (!this._running) return

    // 取消 EventBus 订阅
    this.subscriptionTracker.dispose()

    // 取消 StartupRadarAdapter 订阅
    if (this._radarDispose) {
      try {
        this._radarDispose()
      } catch {
        // 静默
      }
      this._radarDispose = null
    }

    this._running = false

    log('INFO', 'mcp_plan_radar_loop_stopped', {
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
    this.radarScanResults = []
    this.adjustmentHistory = []
    this._disposed = true
  }

  /** 是否正在运行 */
  get running(): boolean {
    return this._running
  }

  // ════════════════════════════════════════════════════════════════
  //  模式管理
  // ════════════════════════════════════════════════════════════════

  /** 获取当前运行模式 */
  getMode(): RadarFeedbackLoopMode {
    return this.mode
  }

  /**
   * 手动切换运行模式。
   * monitor → auto：只有在已收敛或手动确认后方可切换
   */
  setMode(mode: RadarFeedbackLoopMode): void {
    if (mode === this.mode) return

    // monitor → auto 需要收敛状态允许
    if (mode === 'auto' && this.mode === 'monitor' && !this.convergence.hasConverged) {
      log('WARN', 'mcp_plan_radar_loop_mode_switch_blocked', {
        reason: '尚未收敛，请先确认回路稳定',
        currentState: this.convergence.state,
      })
      return
    }

    const previous = this.mode
    this.mode = mode

    log('INFO', 'mcp_plan_radar_loop_mode_switched', {
      from: previous,
      to: mode,
      convergenceState: this.convergence.state,
    })
  }

  // ════════════════════════════════════════════════════════════════
  //  核心：数据采集
  // ════════════════════════════════════════════════════════════════

  /**
   * 采集一次工具执行质量数据。
   * 内部由 EventBus 订阅触发，外部也可手动调用。
   */
  collectExecutionQuality(quality: ToolExecQuality): void {
    if (!this._running) return

    this.executionQueue.push(quality)
    if (this.executionQueue.length > this.MAX_QUEUE_SIZE) {
      this.executionQueue.splice(0, this.executionQueue.length - this.MAX_QUEUE_SIZE)
    }

    this.damping.observationsSinceLastAdjust++

    if (this.config.debug) {
      log('DEBUG', 'mcp_plan_radar_loop_collected', {
        tool: quality.toolName,
        success: quality.success,
        isRadar: quality.isRadarTool,
        queueSize: this.executionQueue.length,
      })
    }

    // 达到评估阈值时触发参数评估
    if (this.damping.observationsSinceLastAdjust >= RADAR_DEFAULT_CONVERGENCE_CONFIG.EVALUATION_INTERVAL) {
      this.evaluateAndAdjust()
    }
  }

  /**
   * 处理雷达扫描完成事件（来自 StartupRadarAdapter.onSignalsReady）
   */
  private onRadarScanCompleted(result: RadarScanResult): void {
    if (!this._running) return
    if (!result || result.totalSignals === 0) return

    this.radarScanResults.push(result)
    if (this.radarScanResults.length > this.MAX_RADAR_RESULTS) {
      this.radarScanResults.splice(0, this.radarScanResults.length - this.MAX_RADAR_RESULTS)
    }

    if (this.config.debug) {
      log('DEBUG', 'mcp_plan_radar_loop_scan_observed', {
        signals: result.totalSignals,
        urgent: result.urgentCount,
        heatIndex: result.compositeHeatIndex.toFixed(3),
      })
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  核心：参数评估与调整
  // ════════════════════════════════════════════════════════════════

  /**
   * 评估当前系统运行质量，计算需要调整的雷达参数。
   *
   * 核心策略逻辑连接 MCP 工具执行质量 → 雷达参数调整：
   *
   * 1. 雷达工具成功率低 → 降低 minScoreThreshold（扩大采集范围）
   * 2. 雷达工具延迟高 → 增大 scanInterval（减少扫描频率，降低负载）
   * 3. 信号持续低热度 → 降低 urgencyHotThreshold（更多信号触发 hot）
   * 4. 某信号源持续高产 → 提高该 sourceWeight（聚焦高价值源）
   * 5. 工具多样性变化 → 调整 maxSignalsPerScan（适应信息量）
   * 6. 系统不稳定 → 增大 heatDecayFactor（更快遗忘旧信号）
   */
  evaluateAndAdjust(): void {
    if (this.executionQueue.length < RADAR_DEFAULT_DAMPING_CONFIG.MIN_OBSERVATIONS_BEFORE_ADJUST) {
      if (this.config.debug) {
        log('DEBUG', 'mcp_plan_radar_loop_skip_eval', {
          reason: '样本不足',
          current: this.damping.observationsSinceLastAdjust,
          required: RADAR_DEFAULT_DAMPING_CONFIG.MIN_OBSERVATIONS_BEFORE_ADJUST,
        })
      }
      return
    }

    // 1. 重建工具聚合快照
    this.rebuildToolSnapshots()

    // 2. 计算各维度质量指标
    const overallSuccessRate = this.computeOverallSuccessRate()
    const radarSuccessRate = this.computeRadarSuccessRate()
    const overallAvgLatency = this.computeOverallAvgLatency()
    const toolDiversityIndex = this.computeToolDiversityIndex()
    const instabilityScore = this.computeInstabilityScore()
    const avgHeatIndex = this.computeAvgHeatIndex()
    const sourcePerformance = this.computeSourcePerformance()

    // 3. 根据质量指标推导参数调整
    const adjustments = this.computeParameterAdjustments(
      overallSuccessRate,
      radarSuccessRate,
      overallAvgLatency,
      toolDiversityIndex,
      instabilityScore,
      avgHeatIndex,
      sourcePerformance,
    )

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
      log('INFO', 'mcp_plan_radar_loop_evaluated', {
        mode: this.mode,
        observations: this.executionQueue.length,
        successRate: overallSuccessRate.toFixed(3),
        radarSuccessRate: radarSuccessRate.toFixed(3),
        avgLatency: Math.round(overallAvgLatency),
        diversity: toolDiversityIndex.toFixed(2),
        instability: instabilityScore.toFixed(3),
        avgHeatIndex: avgHeatIndex.toFixed(3),
        adjustmentsApplied: adjustments.length,
        dampingFactor: this.damping.currentFactor.toFixed(3),
        convergenceState: this.convergence.state,
      })
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  核心：带阻尼的参数应用
  // ════════════════════════════════════════════════════════════════

  /**
   * 应用带阻尼的参数调整。
   * 使用指数平滑公式抑制参数突变振荡发散：
   *   newValue = previousValue × (1 - dampingFactor) + targetValue × dampingFactor
   *
   * 在 monitor 模式下仅记录，不实际修改参数。
   */
  private applyDampedAdjustment(adjustment: {
    type: RadarAdjustmentType
    targetValue: number
    targetSource?: string
    reason: string
  }): void {
    const paramKey = this.adjustmentTypeToParamKey(adjustment.type)
    if (!paramKey) return

    // 源权重是特殊处理：targetSource 指定哪个源
    if (paramKey === 'sourceWeights' && adjustment.targetSource) {
      this.applyDampedSourceWeight(adjustment)
      return
    }

    const previousValue = this.currentParams[paramKey] as number
    const bounds = RADAR_PARAMETER_BOUNDS[paramKey]
    if (bounds === undefined) return

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
    const record: RadarParameterAdjustment = {
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
      log('INFO', 'mcp_plan_radar_loop_monitor_adjustment', {
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
    ;(this.currentParams[paramKey] as number) = dampedValue

    // 衰减阻尼因子
    this.damping.currentFactor = Math.max(
      this.damping.minFactor,
      this.damping.currentFactor * this.damping.decayRate,
    )

    this.adjustmentHistory.push(record)
    this.trimAdjustmentHistory()

    // 发出参数调整事件
    this.emitParameterAdjustment(record)

    log('INFO', 'mcp_plan_radar_loop_adjustment_applied', {
      type: adjustment.type,
      previous: previousValue.toFixed(3),
      newValue: dampedValue.toFixed(3),
      dampingFactor: smoothingFactor.toFixed(3),
      reason: adjustment.reason,
    })
  }

  /**
   * 带阻尼的源权重调整（特殊处理，因为 sourceWeights 是嵌套对象）
   */
  private applyDampedSourceWeight(adjustment: {
    type: RadarAdjustmentType
    targetValue: number
    targetSource?: string
    reason: string
  }): void {
    const source = adjustment.targetSource
    if (!source) return

    const previousValue = this.currentParams.sourceWeights[source] ?? RADAR_DEFAULT_PARAMETERS.sourceWeights.other
    const bounds = { min: 0, max: 1 } // 源权重值域 [0, 1]

    const smoothingFactor = this.damping.currentFactor
    let dampedValue = previousValue * (1 - smoothingFactor) + adjustment.targetValue * smoothingFactor
    dampedValue = Math.max(bounds.min, Math.min(bounds.max, dampedValue))

    if (Math.abs(dampedValue - previousValue) < 0.01) return

    const record: RadarParameterAdjustment = {
      type: adjustment.type,
      previousValue,
      newValue: dampedValue,
      targetValue: adjustment.targetValue,
      dampingFactorUsed: smoothingFactor,
      targetSource: source,
      reason: adjustment.reason,
      timestamp: Date.now(),
    }

    if (this.mode === 'monitor') {
      log('INFO', 'mcp_plan_radar_loop_monitor_adjustment', {
        type: 'source_weight',
        targetSource: source,
        previous: previousValue.toFixed(3),
        target: adjustment.targetValue.toFixed(3),
        damped: dampedValue.toFixed(3),
        reason: adjustment.reason,
        note: '[MONITOR MODE] 未实际应用',
      })
      this.adjustmentHistory.push(record)
      this.trimAdjustmentHistory()
      return
    }

    // auto 模式：实际修改
    this.currentParams.sourceWeights[source] = dampedValue

    this.damping.currentFactor = Math.max(
      this.damping.minFactor,
      this.damping.currentFactor * this.damping.decayRate,
    )

    this.adjustmentHistory.push(record)
    this.trimAdjustmentHistory()
    this.emitParameterAdjustment(record)

    log('INFO', 'mcp_plan_radar_loop_adjustment_applied', {
      type: 'source_weight',
      targetSource: source,
      previous: previousValue.toFixed(3),
      newValue: dampedValue.toFixed(3),
      dampingFactor: smoothingFactor.toFixed(3),
      reason: adjustment.reason,
    })
  }

  // ════════════════════════════════════════════════════════════════
  //  收敛监测
  // ════════════════════════════════════════════════════════════════

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

      log('WARN', 'mcp_plan_radar_loop_diverging', {
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

    // 收敛时通知
    if (this.convergence.hasConverged && this.mode === 'monitor') {
      log('INFO', 'mcp_plan_radar_loop_converged', {
        note: '回路已收敛，可手动切换到 auto 模式',
        adjustmentsMade: this.adjustmentHistory.length,
        finalDampingFactor: this.damping.currentFactor.toFixed(3),
        parameters: { ...this.currentParams, sourceWeights: { ...this.currentParams.sourceWeights } },
      })
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  参数调整策略
  // ════════════════════════════════════════════════════════════════

  /**
   * 根据当前系统质量指标计算参数调整目标。
   *
   * 核心策略逻辑 — MCP 执行质量 → 雷达参数映射：
   *
   * 1. 雷达工具成功率低 → 降低 minScoreThreshold（放宽筛选，采集更多原始信号）
   * 2. 全局延迟高 → 增大 scanIntervalMs（降低扫描频率）
   * 3. 信号综合热度持续偏低 → 降低 urgency 阈值（更多信号进入 warm/hot）
   * 4. 某来源产出信号质量高 → 提高该 sourceWeight（聚焦高价值源）
   * 5. 工具多样性高 → 增大 maxSignalsPerScan（更多工具产出 → 更多待分析信号）
   * 6. 系统不稳定 → 增大 heatDecayFactor（更快衰减旧信号，聚焦近期）
   */
  private computeParameterAdjustments(
    overallSuccessRate: number,
    radarSuccessRate: number,
    overallAvgLatency: number,
    toolDiversityIndex: number,
    instabilityScore: number,
    avgHeatIndex: number,
    sourcePerformance: Map<string, { signalCount: number; avgScore: number }>,
  ): Array<{ type: RadarAdjustmentType; targetValue: number; targetSource?: string; reason: string }> {
    const adjustments: Array<{ type: RadarAdjustmentType; targetValue: number; targetSource?: string; reason: string }> = []

    // ── 1. 雷达工具成功率 → minScoreThreshold ──
    if (radarSuccessRate < 0.7) {
      const target = Math.max(
        RADAR_PARAMETER_BOUNDS.minScoreThreshold.min,
        this.currentParams.minScoreThreshold - 0.1,
      )
      adjustments.push({
        type: 'min_score',
        targetValue: target,
        reason: `雷达工具成功率 ${(radarSuccessRate * 100).toFixed(0)}% 偏低，降低最低评分阈值以扩大采集范围`,
      })
    } else if (radarSuccessRate > 0.95 && this.currentParams.minScoreThreshold < 0.5) {
      const target = Math.min(
        RADAR_PARAMETER_BOUNDS.minScoreThreshold.max,
        this.currentParams.minScoreThreshold + 0.05,
      )
      adjustments.push({
        type: 'min_score',
        targetValue: target,
        reason: `雷达工具成功率 ${(radarSuccessRate * 100).toFixed(0)}% 高，提高最低评分阈值以聚焦高价值信号`,
      })
    }

    // ── 2. 全局延迟 → scanIntervalMs ──
    if (overallAvgLatency > 5000) {
      const target = Math.min(
        RADAR_PARAMETER_BOUNDS.scanIntervalMs.max,
        this.currentParams.scanIntervalMs * 1.5,
      )
      adjustments.push({
        type: 'scan_interval',
        targetValue: target,
        reason: `平均延迟 ${Math.round(overallAvgLatency)}ms 偏高，增大扫描间隔以降低系统负载`,
      })
    } else if (overallAvgLatency < 1000 && this.convergence.stableObservationCount >= 2) {
      const target = Math.max(
        RADAR_PARAMETER_BOUNDS.scanIntervalMs.min,
        this.currentParams.scanIntervalMs * 0.8,
      )
      adjustments.push({
        type: 'scan_interval',
        targetValue: target,
        reason: `平均延迟 ${Math.round(overallAvgLatency)}ms 较低，适当缩短扫描间隔以加快信息采集`,
      })
    }

    // ── 3. 信号综合热度 → urgency 阈值 ──
    if (avgHeatIndex > 0 && avgHeatIndex < 0.3) {
      // 热度持续偏低 → 降低阈值让更多信号进入 warm/hot
      const hotTarget = Math.max(
        RADAR_PARAMETER_BOUNDS.urgencyHotThreshold.min,
        this.currentParams.urgencyHotThreshold - 0.05,
      )
      adjustments.push({
        type: 'urgency_hot',
        targetValue: hotTarget,
        reason: `信号综合热度 ${(avgHeatIndex * 100).toFixed(0)}% 偏低，降低 hot 阈值以增加紧急信号量`,
      })

      const warmTarget = Math.max(
        RADAR_PARAMETER_BOUNDS.urgencyWarmThreshold.min,
        this.currentParams.urgencyWarmThreshold - 0.05,
      )
      adjustments.push({
        type: 'urgency_warm',
        targetValue: warmTarget,
        reason: `信号综合热度 ${(avgHeatIndex * 100).toFixed(0)}% 偏低，降低 warm 阈值以增加关注信号量`,
      })
    } else if (avgHeatIndex > 0.6) {
      // 热度高 → 提高阈值聚焦高价值
      const hotTarget = Math.min(
        RADAR_PARAMETER_BOUNDS.urgencyHotThreshold.max,
        this.currentParams.urgencyHotThreshold + 0.05,
      )
      adjustments.push({
        type: 'urgency_hot',
        targetValue: hotTarget,
        reason: `信号综合热度 ${(avgHeatIndex * 100).toFixed(0)}% 高，提高 hot 阈值以聚焦最高价值信号`,
      })
    }

    // ── 4. 来源表现 → sourceWeight ──
    if (sourcePerformance.size > 0) {
      let totalSignals = 0
      for (const [, perf] of sourcePerformance) {
        totalSignals += perf.signalCount
      }
      if (totalSignals > 0) {
        for (const [source, perf] of sourcePerformance) {
          const currentWeight = this.currentParams.sourceWeights[source] ?? 0.3
          // 如果来源产出信号且平均分高 → 提高权重
          if (perf.signalCount >= 2 && perf.avgScore > 0.5 && currentWeight < 0.95) {
            adjustments.push({
              type: 'source_weight',
              targetValue: Math.min(1.0, currentWeight + 0.1),
              targetSource: source,
              reason: `来源 ${source} 产出 ${perf.signalCount} 条信号，平均分 ${perf.avgScore.toFixed(2)}，提高权重以聚焦`,
            })
          }
          // 如果来源产出信号但平均分极低 → 降低权重
          if (perf.signalCount >= 2 && perf.avgScore < 0.2 && currentWeight > 0.1) {
            adjustments.push({
              type: 'source_weight',
              targetValue: Math.max(0.0, currentWeight - 0.1),
              targetSource: source,
              reason: `来源 ${source} 产出 ${perf.signalCount} 条信号但平均分仅 ${perf.avgScore.toFixed(2)}，降低权重以减少噪音`,
            })
          }
        }
      }
    }

    // ── 5. 工具多样性 → maxSignalsPerScan ──
    if (toolDiversityIndex > 0.6) {
      const target = Math.min(
        RADAR_PARAMETER_BOUNDS.maxSignalsPerScan.max,
        this.currentParams.maxSignalsPerScan + 5,
      )
      adjustments.push({
        type: 'max_signals',
        targetValue: target,
        reason: `工具使用多样性高 (${toolDiversityIndex.toFixed(2)})，增大 maxSignalsPerScan 以覆盖更多信息维度`,
      })
    } else if (toolDiversityIndex < 0.2) {
      const target = Math.max(
        RADAR_PARAMETER_BOUNDS.maxSignalsPerScan.min,
        this.currentParams.maxSignalsPerScan - 5,
      )
      adjustments.push({
        type: 'max_signals',
        targetValue: target,
        reason: `工具使用集中 (${toolDiversityIndex.toFixed(2)})，减少 maxSignalsPerScan 以精简输出`,
      })
    }

    // ── 6. 不稳定性 → heatDecayFactor ──
    if (instabilityScore > 0.3) {
      // 系统不稳定 → 增大衰减因子（更快遗忘旧信号）
      const target = Math.min(
        RADAR_PARAMETER_BOUNDS.heatDecayFactor.max,
        this.currentParams.heatDecayFactor + 0.05,
      )
      adjustments.push({
        type: 'heat_decay',
        targetValue: target,
        reason: `系统不稳定 (分数 ${instabilityScore.toFixed(2)})，增大热度衰减因子以更快聚焦近期信号`,
      })
    } else if (instabilityScore < 0.1 && this.convergence.stableObservationCount >= 2) {
      const target = Math.max(
        RADAR_PARAMETER_BOUNDS.heatDecayFactor.min,
        this.currentParams.heatDecayFactor - 0.05,
      )
      adjustments.push({
        type: 'heat_decay',
        targetValue: target,
        reason: `系统稳定 (分数 ${instabilityScore.toFixed(2)})，降低热度衰减因子以保持信号历史参考价值`,
      })
    }

    return adjustments
  }

  // ════════════════════════════════════════════════════════════════
  //  质量指标计算
  // ════════════════════════════════════════════════════════════════

  /** 重建工具级聚合快照 */
  private rebuildToolSnapshots(): void {
    this.toolSnapshots.clear()

    const perTool = new Map<string, ToolExecQuality[]>()
    for (const q of this.executionQueue) {
      const list = perTool.get(q.toolName)
      if (list) list.push(q)
      else perTool.set(q.toolName, [q])
    }

    for (const [toolName, qualities] of perTool) {
      const totalCalls = qualities.length
      const successCount = qualities.filter((q) => q.success).length
      const successRate = totalCalls > 0 ? successCount / totalCalls : 0
      const avgLatency = this.computeAvgLatency(qualities)
      const avgSignalCount = this.computeAvgSignalCount(qualities)
      const isRadarTool = qualities[0]?.isRadarTool ?? false

      this.toolSnapshots.set(toolName, {
        totalCalls,
        successCount,
        successRate,
        avgLatency,
        isRadarTool,
        avgSignalCount,
      })
    }
  }

  /** 计算工具平均延迟 */
  private computeAvgLatency(qualities: ToolExecQuality[]): number {
    const latencies = qualities.map((q) => q.latencyMs).filter((l) => l > 0)
    if (latencies.length === 0) return 1500
    return latencies.reduce((s, v) => s + v, 0) / latencies.length
  }

  /** 计算工具平均关联信号数（仅雷达工具） */
  private computeAvgSignalCount(qualities: ToolExecQuality[]): number {
    const signalCounts = qualities.map((q) => q.signalCount).filter((c): c is number => c !== undefined)
    if (signalCounts.length === 0) return 0
    return signalCounts.reduce((s, v) => s + v, 0) / signalCounts.length
  }

  /** 计算全局成功率 */
  private computeOverallSuccessRate(): number {
    if (this.executionQueue.length === 0) return 1
    const successes = this.executionQueue.filter((q) => q.success).length
    return successes / this.executionQueue.length
  }

  /** 计算雷达工具成功率 */
  private computeRadarSuccessRate(): number {
    const radarExecs = this.executionQueue.filter((q) => q.isRadarTool)
    if (radarExecs.length === 0) return 1
    const successes = radarExecs.filter((q) => q.success).length
    return successes / radarExecs.length
  }

  /** 计算全局平均延迟 */
  private computeOverallAvgLatency(): number {
    const latencies = this.executionQueue.map((q) => q.latencyMs).filter((l) => l > 0)
    if (latencies.length === 0) return 2000
    return latencies.reduce((s, v) => s + v, 0) / latencies.length
  }

  /** 计算工具多样性指数 */
  private computeToolDiversityIndex(): number {
    if (this.executionQueue.length === 0) return 0
    const uniqueTools = new Set(this.executionQueue.map((q) => q.toolName))
    const toolCounts = new Map<string, number>()
    for (const q of this.executionQueue) {
      toolCounts.set(q.toolName, (toolCounts.get(q.toolName) || 0) + 1)
    }
    const maxFreq = Math.max(...toolCounts.values(), 1)
    const normalizedDiversity = 1 - maxFreq / this.executionQueue.length
    const typeRatio = Math.min(uniqueTools.size / 20, 1)
    return (normalizedDiversity + typeRatio) / 2
  }

  /** 计算不稳定性分数 */
  private computeInstabilityScore(): number {
    if (this.toolSnapshots.size === 0) return 0
    let totalEntropy = 0
    let toolCount = 0

    for (const [, snap] of this.toolSnapshots) {
      if (snap.totalCalls < 3) continue
      const p = snap.successRate
      const entropy = p > 0 && p < 1
        ? -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p))
        : 0
      // 延迟波动：变异系数
      const cv = snap.avgLatency > 0 ? 0.3 : 0 // 无原始标准差，用固定系数近似
      totalEntropy += entropy + cv
      toolCount++
    }
    return toolCount > 0 ? totalEntropy / toolCount : 0
  }

  /** 计算雷达扫描结果的平均综合热度（最近 N 次扫描） */
  private computeAvgHeatIndex(): number {
    const recent = this.radarScanResults.slice(-5)
    if (recent.length === 0) return 0
    const total = recent.reduce((s, r) => s + (r.compositeHeatIndex ?? 0), 0)
    return total / recent.length
  }

  /**
   * 计算各信号源的产出表现。
   * 基于最近 N 次雷达扫描结果的 sourceDistribution 和信号评分。
   */
  private computeSourcePerformance(): Map<string, { signalCount: number; avgScore: number }> {
    const perf = new Map<string, { signalCount: number; avgScore: number }>()
    const recent = this.radarScanResults.slice(-10)

    for (const result of recent) {
      // 从雷达扫描结果的 sourceDistribution 获取各源信号数
      for (const [source, count] of Object.entries(result.sourceDistribution ?? {})) {
        const current = perf.get(source) ?? { signalCount: 0, avgScore: 0 }
        current.signalCount += count
        perf.set(source, current)
      }

      // 从 signals 获取各源平均评分
      const sourceScores = new Map<string, number[]>()
      for (const signal of result.signals ?? []) {
        const scores = sourceScores.get(signal.source) ?? []
        scores.push(signal.compositeScore)
        sourceScores.set(signal.source, scores)
      }

      for (const [source, scores] of sourceScores) {
        const avg = scores.reduce((s, v) => s + v, 0) / scores.length
        const current = perf.get(source)
        if (current) {
          // 加权平均：按信号数
          current.avgScore = current.avgScore > 0
            ? (current.avgScore + avg) / 2
            : avg
          perf.set(source, current)
        }
      }
    }

    return perf
  }

  // ════════════════════════════════════════════════════════════════
  //  辅助函数
  // ════════════════════════════════════════════════════════════════

  /** 判断工具名是否为雷达相关工具 */
  private isRadarToolName(name: string): boolean {
    return name === 'radar_scan' || name === 'radar_analyze'
  }

  /** 从雷达工具执行结果中提取信号数量 */
  private extractSignalCount(toolName: string, result?: string): number | undefined {
    if (!result || !this.isRadarToolName(toolName)) return undefined
    if (toolName === 'radar_scan') {
      // 从结果文本中提取 "共 N 条结果"
      const m = result.match(/共\s*(\d+)\s*条结果/)
      if (m) return parseInt(m[1], 10)
    }
    return undefined
  }

  /** RadarAdjustmentType → RadarParameterSet key */
  private adjustmentTypeToParamKey(type: RadarAdjustmentType): keyof RadarParameterSet | null {
    switch (type) {
      case 'scan_interval': return 'scanIntervalMs'
      case 'min_score': return 'minScoreThreshold'
      case 'source_weight': return 'sourceWeights'
      case 'urgency_hot': return 'urgencyHotThreshold'
      case 'urgency_warm': return 'urgencyWarmThreshold'
      case 'max_signals': return 'maxSignalsPerScan'
      case 'heat_decay': return 'heatDecayFactor'
      default: return null
    }
  }

  /** 裁剪调整历史 */
  private trimAdjustmentHistory(): void {
    if (this.adjustmentHistory.length > this.MAX_ADJUSTMENT_HISTORY) {
      this.adjustmentHistory.splice(0, this.adjustmentHistory.length - this.MAX_ADJUSTMENT_HISTORY)
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  事件发送
  // ════════════════════════════════════════════════════════════════

  /** 发出回路状态变更事件 */
  private emitStateChange(): void {
    const payload: RadarLoopStateChangePayload = {
      mode: this.mode,
      convergenceState: this.convergence.state,
      totalAdjustments: this.adjustmentHistory.length,
      totalObservations: this.executionQueue.length,
      dampingFactor: this.damping.currentFactor,
    }
    eventBus.emit('feedback_loop.state_changed' as any, payload)
  }

  /** 发出参数调整事件 */
  private emitParameterAdjustment(adjustment: RadarParameterAdjustment): void {
    const payload: RadarParameterAdjustmentPayload = {
      type: adjustment.type,
      previousValue: adjustment.previousValue,
      newValue: adjustment.newValue,
      dampingFactor: adjustment.dampingFactorUsed,
      targetSource: adjustment.targetSource,
      reason: adjustment.reason,
    }
    eventBus.emit('feedback_loop.parameter_adjusted' as any, payload)
  }

  // ════════════════════════════════════════════════════════════════
  //  状态查询（供外部监控使用）
  // ════════════════════════════════════════════════════════════════

  /** 获取回路状态快照 */
  getState(): RadarFeedbackLoopState {
    return {
      mode: this.mode,
      damping: { ...this.damping },
      convergence: { ...this.convergence },
      totalSignalsObserved: this.radarScanResults.reduce((s, r) => s + r.totalSignals, 0),
      totalAdjustments: this.adjustmentHistory.length,
      currentParameters: {
        ...this.currentParams,
        sourceWeights: { ...this.currentParams.sourceWeights },
      },
      lastAdjustment: this.adjustmentHistory.length > 0
        ? this.adjustmentHistory[this.adjustmentHistory.length - 1]
        : null,
      startedAt: this.startedAt,
      updatedAt: Date.now(),
    }
  }

  /** 获取当前参数集 */
  getCurrentParameters(): RadarParameterSet {
    return {
      ...this.currentParams,
      sourceWeights: { ...this.currentParams.sourceWeights },
    }
  }

  /** 获取调整历史 */
  getAdjustmentHistory(): RadarParameterAdjustment[] {
    return [...this.adjustmentHistory]
  }

  /** 获取阻尼状态 */
  getDampingState(): RadarDampingState {
    return { ...this.damping }
  }

  /** 获取收敛指标 */
  getConvergenceMetrics(): RadarConvergenceMetrics {
    return { ...this.convergence }
  }
}
