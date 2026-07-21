/**
 * AgentMonitor — Agent 性能监控器
 *
 * 嵌入 Agent 中，采集每轮交互的核心指标（成功率、情感分数、响应延迟、工具调用量），
 * 在滚动窗口上计算趋势，当指标持续劣化时发出事件信号，供 Evolution 系统消费。
 *
 * ── 数据流 ──
 * ChatExecutor.每轮结束 → AgentMonitor.recordRound() → 滚动窗口存储
 * AgentPerformanceCollector → AgentMonitor.getWindow() → Problem (进化管道)
 * SelfEvolutionService → AgentMonitor.getTrendAnalysis() → 自动优化决策
 */

import { log } from '../logger/Logger'
import { eventBus } from '../core/EventBus'

// =============================================================================
// 类型定义
// =============================================================================

/** 单轮交互的指标快照 */
export interface RoundMetrics {
  /** 时间戳（毫秒） */
  timestamp: number
  /** 是否成功完成（无 LLM/工具级错误） */
  success: boolean
  /** 情感分数 0~1（由 SentimentAnalyzer 提供，0=负面，1=正面） */
  sentimentScore: number
  /** 本轮总延迟（毫秒，从输入到最终回复就绪） */
  durationMs: number
  /** 本轮调用的工具数量 */
  toolCallCount: number
  /** 本轮 LLM 调用次数 */
  llmCallCount: number
  /** 是否被用户中断（stopConversation） */
  wasInterrupted: boolean
  /** 可选标签（用于区分对话来源：electron / telegram） */
  source?: string
}

/** 监控器配置 */
export interface AgentMonitorConfig {
  /** 滚动窗口大小（保留最近 N 轮的指标） */
  windowSize: number
  /** 退化检测：连续窗口的成功率下降超过此比例 */
  degradationSuccessRateThreshold: number
  /** 退化检测：情感分数下降超过此值 */
  degradationSentimentThreshold: number
  /** 退化检测：需要连续 N 个窗口都满足退化条件才触发 */
  degradationMinWindows: number
  /** 最小安全运行轮数（低于此不执行退化检测） */
  minRoundsForAnalysis: number
  /** 是否禁用事件发射（沙箱/测试环境） */
  suppressEvents: boolean
}

const DEFAULT_CONFIG: AgentMonitorConfig = {
  windowSize: 50,
  degradationSuccessRateThreshold: 0.15,
  degradationSentimentThreshold: 0.12,
  degradationMinWindows: 2,
  minRoundsForAnalysis: 10,
  suppressEvents: false,
}

/** 滚动窗口指标的摘要 */
export interface MetricsWindowSummary {
  /** 窗口内轮数 */
  totalRounds: number
  /** 成功率 */
  successRate: number
  /** 平均情感分数 */
  avgSentiment: number
  /** 平均延迟（毫秒） */
  avgDurationMs: number
  /** 平均工具调用数 */
  avgToolCalls: number
  /** 中断率 */
  interruptionRate: number
}

/** 趋势分析结果 */
export interface TrendAnalysis {
  /** 可用数据是否充足 */
  hasSufficientData: boolean
  /** 当前窗口摘要 */
  current: MetricsWindowSummary
  /** 前序窗口摘要（对比基准） */
  previous: MetricsWindowSummary | null
  /** 成功率变化（正值=改善，负值=劣化） */
  successRateDelta: number | null
  /** 情感分数变化 */
  sentimentDelta: number | null
  /** 是否检测到退化 */
  isDegraded: boolean
  /** 退化信号列表 */
  degradationSignals: Array<{
    type: 'success_rate' | 'sentiment' | 'latency' | 'interruption'
    severity: 'warning' | 'critical'
    description: string
    currentValue: number
    previousValue: number
    threshold: number
  }>
}

// =============================================================================
// AgentMonitor 实现
// =============================================================================

export class AgentMonitor {
  /** 配置 */
  private config: AgentMonitorConfig
  /** 滚动窗口历史 */
  private history: RoundMetrics[] = []
  /** 连续退化窗口计数 */
  private consecutiveDegradedWindows = 0
  /** 上次发射退化事件的时间（用于冷却） */
  private lastDegradationEventMs = 0
  /** 两发退化事件的最小间隔（毫秒） */
  private static readonly DEGRADATION_EVENT_COOLDOWN_MS = 30 * 60 * 1000

  constructor(config?: Partial<AgentMonitorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    log('INFO', 'agent_monitor_init', {
      windowSize: this.config.windowSize,
      minRoundsForAnalysis: this.config.minRoundsForAnalysis,
      suppressEvents: this.config.suppressEvents,
    })
  }

