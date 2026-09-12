/**
 * QoSEvaluator — 服务质量评估器
 *
 * 综合网络延迟（NetworkMonitor）和设备负载（DeviceLoadMonitor），
 * 输出一个 0–1 的 QoS 评分，用于指导 TTS 引擎路由决策。
 *
 * 评分逻辑：
 *   1. 网络评分：基于延迟，使用分段线性变换
 *      延迟 <= thresholdMs → 1.0
 *      thresholdMs < 延迟 < maxMs → 线性下降
 *      延迟 >= maxMs → 0.0
 *      网络不可用 → 0.0
 *   2. 设备评分：基于 CPU 和内存使用率，取两者的最小值
 *      CPU <= threshold% → 1.0
 *      CPU >= max% → 0.0
 *      之间线性下降
 *      同理对内存（取两者中较差的）
 *   3. 综合评分：networkScore * 0.6 + deviceScore * 0.4
 *
 * 根据综合评分自动推荐引擎：
 *   - score >= 0.5: 推荐云端（网络+设备均正常）
 *   - score < 0.5: 推荐本地（延迟高或负载重）
 *   - score < 0.3: 强制本地（QoS 极差）
 *
 * 设计特点：
 *   - 无阻塞：所有数据来自缓存（NetworkMonitor 的缓存 + DeviceLoadMonitor 的轮询）
 *   - 低开销：不主动发起网络检测，全依赖缓存的网络状态
 *   - 可配置：所有阈值可通过 config 参数调整
 *   - 容错：任一组件故障不影响整体（降级到该分量默认值）
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { networkMonitor } from './NetworkMonitor'
import { deviceLoadMonitor } from './DeviceLoadMonitor'
import { shallowMerge } from '@akemi-mio/core/core/utils/configMerge'
import type { DeviceLoadInfo, QoSScore, QoSEvaluatorConfig } from './types'
import { DEFAULT_QOS_EVALUATOR_CONFIG } from './types'

export class QoSEvaluator {
  private config: QoSEvaluatorConfig

  /** 最近一次的 QoS 评分（供调试/UI 展示） */
  private lastScore: QoSScore | null = null

  constructor(config?: Partial<QoSEvaluatorConfig>) {
    this.config = shallowMerge(DEFAULT_QOS_EVALUATOR_CONFIG, config)

    // 启动设备负载监测
    deviceLoadMonitor.start()
  }

  /**
   * 更新配置。
   */
  updateConfig(partial: Partial<QoSEvaluatorConfig>): void {
    this.config = { ...this.config, ...partial }
    if (partial.monitorIntervalMs) {
      deviceLoadMonitor.setInterval(partial.monitorIntervalMs)
    }
    log('INFO', 'qos_evaluator_config_updated', { ...this.config })
  }

  /**
   * 获取当前配置。
   */
  getConfig(): QoSEvaluatorConfig {
    return { ...this.config }
  }

  /**
   * 获取最近一次的 QoS 评分。
   */
  getLastScore(): QoSScore | null {
    return this.lastScore
  }

  /**
   * 同步评估当前 QoS 并返回评分。
   *
   * 使用缓存的网络状态和最新的设备负载数据，不发起任何新的检测请求。
   * 适合 TTS 合成前的路由决策。
   */
  evaluateSync(): QoSScore {
    if (!this.config.enabled) {
      // 禁用时返回满分
      const now = Date.now()
      const score: QoSScore = {
        score: 1.0,
        networkScore: 1.0,
        deviceScore: 1.0,
        networkLatencyMs: -1,
        deviceLoad: { cpuPercent: 0, memoryPercent: 0, timestamp: now },
        recommendedEngine: 'cloud',
        degradationReason: '',
        timestamp: now,
      }
      this.lastScore = score
      return score
    }

    const now = Date.now()

    // ── 1. 网络评分（使用缓存） ──
    const cachedNetwork = networkMonitor.getCachedStatus()
    const networkScore = cachedNetwork ? this.calculateNetworkScore(cachedNetwork.latencyMs) : 0.5 // 无缓存时取保守值 0.5
    const networkLatencyMs = cachedNetwork?.latencyMs ?? -1

    // ── 2. 设备负载评分（使用缓存，不发起新采集） ──
    const deviceLoad = deviceLoadMonitor.getCachedLoad() ?? { cpuPercent: 0, memoryPercent: 0, timestamp: now }
    const deviceScore = this.calculateDeviceScore(deviceLoad)

    // ── 3. 综合评分 ──
    const rawScore = networkScore * 0.6 + deviceScore * 0.4
    const score = Math.max(0, Math.min(1, rawScore))

    // ── 4. 引擎推荐 + 降级原因 ──
    let recommendedEngine: 'cloud' | 'local'
    let degradationReason = ''

    if (score < this.config.forceLocalThreshold) {
      recommendedEngine = 'local'
      const reasons: string[] = []
      if (networkScore < 0.3) reasons.push(`网络延迟高(${networkLatencyMs}ms)`)
      if (deviceLoad.cpuPercent >= this.config.cpuThresholdPercent) reasons.push(`CPU负载高(${deviceLoad.cpuPercent}%)`)
      if (deviceLoad.memoryPercent >= this.config.memoryThresholdPercent) reasons.push(`内存占用高(${deviceLoad.memoryPercent}%)`)
      degradationReason = reasons.length > 0 ? `QoS强制本地: ${reasons.join(', ')}` : 'QoS评分过低'
    } else if (score < this.config.recommendLocalThreshold) {
      recommendedEngine = 'local'
      degradationReason = `QoS推荐本地(${score.toFixed(2)})`
    } else {
      recommendedEngine = 'cloud'
    }

    const result: QoSScore = {
      score,
      networkScore,
      deviceScore,
      networkLatencyMs,
      deviceLoad,
      recommendedEngine,
      degradationReason,
      timestamp: now,
    }

    this.lastScore = result
    return result
  }

  /**
   * 异步评估：如果缓存的网络状态过期，先刷新再评估。
   *
   * 适用于需要最新网络状态的场景（如用户主动查询 QoS）。
   */
  async evaluate(): Promise<QoSScore> {
    // 刷新网络状态
    await networkMonitor.refresh()
    return this.evaluateSync()
  }

  /**
   * 获取 QoS 是否允许使用云端引擎。
   * 便捷方法，供 TtsRouter 快速决策。
   */
  canUseCloud(): boolean {
    const score = this.evaluateSync()
    return score.recommendedEngine === 'cloud'
  }

  /**
   * 获取 QoS 原始评分值。
   * 便捷方法。
   */
  getScore(): number {
    return this.evaluateSync().score
  }

  /**
   * 检查当前是否应当使用本地引擎。
   * 由 TtsRouter 调用，作为路由决策的前置条件。
   */
  shouldUseLocal(): boolean {
    const score = this.evaluateSync()
    return score.recommendedEngine === 'local'
  }

  /**
   * 检查当前是否强制使用本地引擎（QoS 极差时）。
   * 由 TtsRouter 调用，作为最高优先级的路由条件。
   */
  shouldForceLocal(): boolean {
    const score = this.evaluateSync()
    return score.score < this.config.forceLocalThreshold
  }

  // ── 私有 ──

  /**
   * 计算网络延迟评分。
   *
   * 分段线性变换：
   *   延迟 <= thresholdMs → 1.0
   *   thresholdMs < 延迟 < maxMs → 线性下降
   *   延迟 >= maxMs → 0.0
   *   延迟 = -1（不可用） → 0.0
   */
  private calculateNetworkScore(latencyMs: number): number {
    if (latencyMs < 0) return 0.0
    if (latencyMs <= this.config.networkLatencyThresholdMs) return 1.0
    if (latencyMs >= this.config.networkLatencyMaxMs) return 0.0

    // 线性插值
    const range = this.config.networkLatencyMaxMs - this.config.networkLatencyThresholdMs
    const offset = latencyMs - this.config.networkLatencyThresholdMs
    return Math.max(0, 1.0 - offset / range)
  }

  /**
   * 计算设备负载评分。
   *
   * CPU 和内存分别计算评分，取两者的最小值（最差维度决定整体）。
   *
   * 对每个指标：
   *   load <= threshold% → 1.0
   *   threshold% < load < max% → 线性下降
   *   load >= max% → 0.0
   */
  private calculateDeviceScore(load: DeviceLoadInfo): number {
    const cpuScore = this.calculateMetricScore(load.cpuPercent, this.config.cpuThresholdPercent, this.config.cpuMaxPercent)
    const memScore = this.calculateMetricScore(load.memoryPercent, this.config.memoryThresholdPercent, this.config.memoryMaxPercent)

    // 取两者中较差的
    return Math.min(cpuScore, memScore)
  }

  /**
   * 计算单一指标的评分。
   */
  private calculateMetricScore(current: number, threshold: number, maxVal: number): number {
    // 首次采样 CPU 为 -1，视为正常
    if (current < 0) return 1.0
    if (current <= threshold) return 1.0
    if (current >= maxVal) return 0.0

    const range = maxVal - threshold
    const offset = current - threshold
    return Math.max(0, 1.0 - offset / range)
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例，供 TtsService 使用 */
export const qosEvaluator = new QoSEvaluator()
