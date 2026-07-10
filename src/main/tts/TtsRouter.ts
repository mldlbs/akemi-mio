/**
 * TtsRouter — 混合 TTS 智能路由
 *
 * 根据网络状况、质量/延迟需求、用户偏好，在云端 TTS (edge-tts) 和本地 PiperTTS 之间自动选择。
 *
 * 决策层次（优先级递减）：
 *   1. 用户显式偏好 (cloud/local) → 直接使用
 *   2. 网络不可用 → 本地 Piper（兜底）
 *   3. 网络延迟高 + 延迟权重 > 质量权重 → 本地 Piper
 *   4. 质量权重 > 延迟权重 + 网络良好 → 云端 edge-tts
 *   5. 默认：网络可用 → 云端，否则 → 本地
 *
 * 集成点：
 *   - TtsService._synthesize() → router.decide() 决定引擎
 *   - IPC handler → router.setUserPreference() 接收用户偏好
 *   - Settings UI → 已有 cloud/local 切换（需增加 auto 模式）
 *
 * 设计原则：
 *   - 偏好持久化：用户选择在会话内保持
 *   - 网络缓存：5 秒内复用检测结果
 *   - 零破坏性：不修改现有合成逻辑，只在引擎选择点插入
 */

import { log } from '../logger/Logger'
import { networkMonitor } from './NetworkMonitor'
import { shallowMerge } from '../core/utils/configMerge'
import type {
  TtsEngine,
  TtsUserPreference,
  TtsRoutingDecision,
  TtsRouterConfig,
  PiperPerformanceInfo,
} from './types'
import { DEFAULT_TTS_ROUTER_CONFIG } from './types'

export class TtsRouter {
  private config: TtsRouterConfig
  private userPreference: TtsUserPreference = 'auto'

  /** 最近的路由决策（供调试/UI 展示） */
  private lastDecision: TtsRoutingDecision | null = null

  /** Piper 本地引擎的近期性能信息（由 TtsPiperBridge 更新） */
  private piperPerformance: PiperPerformanceInfo | null = null

  constructor(config?: Partial<TtsRouterConfig>) {
    this.config = shallowMerge(DEFAULT_TTS_ROUTER_CONFIG, config)
  }

  // ── 用户偏好 ──

  /**
   * 设置用户 TTS 引擎偏好。
   * - 'auto': 自动路由（默认）
   * - 'cloud': 强制使用云端 TTS（edge-tts）
   * - 'local': 强制使用本地 TTS（Piper）
   */
  setUserPreference(pref: TtsUserPreference): void {
    const prev = this.userPreference
    this.userPreference = pref
    log('INFO', 'tts_router_preference_changed', { from: prev, to: pref })
  }

  /** 获取当前用户偏好 */
  getUserPreference(): TtsUserPreference {
    return this.userPreference
  }

  /** 获取配置 */
  getConfig(): TtsRouterConfig {
    return { ...this.config }
  }

  /** 更新配置 */
  updateConfig(partial: Partial<TtsRouterConfig>): void {
    this.config = { ...this.config, ...partial }
  }

  /**
   * 设置 Piper 本地引擎的近期性能信息。
   *
   * 由 TtsPiperBridge 在每次 Piper 合成后调用（通过 TtsService 传递），
   * 将 Piper 的实际运行数据注入路由决策，使路由器能感知本地引擎表现。
   *
   * 影响：Piper 高延迟 / 高失败率 / 队列深 → 倾向云端
   *       Piper 表现良好 → 更多使用本地
   */
  setPiperPerformance(info: PiperPerformanceInfo): void {
    this.piperPerformance = info
  }

  // ── 核心：路由决策 ──

  /**
   * 获取 Piper 性能对路由的倾向影响。
   * 返回 [0, 1] 的值，越高越倾向云端。
   */
  private getCloudBiasFromPiperPerformance(): number {
    const perf = this.piperPerformance
    if (!perf) return 0 // 无数据 → 无偏

    let cloudBias = 0

    // 最近合成延迟高 → 倾向云端
    if (perf.recentLatencyMs > 0) {
      // 延迟超过 5 秒 → 强云端倾向
      if (perf.recentLatencyMs > 5000) {
        cloudBias += 0.4
      } else if (perf.recentLatencyMs > 3000) {
        cloudBias += 0.2
      } else if (perf.recentLatencyMs > 1500) {
        cloudBias += 0.1
      }
    }

    // 有模型频繁失败 → 强云端倾向
    if (perf.anyModelFailed) {
      cloudBias += 0.3
    }

    // 队列深度大 → 云端分流
    if (perf.queueDepth > 5) {
      cloudBias += 0.15
    } else if (perf.queueDepth > 3) {
      cloudBias += 0.05
    }

    return Math.min(1, cloudBias)
  }

