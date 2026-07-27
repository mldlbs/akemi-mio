/**
 * TtsQualityOfServiceEvaluator — 服务质量评估器
 *
 * ── 职责 ──
 * 实时监测网络延迟和系统设备负载，提供统一的 QoS 分数，
 * 当质量低于预设阈值时触发引擎切换回调，确保语音输出的可靠性和低延迟。
 *
 * ── 监测维度 ──
 * 1. 网络延迟（ms）— 通过 NetworkMonitor 获取，判断云端 TTS 服务质量
 * 2. 系统 CPU 负载（%）— 通过 process.cpuUsage() 测量，判断本地 Piper 可用资源
 *
 * ── 阈值决策 ──
 * - 延迟 > highLatencyThresholdMs（默认 200ms）= 网络质量差 → 倾向本地
 * - CPU 负载 > highCpuThreshold（默认 80%）= 系统繁忙 → 倾向云端
 * - 综合 QoS 分数 = 融合两个维度，低于 minQosScore 触发切换
 *
 * ── 集成点 ──
 * - TtsService._synthesize() 中查询 QoS 状态辅助路由决策
 * - 注册 onSwitchRecommendation 回调实现自动引擎切换
 * - 系统托盘/TTS 设置 UI 查看实时 QoS 状态
 */

import { log } from '../logger/Logger'
import { networkMonitor } from './NetworkMonitor'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 设备负载快照 */
export interface DeviceLoadSnapshot {
  /** CPU 使用率 0–100（百分比） */
  cpuPercent: number
  /** 进程堆内存使用（MB） */
  heapUsedMB: number
  /** 采集时间戳 */
  timestamp: number
}

/** QoS 评估结果 */
export interface QosEvaluation {
  /** 综合服务质量分数 0–1（0=极差，1=极好） */
  score: number
  /** 网络延迟（ms），-1 表示不可用 */
  networkLatencyMs: number
  /** 网络是否可用 */
  networkAvailable: boolean
  /** 当前 CPU 负载百分比 0–100 */
  cpuLoadPercent: number
  /** 推荐的引擎 */
  recommendedEngine: 'cloud' | 'local'
  /** 推荐原因 */
  reason: string
  /** 评估时间戳 */
  timestamp: number
}

/** QoS 配置 */
export interface QosConfig {
  /** 网络延迟高阈值（ms）：超过此值视为网络差 */
  highLatencyThresholdMs: number
  /** CPU 负载高阈值（%）：超过此值视为系统繁忙 */
  highCpuThreshold: number
  /** 最低 QoS 分数：低于此值触发自动切换 */
  minQosScore: number
  /** 评估间隔（ms） */
  evaluationIntervalMs: number
  /** QoS 缓存 TTL（ms） */
  cacheTtlMs: number
  /** 是否启用自动切换 */
  autoSwitchEnabled: boolean
}

/** 引擎切换推荐 */
export interface SwitchRecommendation {
  /** 推荐切换到的引擎 */
  targetEngine: 'cloud' | 'local'
  /** 当前 QoS 分数 */
  currentScore: number
  /** 切换原因 */
  reason: string
  /** 是否紧急切换（需要立即执行） */
  urgent: boolean
}

/** 切换回调 */
export type SwitchCallback = (recommendation: SwitchRecommendation) => void

// ══════════════════════════════════════════
//  默认配置
// ══════════════════════════════════════════

export const DEFAULT_QOS_CONFIG: QosConfig = {
  highLatencyThresholdMs: 200,
  highCpuThreshold: 80,
  minQosScore: 0.4,
  evaluationIntervalMs: 5000,
  cacheTtlMs: 3000,
  autoSwitchEnabled: true,
}

// ══════════════════════════════════════════
//  设备负载监测器内部类
// ══════════════════════════════════════════

/**
 * 使用 process.cpuUsage() 测量 CPU 负载。
 * 通过两次采样之间的差值计算实际 CPU 占用率。
 */
class DeviceLoadMonitor {
  private lastCpuUsage: NodeJS.CpuUsage | null = null
  private lastTime: number = 0
  private cachedSnapshot: DeviceLoadSnapshot | null = null
  private cacheExpireAt: number = 0
  private cacheTtlMs: number

