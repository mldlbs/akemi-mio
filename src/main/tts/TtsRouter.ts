/**
 * TtsRouter — 混合 TTS 智能路由
 *
 * 根据网络状况、质量/延迟需求、用户偏好，在云端 TTS (edge-ts) 和本地 PiperTTS 之间自动选择。
 *
 * 决策层次（优先级递减）：
 *   1. 用户显式偏好 (cloud/local) → 直接使用
 *   2. 网络不可用 → 本地 Piper（兜底）
 *   3. 情感强度低 + 文本短 → 本地 Piper（低情感短句用本地快速响应）
 *   4. RTT > rttPiperThresholdMs（默认 100ms）且低情感短句 → 本地 Piper
 *   5. 网络延迟高 + 延迟权重 > 质量权重 → 本地 Piper
 *   6. 质量权重 > 延迟权重 + 网络良好 → 云端 edge-tts
 *   7. 默认：网络可用 → 云端，否则 → 本地
 *
 * 情感+长度感知（新增）：
 *   - emotionStrength: 文本情感得分绝对值 0-1（从 SentimentAnalyzer 获得）
 *   - textLength: 文本单词/词数
 *   - 当 emotionStrength < minEmotionForCloud 且 textLength < maxShortTextWords 时，
 *     即使网络状况良好也倾向本地 Piper，保证短促日常用语的低延迟响应
 *   - 高情感文本（emotionStrength >= minEmotionForCloud）优先云端以获得情感表现力
 *
 * 集成点：
 *   - TtsService._synthesize() → router.decide() 决定引擎
 *   - TtsScheduler → 在路由前分析情感强度和文本长度
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
   * 决策层次（优先级递减）：
   *   1. 用户显式偏好 → 直接使用
   *   2. Piper 性能感知 → 性能差时倾向云端
   *   3. 情感强度低 + 文本短 → 本地 Piper（低情感短句无需云端表现力）
   *   4. RTT > rttPiperThresholdMs + 低情感短文本 → 本地 Piper（网络延迟高时本地优先）
   *   5. 网络不可用 → 本地兜底
   *   6. 网络延迟高 + 延迟权重 > 质量权重 → 本地 Piper
   *   7. 质量权重 > 延迟权重 + 网络良好 → 云端 edge-tts
   *   8. 默认策略
   *
   * @param options.qualityWeight 质量权重 0-1（越高越倾向云端）
   * @param options.latencyWeight 延迟权重 0-1（越高越倾向本地）
   * @param options.forceCheck 是否强制刷新网络检测
   * @param options.emotionStrength 文本情感强度绝对值 0-1（由 SentimentAnalyzer 提供）
   * @param options.textLength 文本长度（词数）
   */
  async decide(options?: {
    qualityWeight?: number
    latencyWeight?: number
    forceCheck?: boolean
    emotionStrength?: number
    textLength?: number
  }): Promise<TtsRoutingDecision> {
    const qualityWeight = options?.qualityWeight ?? this.config.defaultQualityWeight
    const latencyWeight = options?.latencyWeight ?? this.config.defaultLatencyWeight
    const emotionStrength = options?.emotionStrength
    const textLength = options?.textLength

    // ── 第 1 层：用户显式偏好 ──
    if (this.userPreference === 'cloud') {
      return this.makeDecision('cloud', 'user_preference_cloud', -1, true, qualityWeight, latencyWeight, emotionStrength, textLength)
    }
    if (this.userPreference === 'local') {
      return this.makeDecision('local', 'user_preference_local', -1, true, qualityWeight, latencyWeight, emotionStrength, textLength)
    }

    // ── 第 2 层：Piper 性能感知 ──
    const piperCloudBias = this.getCloudBiasFromPiperPerformance()
    if (piperCloudBias >= 0.4 && latencyWeight <= qualityWeight) {
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
        emotionStrength,
        textLength,
      )
    }

    // ── 第 3 层：情感强度 + 文本长度感知 ──
    const isLowEmotion = emotionStrength !== undefined && emotionStrength < this.config.minEmotionForCloud
    const isShortText = textLength !== undefined && textLength < this.config.maxShortTextWords
    const isLowEmotionShortText = isLowEmotion && isShortText

    // 情感强度低 + 文本短 → 本地 Piper（即使网络良好）
    // 这些低情感短句（如"好的""再见"）用本地引擎避免网络延迟
    if (isLowEmotionShortText) {
      log('INFO', 'tts_router_emotion_length', {
        emotionStrength,
        textLength,
        minEmotion: this.config.minEmotionForCloud,
        maxShortText: this.config.maxShortTextWords,
        decision: 'local',
      })
      return this.makeDecision(
        'local',
        `low_emotion_${emotionStrength?.toFixed(2)}_short_text_${textLength}`,
        -1,
        true,
        qualityWeight,
        latencyWeight,
        emotionStrength,
        textLength,
      )
    }

    // ── 第 4 层：检测网络状态 ──
    const netStatus = options?.forceCheck
      ? await networkMonitor.refresh()
      : await networkMonitor.getStatus()

    // ── 第 5 层：网络不可用 → 本地兜底 ──
    if (!netStatus.available) {
      return this.makeDecision('local', 'network_unavailable', netStatus.latencyMs, false, qualityWeight, latencyWeight, emotionStrength, textLength)
    }

    // ── 第 6 层：RTT 阈值检测 ──
    // RTT > rttPiperThresholdMs（默认 100ms）且是低情感短文本 → 本地 Piper
    if (netStatus.latencyMs > this.config.rttPiperThresholdMs && isLowEmotionShortText) {
      return this.makeDecision(
        'local',
        `rtt_${netStatus.latencyMs}ms_exceeds_${this.config.rttPiperThresholdMs}_low_emotion_short_text`,
        netStatus.latencyMs,
        true,
        qualityWeight,
        latencyWeight,
        emotionStrength,
        textLength,
      )
    }

    // ── 第 7 层：基于权重和网络质量决策 ──
    const latency = netStatus.latencyMs

    // 网络延迟很高 + 用户更关注延迟 → 本地
    if (latency > this.config.maxLatencyMs && latencyWeight > qualityWeight) {
      if (piperCloudBias < 0.3) {
        return this.makeDecision(
          'local',
          `high_latency_${latency}ms_latency_weighted`,
          latency,
          true,
          qualityWeight,
          latencyWeight,
          emotionStrength,
          textLength,
        )
      }
      return this.makeDecision(
        'cloud',
        `high_latency_${latency}ms_but_piper_unhealthy`,
        latency,
        true,
        qualityWeight,
        latencyWeight,
        emotionStrength,
        textLength,
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
        emotionStrength,
        textLength,
      )
    }

    // ── 第 8 层：默认策略 ──
    if (qualityWeight >= latencyWeight) {
      return this.makeDecision(
        'cloud',
        `default_cloud_latency_${latency}ms`,
        latency,
        true,
        qualityWeight,
        latencyWeight,
        emotionStrength,
        textLength,
      )
    } else {
      if (latency > this.config.goodLatencyMs) {
        if (piperCloudBias < 0.3) {
          return this.makeDecision(
            'local',
            `default_local_latency_${latency}ms_latency_weighted`,
            latency,
            true,
            qualityWeight,
            latencyWeight,
            emotionStrength,
            textLength,
          )
        }
        return this.makeDecision(
          'cloud',
          `default_cloud_latency_${latency}ms_piper_unhealthy`,
          latency,
          true,
          qualityWeight,
          latencyWeight,
          emotionStrength,
          textLength,
        )
      }
      return this.makeDecision(
        'cloud',
        `default_cloud_latency_${latency}ms`,
        latency,
        true,
        qualityWeight,
        latencyWeight,
        emotionStrength,
        textLength,
      )
    }
  }

  /**
   * 同步决策（使用缓存的网络状态，不发起新检测）。
   * 适用于需要快速决策的场景，例如 TtsService._synthesize()。
   *
   * @param options.emotionStrength 文本情感强度绝对值 0-1
   * @param options.textLength 文本长度（词数）
   */
  decideSync(options?: {
    qualityWeight?: number
    latencyWeight?: number
    emotionStrength?: number
    textLength?: number
  }): TtsRoutingDecision {
    const qualityWeight = options?.qualityWeight ?? this.config.defaultQualityWeight
    const latencyWeight = options?.latencyWeight ?? this.config.defaultLatencyWeight
    const emotionStrength = options?.emotionStrength
    const textLength = options?.textLength

    // 用户偏好优先
    if (this.userPreference === 'cloud') {
      return this.makeDecision('cloud', 'user_preference_cloud', -1, true, qualityWeight, latencyWeight, emotionStrength, textLength)
    }
    if (this.userPreference === 'local') {
      return this.makeDecision('local', 'user_preference_local', -1, true, qualityWeight, latencyWeight, emotionStrength, textLength)
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
        emotionStrength,
        textLength,
      )
    }

    // ── 情感 + 长度感知 ──
    const isLowEmotion = emotionStrength !== undefined && emotionStrength < this.config.minEmotionForCloud
    const isShortText = textLength !== undefined && textLength < this.config.maxShortTextWords
    const isLowEmotionShortText = isLowEmotion && isShortText

    if (isLowEmotionShortText) {
      return this.makeDecision(
        'local',
        `sync_low_emotion_${emotionStrength?.toFixed(2)}_short_text_${textLength}`,
        -1,
        true,
        qualityWeight,
        latencyWeight,
        emotionStrength,
        textLength,
      )
    }

    // ── 使用缓存网络状态 ──
    const cached = networkMonitor.getCachedStatus()

    // RTT > rttPiperThresholdMs + 低情感短文本 → Piper
    if (cached && cached.available && cached.latencyMs > this.config.rttPiperThresholdMs && isLowEmotionShortText) {
      return this.makeDecision(
        'local',
        `sync_rtt_${cached.latencyMs}ms_exceeds_${this.config.rttPiperThresholdMs}_low_emotion`,
        cached.latencyMs,
        true,
        qualityWeight,
        latencyWeight,
        emotionStrength,
        textLength,
      )
    }

    if (!cached || !cached.available) {
      if (piperCloudBias >= 0.4) {
        return this.makeDecision(
          'cloud',
          `no_network_but_piper_unhealthy`,
          cached?.latencyMs ?? -1,
          cached?.available ?? false,
          qualityWeight,
          latencyWeight,
          emotionStrength,
          textLength,
        )
      }
      return this.makeDecision(
        'local',
        cached ? 'cached_unavailable' : 'no_cache',
        cached?.latencyMs ?? -1,
        cached?.available ?? false,
        qualityWeight,
        latencyWeight,
        emotionStrength,
        textLength,
      )
    }

    const latency = cached.latencyMs
    if (latency > this.config.maxLatencyMs && latencyWeight > qualityWeight) {
      if (piperCloudBias < 0.3) {
        return this.makeDecision('local', `high_latency_${latency}ms`, latency, true, qualityWeight, latencyWeight, emotionStrength, textLength)
      }
      return this.makeDecision('cloud', `high_latency_${latency}ms_piper_unhealthy`, latency, true, qualityWeight, latencyWeight, emotionStrength, textLength)
    }

    if (qualityWeight >= latencyWeight) {
      return this.makeDecision('cloud', `default_cloud_${latency}ms`, latency, true, qualityWeight, latencyWeight, emotionStrength, textLength)
    }

    if (piperCloudBias < 0.3 && latency > this.config.goodLatencyMs) {
      return this.makeDecision('local', `sync_decision_${latency}ms`, latency, true, qualityWeight, latencyWeight, emotionStrength, textLength)
    }

    return this.makeDecision('cloud', `sync_cloud_${latency}ms_piper_bias_${piperCloudBias.toFixed(2)}`, latency, true, qualityWeight, latencyWeight, emotionStrength, textLength)
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
    emotionStrength?: number,
    textLength?: number,
  ): TtsRoutingDecision {
    const decision: TtsRoutingDecision = {
      engine,
      reason,
      networkLatencyMs,
      networkAvailable,
      qualityWeight,
      latencyWeight,
      emotionStrength,
      textLength,
    }

    // 仅在引擎变化或有意义的原因时记录日志
    if (!this.lastDecision || this.lastDecision.engine !== engine || this.lastDecision.reason !== reason) {
      log('INFO', 'tts_router_decision', {
        engine,
        reason,
        latencyMs: networkLatencyMs,
        qualityWeight: qualityWeight.toFixed(2),
        latencyWeight: latencyWeight.toFixed(2),
        emotionStrength: emotionStrength?.toFixed(2),
        textLength,
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