  /**
   * 决定使用哪个 TTS 引擎。
   *
   * @param options.qualityWeight 质量权重 0-1（越高越倾向云端，云端表现力更强）
   * @param options.latencyWeight 延迟权重 0-1（越高越倾向本地，本地延迟更低）
   * @param options.forceCheck 是否强制刷新网络检测
   */
  async decide(options?: {
    qualityWeight?: number
    latencyWeight?: number
    forceCheck?: boolean
  }): Promise<TtsRoutingDecision> {
    const qualityWeight = options?.qualityWeight ?? this.config.defaultQualityWeight
    const latencyWeight = options?.latencyWeight ?? this.config.defaultLatencyWeight

    // ── 第 1 层：用户显式偏好 ──
    if (this.userPreference === 'cloud') {
      return this.makeDecision('cloud', 'user_preference_cloud', -1, true, qualityWeight, latencyWeight)
    }
    if (this.userPreference === 'local') {
      return this.makeDecision('local', 'user_preference_local', -1, true, qualityWeight, latencyWeight)
    }

    // ── 第 2 层：Piper 性能感知（新增） ──
    // 如果 Piper 性能不佳（高延迟/高失败率），产生云端倾向
    const piperCloudBias = this.getCloudBiasFromPiperPerformance()
    if (piperCloudBias >= 0.4 && latencyWeight <= qualityWeight) {
      // Piper 性能差 + 用户不特别关注延迟 → 切云端
      log('INFO', 'tts_router_piper_perf_bias', {
        cloudBias: piperCloudBias.toFixed(2),
        piperRecentLatency: this.piperPerformance?.recentLatencyMs,
        piperQueueDepth: this.piperPerformance?.queueDepth,
        decision: 'cloud',
      })
      return this.makeDecision(
        'cloud',
        `piper_perf_bias_${piperCloudBias.toFixed(2)}`,
        -1,
        true,
        qualityWeight,
        latencyWeight,
      )
    }

    // ── 第 3 层：检测网络状态 ──
    const netStatus = options?.forceCheck
      ? await networkMonitor.refresh()
      : await networkMonitor.getStatus()

    // ── 第 4 层：网络不可用 → 本地兜底 ──
    if (!netStatus.available) {
      return this.makeDecision('local', 'network_unavailable', netStatus.latencyMs, false, qualityWeight, latencyWeight)
    }

    // ── 第 5 层：基于权重和网络质量决策 ──
    const latency = netStatus.latencyMs

    // 网络延迟很高 + 用户更关注延迟 → 本地
    if (latency > this.config.maxLatencyMs && latencyWeight > qualityWeight) {
      // 同样检查 Piper 性能
      if (piperCloudBias < 0.3) {
        return this.makeDecision(
          'local',
          `high_latency_${latency}ms_latency_weighted`,
          latency,
          true,
          qualityWeight,
          latencyWeight,
        )
      }
      // Piper 也不太好 → 还是去云端
      return this.makeDecision(
        'cloud',
        `high_latency_${latency}ms_but_piper_unhealthy`,
        latency,
        true,
        qualityWeight,
        latencyWeight,
      )
    }

    // 网络良好 + 质量权重更高 → 云端
    if (latency <= this.config.goodLatencyMs && qualityWeight >= latencyWeight) {
      return this.makeDecision(
        'cloud',
        `good_network_${latency}ms_quality_weighted`,
        latency,
        true,
        qualityWeight,
        latencyWeight,
      )
    }

    // ── 第 6 层：默认策略 ──
    if (qualityWeight >= latencyWeight) {
      return this.makeDecision(
        'cloud',
        `default_cloud_latency_${latency}ms`,
        latency,
        true,
        qualityWeight,
        latencyWeight,
      )
    } else {
      // 延迟权重更高时，如果网络延迟超过 goodLatencyMs，倾向本地
      if (latency > this.config.goodLatencyMs) {
        // 但检查 Piper 性能
        if (piperCloudBias < 0.3) {
          return this.makeDecision(
            'local',
            `default_local_latency_${latency}ms_latency_weighted`,
            latency,
            true,
            qualityWeight,
            latencyWeight,
          )
        }
        return this.makeDecision(
          'cloud',
          `default_cloud_latency_${latency}ms_piper_unhealthy`,
          latency,
          true,
          qualityWeight,
          latencyWeight,
        )
      }
      return this.makeDecision(
        'cloud',
        `default_cloud_latency_${latency}ms`,
        latency,
        true,
        qualityWeight,
        latencyWeight,
      )
    }
  }