  constructor(cacheTtlMs: number = 3000) {
    this.cacheTtlMs = cacheTtlMs
  }

  /**
   * 获取当前设备负载快照。
   * 使用差分法计算 CPU 使用率，避免瞬时值波动。
   */
  getSnapshot(): DeviceLoadSnapshot {
    const now = Date.now()

    // 缓存有效时直接返回
    if (this.cachedSnapshot && now < this.cacheExpireAt) {
      return this.cachedSnapshot
    }

    const mem = process.memoryUsage()
    const currentCpu = process.cpuUsage()
    const currentTime = now

    let cpuPercent = 0

    if (this.lastCpuUsage && this.lastTime > 0) {
      const elapsedMicros = (currentTime - this.lastTime) * 1000
      if (elapsedMicros > 0) {
        const userDiff = currentCpu.user - this.lastCpuUsage.user
        const systemDiff = currentCpu.system - this.lastCpuUsage.system
        const totalDiff = userDiff + systemDiff
        // 限制最大值并归一化到单核百分比
        cpuPercent = Math.min(100, Math.round((totalDiff / elapsedMicros) * 100))
      }
    }

    // 更新基线用于下次计算
    this.lastCpuUsage = currentCpu
    this.lastTime = currentTime

    const snapshot: DeviceLoadSnapshot = {
      cpuPercent: Math.max(0, Math.min(100, cpuPercent)),
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      timestamp: now,
    }

    this.cachedSnapshot = snapshot
    this.cacheExpireAt = now + this.cacheTtlMs

    return snapshot
  }

  /** 清除缓存，迫使下次调用重新采集 */
  clearCache(): void {
    this.cachedSnapshot = null
    this.cacheExpireAt = 0
  }
}

// ══════════════════════════════════════════
//  TtsQualityOfServiceEvaluator
// ══════════════════════════════════════════

export class TtsQualityOfServiceEvaluator {
  private config: QosConfig
  private deviceMonitor: DeviceLoadMonitor
  private cachedEvaluation: QosEvaluation | null = null
  private cacheExpireAt: number = 0

  /** 切换回调列表 */
  private switchCallbacks: SwitchCallback[] = []

  /** 上次报告的引擎（用于检测变化） */
  private lastRecommendedEngine: 'cloud' | 'local' | null = null

  /** 评估定时器 */
  private evaluationTimer: ReturnType<typeof setInterval> | null = null

  /** 是否已启动 */
  private started = false

  constructor(config?: Partial<QosConfig>) {
    this.config = { ...DEFAULT_QOS_CONFIG, ...config }
    this.deviceMonitor = new DeviceLoadMonitor(this.config.cacheTtlMs)
  }

  // ══════════════════════════════════════════
  //  生命周期
  // ══════════════════════════════════════════

  /**
   * 启动 QoS 评估器。
   * 开启定时评估循环，自动检测服务质量变化。
   */
  start(): void {
    if (this.started) return
    this.started = true

    // 立即执行一次评估
    this.evaluate()

    // 定时评估
    if (this.config.evaluationIntervalMs > 0) {
      this.evaluationTimer = setInterval(() => {
        this.evaluate()
      }, this.config.evaluationIntervalMs)

      // 允许进程退出时不阻塞
      if (this.evaluationTimer && typeof this.evaluationTimer === 'object' && 'unref' in this.evaluationTimer) {
        this.evaluationTimer.unref()
      }
    }

    log('INFO', 'tts_qos_evaluator_started', {
      intervalMs: this.config.evaluationIntervalMs,
      highLatencyMs: this.config.highLatencyThresholdMs,
      highCpuPct: this.config.highCpuThreshold,
      minScore: this.config.minQosScore,
    })
  }

  /**
   * 停止 QoS 评估器。
   */
  stop(): void {
    if (!this.started) return
    this.started = false

    if (this.evaluationTimer) {
      clearInterval(this.evaluationTimer)
      this.evaluationTimer = null
    }

    this.cachedEvaluation = null
    this.lastRecommendedEngine = null
    log('INFO', 'tts_qos_evaluator_stopped')
  }