  // ==================== 公共 API ====================

  /**
   * 记录一轮交互的指标。
   * 由 ChatExecutor 在每轮对话结束后调用。
   */
  recordRound(metrics: RoundMetrics): void {
    this.history.push(metrics)

    // 保持窗口大小
    if (this.history.length > this.config.windowSize) {
      this.history.splice(0, this.history.length - this.config.windowSize)
    }

    // 每记录一轮检查退化
    this.checkDegradation()
  }

  /**
   * 获取完整的滚动窗口历史（只读快照）。
   */
  getWindow(): readonly RoundMetrics[] {
    return this.history
  }

  /**
   * 获取当前窗口摘要。
   */
  getCurrentSummary(): MetricsWindowSummary | null {
    if (this.history.length === 0) return null
    return this.computeSummary(this.history)
  }

  /**
   * 获取趋势分析：对比最近半窗口 vs 前序半窗口。
   *
   * 分割逻辑：
   * - 如果窗口 >= 2 * minRoundsForAnalysis，将窗口等分为 current(后半) 和 previous(前半)
   * - 否则将最近 minRoundsForAnalysis 条作为 current
   */
  getTrendAnalysis(): TrendAnalysis {
    const total = this.history.length
    const hasSufficientData = total >= this.config.minRoundsForAnalysis

    if (!hasSufficientData) {
      return {
        hasSufficientData: false,
        current: this.computeSummary(this.history),
        previous: null,
        successRateDelta: null,
        sentimentDelta: null,
        isDegraded: false,
        degradationSignals: [],
      }
    }

    // 分割窗口
    const halfSize = Math.max(this.config.minRoundsForAnalysis, Math.floor(total / 2))
    const previousSlice = this.history.slice(0, total - halfSize)
    const currentSlice = this.history.slice(total - halfSize)

    const current = this.computeSummary(currentSlice)
    const previous = previousSlice.length >= this.config.minRoundsForAnalysis
      ? this.computeSummary(previousSlice)
      : this.computeSummary(this.history.slice(0, total - Math.min(this.config.minRoundsForAnalysis, total)))

    // 计算 delta
    const successRateDelta = previous ? current.successRate - previous.successRate : null
    const sentimentDelta = previous ? current.avgSentiment - previous.avgSentiment : null

    // 检测退化信号
    const signals: TrendAnalysis['degradationSignals'] = []

    if (previous && successRateDelta !== null && successRateDelta < -this.config.degradationSuccessRateThreshold) {
      signals.push({
        type: 'success_rate',
        severity: successRateDelta < -this.config.degradationSuccessRateThreshold * 2 ? 'critical' : 'warning',
        description: `对话成功率下降 ${(Math.abs(successRateDelta) * 100).toFixed(1)}%`
          + `（${(previous.successRate * 100).toFixed(0)}% → ${(current.successRate * 100).toFixed(0)}%）`,
        currentValue: current.successRate,
        previousValue: previous.successRate,
        threshold: this.config.degradationSuccessRateThreshold,
      })
    }

    if (previous && sentimentDelta !== null && sentimentDelta < -this.config.degradationSentimentThreshold) {
      signals.push({
        type: 'sentiment',
        severity: sentimentDelta < -this.config.degradationSentimentThreshold * 2 ? 'critical' : 'warning',
        description: `用户情感分数下降 ${(Math.abs(sentimentDelta) * 100).toFixed(1)}%`
          + `（${(previous.avgSentiment * 100).toFixed(0)}% → ${(current.avgSentiment * 100).toFixed(0)}%）`,
        currentValue: current.avgSentiment,
        previousValue: previous.avgSentiment,
        threshold: this.config.degradationSentimentThreshold,
      })
    }

    if (previous && current.avgDurationMs > previous.avgDurationMs * 1.5 && current.avgDurationMs > 20000) {
      signals.push({
        type: 'latency',
        severity: current.avgDurationMs > previous.avgDurationMs * 2.5 ? 'critical' : 'warning',
        description: `平均响应延迟显著增加`
          + `（${previous.avgDurationMs}ms → ${current.avgDurationMs}ms）`,
        currentValue: current.avgDurationMs,
        previousValue: previous.avgDurationMs,
        threshold: previous.avgDurationMs * 1.5,
      })
    }

    if (previous && current.interruptionRate > previous.interruptionRate + 0.1 && current.interruptionRate > 0.2) {
      signals.push({
        type: 'interruption',
        severity: 'warning',
        description: `用户中断率上升`
          + `（${(previous.interruptionRate * 100).toFixed(0)}% → ${(current.interruptionRate * 100).toFixed(0)}%）`,
        currentValue: current.interruptionRate,
        previousValue: previous.interruptionRate,
        threshold: previous.interruptionRate + 0.1,
      })
    }

    const isDegraded = signals.length > 0

    return {
      hasSufficientData: true,
      current,
      previous: previous || null,
      successRateDelta,
      sentimentDelta,
      isDegraded,
      degradationSignals: signals,
    }
  }

