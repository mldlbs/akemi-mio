/**
 * QualityMetricsTracker — 质量指标追踪器
 *
 * 职责：
 * - 在每个 Evolution 周期结束时获取质量指标快照
 * - 跨周期计算趋势（improving/stable/declining）
 * - 检测指标降级并生成 DegradationSignal
 * - 快照持久化到磁盘（JSON 文件）
 *
 * 集成点：
 * - UserBehaviorLayer 的预处理钩子：周期开始前读取最近趋势
 * - UserBehaviorLayer 的后处理钩子：周期结束后记录新快照
 * - SelfEvolutionService：读取质量指标趋势，在摘要中包含降级信号
 *
 * 指标定义：
 * - errorRate: 整体错误率（失败调用/总调用）
 * - moduleErrorRate: 模块级错误率
 * - toolSuccessRate: 平均工具成功率
 * - pauseSeverity: 停顿严重度（从 pausePoints 推导，作为响应时间的代理指标）
 * - callVolume: 工具调用活跃度
 *
 * 降级检测逻辑：
 * 1. 比较当前值与上一周期值
 * 2. 如果 delta 超过 degradationThreshold（默认 10%）
 * 3. 且指标为劣化方向（errorRate↑, successRate↓, pauseSeverity↑）
 * 4. 且严重度超过 severityThreshold
 * 5. 则生成 DegradationSignal → Evolution 优化目标
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { log } from '../logger/Logger'
import { behaviorFeatureExtractor } from './BehaviorFeatureExtractor'
import { behaviorHeatmapService } from './BehaviorHeatmapService'
import type { ModuleHeatmap } from './types'
import type {
  QualityMetricsSnapshot,
  MetricSnapshot,
  MetricTrend,
  DegradationSignal,
  QualityMetricsConfig,
} from './types'

// =============================================================================
// 默认配置
// =============================================================================

const DEFAULT_CONFIG: QualityMetricsConfig = {
  stateFilePath: '', // 由构造器根据 WORKSPACE 设置
  degradationThreshold: 0.1,
  severityThreshold: 0.3,
  maxSnapshots: 12,
}

// =============================================================================
// QualityMetricsTracker
// =============================================================================

export class QualityMetricsTracker {
  private config: QualityMetricsConfig
  /** 内存中的快照缓存（从持久化恢复） */
  private snapshots: QualityMetricsSnapshot[] = []
  /** 上次快照时间（防止同一周期重复记录） */
  private lastSnapshotTime = 0

  constructor(config?: Partial<QualityMetricsConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.loadSnapshots()
  }

  // ==================== 公共 API ====================

  /** 获取最新快照 */
  getLatestSnapshot(): QualityMetricsSnapshot | null {
    return this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1] : null
  }

  /** 获取历史快照列表 */
  getAllSnapshots(): QualityMetricsSnapshot[] {
    return [...this.snapshots]
  }

  /** 获取最近 N 个快照 */
  getRecentSnapshots(n: number): QualityMetricsSnapshot[] {
    return this.snapshots.slice(-n)
  }

  /** 获取是否检测到总体降级 */
  isDegraded(): boolean {
    return this.snapshots.some((s) => s.isDegraded)
  }

  /** 获取最近的降级信号 */
  getRecentDegradationSignals(): DegradationSignal[] {
    if (this.snapshots.length === 0) return []
    const latest = this.snapshots[this.snapshots.length - 1]
    return latest.isDegraded ? latest.degradationSignals : []
  }

  /** 过去 N 个周期内是否存在持续的指标降级趋势 */
  hasPersistentDowntrend(cycles = 3): boolean {
    if (this.snapshots.length < cycles) return false
    const recent = this.snapshots.slice(-cycles)
    // 要求连续 N 个周期健康评分都在下降
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].healthScore >= recent[i - 1].healthScore) return false
    }
    return true
  }

  // ==================== 核心：记录一次指标快照 ====================

  /**
   * 记录一次质量指标快照。
   * 读取 BehaviorFeatureExtractor + BehaviorHeatmapService 的当前数据，
   * 与上一周期对比，生成趋势和降级信号。
   *
   * @returns 新生成的快照
   */
  recordSnapshot(): QualityMetricsSnapshot {
    const now = Date.now()
    const prev = this.getLatestSnapshot()
    const hoursSinceLast = prev ? (now - prev.createdAt) / (1000 * 60 * 60) : Infinity

    // 1. 收集当前指标
    const features = behaviorFeatureExtractor.extract(48)
    const heatmap = behaviorHeatmapService.generate(48)

    // 2. 计算各项指标值
    const metrics = this.computeMetrics(features, heatmap)

    // 3. 计算趋势（与上一周期对比）
    const metricsWithTrend = this.computeTrends(metrics, prev)

    // 4. 计算总体健康评分
    const healthScore = this.computeHealthScore(metricsWithTrend)
    const healthScoreDelta = prev ? healthScore - prev.healthScore : 0

    // 5. 检测降级
    const isDegraded = healthScoreDelta < -this.config.degradationThreshold * 100
    const degradationSignals = isDegraded
      ? this.detectDegradation(metricsWithTrend, prev!)
      : []

    // 6. 构建快照
    const snapshot: QualityMetricsSnapshot = {
      id: `qm_${now}`,
      createdAt: now,
      hoursSinceLastSnapshot: hoursSinceLast,
      metrics: metricsWithTrend,
      healthScore: Math.round(healthScore * 10) / 10,
      healthScoreDelta: Math.round(healthScoreDelta * 10) / 10,
      isDegraded,
      totalToolCalls: features.totalToolCalls,
      degradationSignals,
    }

    // 7. 保存
    this.snapshots.push(snapshot)
    if (this.snapshots.length > this.config.maxSnapshots) {
      this.snapshots = this.snapshots.slice(-this.config.maxSnapshots)
    }
    this.lastSnapshotTime = now
    this.persistSnapshots()

    log('INFO', 'quality_metrics_snapshot', {
      healthScore: snapshot.healthScore,
      delta: snapshot.healthScoreDelta,
      degraded: isDegraded,
      signals: degradationSignals.length,
      totalCalls: features.totalToolCalls,
      metrics: metricsWithTrend.map((m) => `${m.name}=${(m.value * 100).toFixed(0)}%(${m.trend})`).join(', '),
    })

    return snapshot
  }

  // ==================== 指标计算 ====================

  /**
   * 从 BehaviorFeatureExtractor 和 BehaviorHeatmapService 的当前输出计算质量指标。
   */
  private computeMetrics(
    features: ReturnType<typeof behaviorFeatureExtractor.extract>,
    heatmap: ModuleHeatmap,
  ): MetricSnapshot[] {
    const metrics: MetricSnapshot[] = []

    // ── 1. 整体错误率 ──
    if (features.frequentTools.length > 0) {
      const totalCalls = features.frequentTools.reduce((s, t) => s + t.callCount, 0)
      const failedCalls = features.frequentTools.reduce(
        (s, t) => s + Math.round(t.callCount * (1 - t.successRate)),
        0,
      )
      const errorRate = totalCalls > 0 ? failedCalls / totalCalls : 0
      metrics.push({
        name: 'error_rate',
        value: 1 - errorRate, // 倒转：1 = 无错误
        trend: 'stable',
        delta: 0,
        degraded: false,
        relatedModules: features.frequentTools
          .filter((t) => t.successRate < 0.8)
          .map((t) => t.name)
          .join(','),
        description: '整体错误率（倒置，越高越好）',
      })
    }

    // ── 2. 模块级平均错误率 ──
    if (heatmap.hasSufficientData && heatmap.entries.length > 0) {
      const avgModuleErrorRate =
        heatmap.entries.reduce((s, e) => s + e.errorRate, 0) / heatmap.entries.length
      const highErrorModules = heatmap.entries
        .filter((e) => e.errorRate > 0.2)
        .map((e) => e.module)
      metrics.push({
        name: 'module_error_rate',
        value: 1 - avgModuleErrorRate,
        trend: 'stable',
        delta: 0,
        degraded: false,
        relatedModules: highErrorModules.join(',') || undefined,
        description: '模块级平均错误率（倒置，越高越好）',
      })
    }

    // ── 3. 平均工具成功率 ──
    if (features.frequentTools.length > 0) {
      const avgSuccessRate =
        features.frequentTools.reduce((s, t) => s + t.successRate, 0) /
        features.frequentTools.length
      metrics.push({
        name: 'tool_success_rate',
        value: avgSuccessRate,
        trend: 'stable',
        delta: 0,
        degraded: false,
        description: '工具平均成功率',
      })
    }

    // ── 4. 停顿严重度（作为响应时间的代理指标） ──
    if (features.pausePoints.length > 0) {
      // avgPauseSeverity = 平均等待时间 / max(30000, 最长的等待) 归一化到 0-1
      const maxPause = Math.max(...features.pausePoints.map((p) => p.avgWaitMs), 30000)
      const avgSeverity =
        features.pausePoints.reduce((s, p) => s + p.avgWaitMs / maxPause, 0) /
        features.pausePoints.length
      // 倒置：1 = 无停顿（好），0 = 严重停顿（差）
      metrics.push({
        name: 'pause_severity',
        value: 1 - avgSeverity,
        trend: 'stable',
        delta: 0,
        degraded: false,
        relatedModules: features.pausePoints.map((p) => p.tool).join(','),
        description: '工具停顿严重度（倒置，越高越好）',
      })
    }

    // ── 5. 工具调用活跃度 ──
    if (features.totalToolCalls > 0) {
      // 活跃度 = min(totalCalls / 48, 1) — 48 是分析窗口上限
      const activity = Math.min(features.totalToolCalls / 48, 1)
      metrics.push({
        name: 'call_activity',
        value: activity,
        trend: 'stable',
        delta: 0,
        degraded: false,
        description: '工具调用活跃度（窗口利用率）',
      })
    }

    // ── 6. 高频失败工具占比 ──
    const highFailTools = features.frequentTools.filter(
      (t) => t.successRate < 0.7 && t.callCount >= 3,
    )
    if (highFailTools.length > 0 && features.frequentTools.length > 0) {
      const badToolRatio = highFailTools.length / features.frequentTools.length
      metrics.push({
        name: 'high_failure_tool_ratio',
        value: 1 - badToolRatio,
        trend: 'stable',
        delta: 0,
        degraded: false,
        relatedModules: highFailTools.map((t) => t.name).join(','),
        description: '高频失败工具占比（倒置，越高越好）',
      })
    }

    return metrics
  }

  /**
   * 计算指标趋势：与上一周期对比。
   */
  private computeTrends(
    current: MetricSnapshot[],
    previous: QualityMetricsSnapshot | null,
  ): MetricSnapshot[] {
    if (!previous) return current

    return current.map((metric) => {
      const prevMetric = previous.metrics.find((m) => m.name === metric.name)
      if (!prevMetric) return metric

      const delta = metric.value - prevMetric.value
      let trend: MetricTrend = 'stable'
      if (delta > this.config.degradationThreshold * 0.5) trend = 'improving'
      else if (delta < -this.config.degradationThreshold * 0.5) trend = 'declining'

      // 对于特定指标，value 本身是倒置的（越高越好）
      // 所以 delta > 0 总是意味着改善
      const degraded = delta < -this.config.degradationThreshold

      return {
        ...metric,
        trend,
        delta: Math.round(delta * 1000) / 1000,
        degraded,
      }
    })
  }

  /**
   * 计算总体健康评分（0-100）。
   * 加权平均各指标，越低分越差。
   */
  private computeHealthScore(metrics: MetricSnapshot[]): number {
    if (metrics.length === 0) return 50 // 数据不足时的默认分

    // 权重配置：某些指标更重要
    const weights: Record<string, number> = {
      error_rate: 3,
      module_error_rate: 2,
      tool_success_rate: 2.5,
      pause_severity: 1.5,
      call_activity: 0.5,
      high_failure_tool_ratio: 1.5,
    }

    let totalWeight = 0
    let weightedSum = 0

    for (const m of metrics) {
      const w = weights[m.name] || 1
      totalWeight += w
      weightedSum += m.value * w
    }

    if (totalWeight === 0) return 50
    return (weightedSum / totalWeight) * 100
  }

  /**
   * 检测具体的降级信号。
   * 当健康评分下降且某些指标显著劣化时，生成优化目标。
   */
  private detectDegradation(
    current: MetricSnapshot[],
    previous: QualityMetricsSnapshot,
  ): DegradationSignal[] {
    const signals: DegradationSignal[] = []

    for (const metric of current) {
      if (!metric.degraded) continue

      const prevMetric = previous.metrics.find((m) => m.name === metric.name)
      if (!prevMetric) continue

      const delta = Math.abs(metric.delta)

      // 计算严重度：delta 超过阈值的程度 / 最大可能变化
      const severity = Math.min(delta / this.config.degradationThreshold / 2, 1)
      if (severity < this.config.severityThreshold) continue

      // 根据指标名称推断关联模块和优化类型
      const { suggestedType, target } = this.mapMetricToOptimization(metric)

      const relatedModules = metric.relatedModules
        ? metric.relatedModules.split(',').filter(Boolean)
        : []

      signals.push({
        id: `degradation_${metric.name}_${Date.now()}`,
        metricName: metric.name,
        currentValue: metric.value,
        previousValue: prevMetric.value,
        delta: metric.delta,
        severity: Math.round(severity * 100) / 100,
        relatedModules,
        suggestedOptimizationType: suggestedType,
        description: this.buildDegradationDescription(metric, prevMetric, severity),
        recommendedTarget: target,
      })
    }

    return signals
  }

  /**
   * 将质量指标映射到优化类型和相关目标模块。
   */
  private mapMetricToOptimization(metric: MetricSnapshot): {
    suggestedType: string
    target: string
  } {
    switch (metric.name) {
      case 'error_rate':
      case 'module_error_rate':
      case 'high_failure_tool_ratio':
        return {
          suggestedType: 'improve_error',
          target: metric.relatedModules?.split(',')[0] || 'agent_core',
        }
      case 'tool_success_rate':
        return {
          suggestedType: 'improve_error',
          target: metric.relatedModules?.split(',')[0] || 'agent_core',
        }
      case 'pause_severity':
        return {
          suggestedType: 'optimize_response',
          target: metric.relatedModules?.split(',')[0] || 'chat_executor',
        }
      case 'call_activity':
        return {
          suggestedType: 'preload_module',
          target: 'userBehaviorAnalyzer',
        }
      default:
        return { suggestedType: 'improve_error', target: 'agent_core' }
    }
  }

  /**
   * 构建降级描述文本，供 Evolution 消费。
   */
  private buildDegradationDescription(
    metric: MetricSnapshot,
    prevMetric: MetricSnapshot,
    severity: number,
  ): string {
    const change = metric.delta > 0 ? '改善' : '劣化'
    const pctChange = Math.abs(Math.round(metric.delta * 100))
    return (
      `【质量指标降级】${metric.description} ${change} ${pctChange}%（严重度: ${Math.round(severity * 100)}%）。` +
      `当前值: ${(metric.value * 100).toFixed(0)}%，` +
      `上一周期: ${(prevMetric.value * 100).toFixed(0)}%。` +
      (metric.relatedModules ? `关联模块: ${metric.relatedModules}` : '') +
      `建议优化类型: ${metric.name === 'pause_severity' ? '响应延迟优化' : '错误处理改进'}。`
    )
  }

  // ==================== 持久化 ====================

  private getStateFilePath(): string {
    if (this.config.stateFilePath) return this.config.stateFilePath
    // 默认路径
    try {
      // 尝试从 WORKSPACE 环境变量获取路径
      const baseDir = process.env.WORKSPACE_EVOLUTION || join(process.cwd(), '.evolution')
      return join(baseDir, 'quality_metrics.json')
    } catch {
      return join(process.cwd(), '.evolution', 'quality_metrics.json')
    }
  }

  private loadSnapshots(): void {
    try {
      const filePath = this.getStateFilePath()
      if (!existsSync(filePath)) return
      const data = readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(data)
      if (Array.isArray(parsed)) {
        this.snapshots = parsed
        log('INFO', 'quality_metrics_loaded', {
          snapshots: this.snapshots.length,
          latestHealth: this.getLatestSnapshot()?.healthScore,
        })
      }
    } catch (err: any) {
      log('WARN', 'quality_metrics_load_failed', { error: err.message })
      this.snapshots = []
    }
  }

  private persistSnapshots(): void {
    try {
      const filePath = this.getStateFilePath()
      const dir = dirname(filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(filePath, JSON.stringify(this.snapshots, null, 2), 'utf-8')
    } catch (err: any) {
      log('WARN', 'quality_metrics_persist_failed', { error: err.message })
    }
  }
}

// =============================================================================
// 全局单例
// =============================================================================

export const qualityMetricsTracker = new QualityMetricsTracker()