  /**
   * 是否正在运行。
   */
  isRunning(): boolean {
    return this.started
  }

  // ══════════════════════════════════════════
  //  回调管理
  // ══════════════════════════════════════════

  /**
   * 注册引擎切换推荐回调。
   * 回调在评估后发现需要切换引擎时触发。
   * 返回取消订阅函数。
   */
  onSwitchRecommendation(cb: SwitchCallback): () => void {
    this.switchCallbacks.push(cb)
    return () => {
      const idx = this.switchCallbacks.indexOf(cb)
      if (idx >= 0) this.switchCallbacks.splice(idx, 1)
    }
  }

  // ══════════════════════════════════════════
  //  配置
  // ══════════════════════════════════════════

  /** 获取当前配置 */
  getConfig(): QosConfig {
    return { ...this.config }
  }

  /** 更新配置 */
  updateConfig(partial: Partial<QosConfig>): void {
    const prevAutoSwitch = this.config.autoSwitchEnabled
    this.config = { ...this.config, ...partial }
    this.deviceMonitor.clearCache()

    log('INFO', 'tts_qos_config_updated', { ...this.config })

    // 如果 autoSwitch 状态变化，重新评估
    if (prevAutoSwitch !== this.config.autoSwitchEnabled) {
      this.evaluate()
    }
  }

  /** 启用/禁用自动切换 */
  setAutoSwitchEnabled(enabled: boolean): void {
    this.updateConfig({ autoSwitchEnabled: enabled })
  }

  // ══════════════════════════════════════════
  //  核心评估
  // ══════════════════════════════════════════

  /**
   * 执行一次 QoS 评估。
   *
   * 评估维度：
   *   1. 网络延迟 → 网络质量分数（0-1）
   *   2. CPU 负载 → 系统资源分数（0-1）
   *   3. 综合分数 = 融合两个维度（加权平均）
   *
   * 切换决策：
   *   - 网络差（延迟 > 高阈值）→ 倾向本地 Piper
   *   - CPU 高（负载 > 高阈值）→ 倾向云端 edge-tts
   *   - 综合分数 < minQosScore → 触发切换推荐
   *
   * 对同一个推荐引擎不重复触发回调（防抖），
   * 仅在引擎变化时通知监听器。
   */
  evaluate(): QosEvaluation {
    // ── 采集网络状态（使用缓存） ──
    const netStatus = networkMonitor.getCachedStatus()
    const networkAvailable = netStatus?.available ?? false
    const networkLatencyMs = netStatus?.latencyMs ?? -1

    // ── 采集设备负载 ──
    const loadSnapshot = this.deviceMonitor.getSnapshot()

    // ── 计算各维度分数（0-1，越高越好） ──
    // 网络分数：延迟越低分越高
    const networkScore = networkAvailable
      ? Math.max(0, 1 - (Math.max(0, networkLatencyMs) / this.config.highLatencyThresholdMs) * 1.5)
      : 0

    // CPU 分数：负载越低分越高
    const cpuScore = Math.max(0, 1 - (loadSnapshot.cpuPercent / this.config.highCpuThreshold) * 1.2)

    // ── 综合 QoS 分数 ──
    // 如果网络不可用，综合分数主要由 CPU 决定（倾向本地）
    // 如果 CPU 极高，综合分数主要由网络决定（倾向云端）
    const qosScore = networkAvailable
      ? networkScore * 0.5 + cpuScore * 0.5
      : cpuScore * 0.8 + 0.1  // 网络不可用时降低基准

    // ── 引擎推荐 ──
    const isNetworkBad = networkAvailable && networkLatencyMs > this.config.highLatencyThresholdMs
    const isNetworkUnavailable = !networkAvailable
    const isCpuHigh = loadSnapshot.cpuPercent > this.config.highCpuThreshold

    let recommendedEngine: 'cloud' | 'local'
    let reason: string

    if (isNetworkUnavailable) {
      recommendedEngine = 'local'
      reason = `network_unavailable_cpu_${loadSnapshot.cpuPercent}%`
    } else if (isNetworkBad && !isCpuHigh) {
      // 网络差但 CPU 正常 → 本地优先
      recommendedEngine = 'local'
      reason = `high_latency_${networkLatencyMs}ms_cpu_${loadSnapshot.cpuPercent}%`
    } else if (isCpuHigh && networkAvailable) {
      // CPU 高但网络正常 → 云端优先（将计算卸载到远端）
      recommendedEngine = 'cloud'
      reason = `high_cpu_${loadSnapshot.cpuPercent}%_latency_${networkLatencyMs}ms`
    } else if (networkScore >= 0.7 && cpuScore >= 0.7) {
      // 两者都好 → 云端（高质量）
      recommendedEngine = 'cloud'
      reason = `good_qos_score_${qosScore.toFixed(2)}`
    } else if (networkScore < cpuScore) {
      // 网络比 CPU 差 → 本地
      recommendedEngine = 'local'
      reason = `network_worse_than_cpu_${networkScore.toFixed(2)}_vs_${cpuScore.toFixed(2)}`
    } else {
      // 默认：网络可用 → 云端
      recommendedEngine = 'cloud'
      reason = `default_qos_score_${qosScore.toFixed(2)}`
    }

    const evaluation: QosEvaluation = {
      score: Math.max(0, Math.min(1, qosScore)),
      networkLatencyMs,
      networkAvailable,
      cpuLoadPercent: loadSnapshot.cpuPercent,
      recommendedEngine,
      reason,
      timestamp: Date.now(),
    }

    this.cachedEvaluation = evaluation
    this.cacheExpireAt = Date.now() + this.config.cacheTtlMs

    // ── 触发切换检测 ──
    this.detectAndNotify(evaluation)

    return evaluation
  }