  /**
   * 是否检测到性能退化（简化的快速检查）。
   */
  isDegraded(): boolean {
    const trend = this.getTrendAnalysis()
    return trend.hasSufficientData && trend.isDegraded
  }

  /**
   * 重置监控器状态（清空历史）。
   */
  reset(): void {
    this.history = []
    this.consecutiveDegradedWindows = 0
    log('INFO', 'agent_monitor_reset')
  }

  /**
   * 获取当前配置。
   */
  getConfig(): Readonly<AgentMonitorConfig> {
    return { ...this.config }
  }

  /**
   * 更新配置。
   */
  updateConfig(partial: Partial<AgentMonitorConfig>): void {
    this.config = { ...this.config, ...partial }
  }

  /**
   * 获取记录的轮数。
   */
  get count(): number {
    return this.history.length
  }

  // ==================== 内部方法 ====================

  /**
   * 计算指定窗口的摘要统计。
   */
  private computeSummary(rounds: RoundMetrics[]): MetricsWindowSummary {
    if (rounds.length === 0) {
      return {
        totalRounds: 0,
        successRate: 0,
        avgSentiment: 0,
        avgDurationMs: 0,
        avgToolCalls: 0,
        interruptionRate: 0,
      }
    }

    const total = rounds.length
    const successCount = rounds.filter((r) => r.success).length
    const interruptedCount = rounds.filter((r) => r.wasInterrupted).length
    const totalSentiment = rounds.reduce((sum, r) => sum + r.sentimentScore, 0)
    const totalDuration = rounds.reduce((sum, r) => sum + r.durationMs, 0)
    const totalToolCalls = rounds.reduce((sum, r) => sum + r.toolCallCount, 0)

    return {
      totalRounds: total,
      successRate: successCount / total,
      avgSentiment: total > 0 ? totalSentiment / total : 0,
      avgDurationMs: total > 0 ? totalDuration / total : 0,
      avgToolCalls: total > 0 ? totalToolCalls / total : 0,
      interruptionRate: interruptedCount / total,
    }
  }

  /**
   * 检查退化条件，满足时发射事件。
   */
  private checkDegradation(): void {
    if (this.config.suppressEvents) return
    if (this.history.length < this.config.minRoundsForAnalysis) return

    const trend = this.getTrendAnalysis()
    if (!trend.hasSufficientData || !trend.isDegraded) {
      this.consecutiveDegradedWindows = 0
      return
    }

    this.consecutiveDegradedWindows++

    if (this.consecutiveDegradedWindows >= this.config.degradationMinWindows) {
      // 冷却检查：避免频繁发射
      const now = Date.now()
      if (now - this.lastDegradationEventMs < AgentMonitor.DEGRADATION_EVENT_COOLDOWN_MS) return
      this.lastDegradationEventMs = now

      const criticalSignals = trend.degradationSignals.filter((s) => s.severity === 'critical')

      log('WARN', 'agent_performance_degraded', {
        signals: trend.degradationSignals.length,
        criticalCount: criticalSignals.length,
        successRateDelta: trend.successRateDelta,
        sentimentDelta: trend.sentimentDelta,
      })

      // 发射事件供 Evolution 系统消费
      ;(eventBus.emit as any)('agent.performance.degraded', {
        timestamp: now,
        signals: trend.degradationSignals,
        trends: {
          successRate: {
            current: trend.current.successRate,
            previous: trend.previous?.successRate,
            delta: trend.successRateDelta,
          },
          sentiment: {
            current: trend.current.avgSentiment,
            previous: trend.previous?.avgSentiment,
            delta: trend.sentimentDelta,
          },
          latency: {
            current: trend.current.avgDurationMs,
            previous: trend.previous?.avgDurationMs,
          },
        },
        windowRounds: this.history.length,
        isCritical: criticalSignals.length > 0,
      })
    }
  }
}

/** 全局单例（由 AppRuntime 在启动后启用事件发射） */
export const agentMonitor = new AgentMonitor()