  /**
   * 同步决策（使用缓存的网络状态，不发起新检测）。
   * 适用于需要快速决策的场景。
   */
  decideSync(options?: {
    qualityWeight?: number
    latencyWeight?: number
  }): TtsRoutingDecision {
    const qualityWeight = options?.qualityWeight ?? this.config.defaultQualityWeight
    const latencyWeight = options?.latencyWeight ?? this.config.defaultLatencyWeight

    // 用户偏好优先
    if (this.userPreference === 'cloud') {
      return this.makeDecision('cloud', 'user_preference_cloud', -1, true, qualityWeight, latencyWeight)
    }
    if (this.userPreference === 'local') {
      return this.makeDecision('local', 'user_preference_local', -1, true, qualityWeight, latencyWeight)
    }

    // ── Piper 性能感知 ──
    const piperCloudBias = this.getCloudBiasFromPiperPerformance()
    if (piperCloudBias >= 0.4 && latencyWeight <= qualityWeight) {
      return this.makeDecision(
        'cloud',
        `sync_piper_perf_bias_${piperCloudBias.toFixed(2)}`,
        -1,
        true,
        qualityWeight,
        latencyWeight,
      )
    }

    // 使用缓存状态
    const cached = networkMonitor.getCachedStatus()
    if (!cached || !cached.available) {
      // 无缓存或已知不可用 → 本地（但 Piper 性能差时仍需处理）
      if (piperCloudBias >= 0.4) {
        return this.makeDecision(
          'cloud',
          `no_network_but_piper_unhealthy`,
          cached?.latencyMs ?? -1,
          cached?.available ?? false,
          qualityWeight,
          latencyWeight,
        )
      }
      return this.makeDecision(
        'local',
        cached ? 'cached_unavailable' : 'no_cache',
        cached?.latencyMs ?? -1,
        cached?.available ?? false,
        qualityWeight,
        latencyWeight,
      )
    }

    const latency = cached.latencyMs
    if (latency > this.config.maxLatencyMs && latencyWeight > qualityWeight) {
      if (piperCloudBias < 0.3) {
        return this.makeDecision('local', `high_latency_${latency}ms`, latency, true, qualityWeight, latencyWeight)
      }
      return this.makeDecision('cloud', `high_latency_${latency}ms_piper_unhealthy`, latency, true, qualityWeight, latencyWeight)
    }

    if (qualityWeight >= latencyWeight) {
      return this.makeDecision('cloud', `default_cloud_${latency}ms`, latency, true, qualityWeight, latencyWeight)
    }

    // 延迟权重高 → 倾向本地
    if (piperCloudBias < 0.3 && latency > this.config.goodLatencyMs) {
      return this.makeDecision('local', `sync_decision_${latency}ms`, latency, true, qualityWeight, latencyWeight)
    }

    return this.makeDecision('cloud', `sync_cloud_${latency}ms_piper_bias_${piperCloudBias.toFixed(2)}`, latency, true, qualityWeight, latencyWeight)
  }

  /** 获取最近的决策（供调试） */
  getLastDecision(): TtsRoutingDecision | null {
    return this.lastDecision
  }

  // ── 私有 ──

  private makeDecision(
    engine: TtsEngine,
    reason: string,
    networkLatencyMs: number,
    networkAvailable: boolean,
    qualityWeight: number,
    latencyWeight: number,
  ): TtsRoutingDecision {
    const decision: TtsRoutingDecision = {
      engine,
      reason,
      networkLatencyMs,
      networkAvailable,
      qualityWeight,
      latencyWeight,
    }

    // 仅在引擎变化或有意义的原因时记录日志
    if (!this.lastDecision || this.lastDecision.engine !== engine) {
      log('INFO', 'tts_router_decision', {
        engine,
        reason,
        latencyMs: networkLatencyMs,
        qualityWeight: qualityWeight.toFixed(2),
        latencyWeight: latencyWeight.toFixed(2),
      })
    }

    this.lastDecision = decision
    return decision
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例，供 TtsService 使用 */
export const ttsRouter = new TtsRouter()