  /**
   * 获取缓存的 QoS 评估结果（不触发新评估）。
   * 如果缓存过期则返回 null。
   */
  getCachedEvaluation(): QosEvaluation | null {
    if (this.cachedEvaluation && Date.now() < this.cacheExpireAt) {
      return this.cachedEvaluation
    }
    return null
  }

  /**
   * 获取综合 QoS 分数（快捷方法）。
   * 返回 0-1 分数，或 null（无缓存数据）。
   */
  getScore(): number | null {
    const cached = this.getCachedEvaluation()
    return cached?.score ?? null
  }

  /** 强制刷新 QoS 评估 */
  forceRefresh(): QosEvaluation {
    this.deviceMonitor.clearCache()
    return this.evaluate()
  }

  // ══════════════════════════════════════════
  //  内部方法
  // ══════════════════════════════════════════

  /**
   * 检测引擎推荐是否发生变化，并通知回调。
   * 防抖：仅在推荐引擎变化时触发，避免高频重复通知。
   */
  private detectAndNotify(evaluation: QosEvaluation): void {
    if (!this.config.autoSwitchEnabled) return

    const currentEngine = evaluation.recommendedEngine

    // 首次评估仅记录，不触发切换
    if (this.lastRecommendedEngine === null) {
      this.lastRecommendedEngine = currentEngine
      return
    }

    // 引擎未变化 → 不通知
    if (this.lastRecommendedEngine === currentEngine) return

    // 评估分数高于最低阈值且不是紧急情况 → 不通知
    const isUrgent = evaluation.score < this.config.minQosScore
    if (!isUrgent) return

    const recommendation: SwitchRecommendation = {
      targetEngine: currentEngine,
      currentScore: evaluation.score,
      reason: evaluation.reason,
      urgent: evaluation.score < this.config.minQosScore * 0.5, // 半阈值为紧急
    }

    this.lastRecommendedEngine = currentEngine

    log('INFO', 'tts_qos_switch_recommendation', {
      from: this.lastRecommendedEngine === 'cloud' ? 'local' : 'cloud', // 因为刚更新
      to: currentEngine,
      score: evaluation.score.toFixed(2),
      reason: evaluation.reason,
      urgent: recommendation.urgent,
    })

    for (const cb of this.switchCallbacks) {
      try {
        cb(recommendation)
      } catch (err) {
        log('WARN', 'tts_qos_switch_callback_error', { error: String(err) })
      }
    }
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例，供 TtsService 使用 */
export const ttsQosEvaluator = new TtsQualityOfServiceEvaluator()
