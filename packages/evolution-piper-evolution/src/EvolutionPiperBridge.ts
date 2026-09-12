/**
 * EvolutionPiperBridge — Evolution × PiperTTS 深度融合桥梁
 *
 * ── 架构角色 ──
 *
 * 将「Evolution（自进化系统）」和「PiperTTS（本地语音引擎）」的核心能力
 * 通过统一接口层合并，实现双向往来的融合架构。
 *
 * 1. Evolution → Piper 状态管道：
 *    SelfEvolutionService 的状态变化（调度状态、安全模式、冷却期、失败计数）
 *    通过桥接器同步到 PiperOrchestrator，使 Piper 的模型选择和行为调整
 *    能感知 Evolution 的全局状态。
 *
 * 2. Piper → Evolution 反馈管道：
 *    PiperOrchestrator 的合成输出（模型性能、延迟、回退事件、队列状态）
 *    通过桥接器反馈到 Evolution 管道，作为 Evolution 新的输入维度，
 *    驱动 Piper 配置优化和性能问题的自动修复。
 *
 * 3. 涌现效果：
 *    - Evolution 进入 COOLDOWN → Piper 减速/使用保守模型（降低故障风险）
 *    - Evolution 设置为 review 模式 → Piper 使用更可靠的模型（避免实验性模型）
 *    - Evolution ANALYZING 期间 → Piper 降低优先级（避免干扰分析过程）
 *    - Piper 连续失败 → Evolution 自动创建优化任务
 *    - Piper 队列积压 → Evolution 调整管道指标 / 触发健康检查
 *
 * ── 风险控制 ──
 * 桥接器仅传递数据，不创建循环依赖。Evolution → Piper 是单向状态同步，
 * Piper → Evolution 是单向事件反馈，两条路径独立运行，不会产生无限循环。
 * 两个模块的独立演进不受影响。
 *
 * ── 与 TtsPiperBridge 的关系 ──
 * TtsPiperBridge 处理 TTS 系统 ↔ Piper 的实时双向数据流（毫秒级），
 * 本桥接器处理 Evolution 系统 ↔ Piper 的状态数据流（秒/分钟级）。
 * 两个桥接器职责互补、互不重叠。
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import { piperOrchestrator } from '@akemi-mio/audio/PiperOrchestrator'
import { ttsPiperBridge } from '@akemi-mio/audio/TtsPiperBridge'
import type { PiperSynthesisStats } from '@akemi-mio/audio/PiperOrchestrator'
import type {
  EvolutionToPiperState,
  PiperToEvolutionFeedback,
  EvolutionPiperSharedContext,
  EvolutionPiperBridgeConfig,
  PiperModelPerformanceSnapshot,
  PiperProblemDescriptor,
} from './types'
import { DEFAULT_EVOLUTION_PIPER_BRIDGE_CONFIG } from './types'

// ════════════════════════════════════════════
//  默认状态值
// ════════════════════════════════════════════

function createDefaultEvolutionState(): EvolutionToPiperState {
  return {
    schedulerState: 'idle',
    safetyMode: 'auto',
    executeFailures: 0,
    inCooldown: false,
    cooldownRemainingMs: 0,
    userActive: false,
    lastRunAt: 0,
    pipelineQueueSize: 0,
    timestamp: Date.now(),
  }
}

function createDefaultPiperFeedback(): PiperToEvolutionFeedback {
  return {
    models: [],
    queueDepth: 0,
    isProcessing: false,
    currentModel: '',
    anyModelFailed: false,
    recentAvgLatencyMs: -1,
    totalRequests: 0,
    totalSuccess: 0,
    totalFailure: 0,
    timestamp: Date.now(),
  }
}

// ════════════════════════════════════════════
//  EvolutionPiperBridge
// ════════════════════════════════════════════

export class EvolutionPiperBridge {
  /** 共享上下文 */
  private context: EvolutionPiperSharedContext = {
    evolutionState: null,
    piperFeedback: null,
    version: 0,
  }

  /** 桥接器配置 */
  private config: EvolutionPiperBridgeConfig = { ...DEFAULT_EVOLUTION_PIPER_BRIDGE_CONFIG }

  /** 上次采集 Piper 反馈的时间 */
  private lastFeedbackCollection = 0

  /** 上次同步 Evolution 状态的时间 */
  private lastStateSync = 0

  /** 上下文变更回调 */
  private onContextChange: ((ctx: Readonly<EvolutionPiperSharedContext>) => void) | null = null

  // ════════════════════════════════════════
  //  方向一：Evolution → Piper
  // ════════════════════════════════════════

  /**
   * 同步 Evolution 状态到桥接器。
   *
   * 由 SelfEvolutionService 在以下时机调用：
   * - 调度状态变更（IDLE → ANALYZING → COOLDOWN）
   * - 安全模式切换
   * - 失败计数更新
   * - 冷却期开始/结束
   *
   * 该方法受最小同步间隔限制，防止高频写入。
   */
  syncEvolutionState(state: EvolutionToPiperState): void {
    const now = Date.now()
    if (now - this.lastStateSync < this.config.stateSyncMinIntervalMs) {
      return
    }

    this.lastStateSync = now
    this.context.evolutionState = { ...state, timestamp: now }
    this.context.version++
    this.notifyContextChange()

    // 通过 EventBus 广播 Evolution 状态变更，供其他消费者（如 TtsService）监听
    eventBus.emit('evolution.piper.state.synced', {
      state: this.context.evolutionState,
      version: this.context.version,
    })

    log('DEBUG', 'evolution_piper_state_synced', {
      schedulerState: state.schedulerState,
      safetyMode: state.safetyMode,
      inCooldown: state.inCooldown,
      failures: state.executeFailures,
      userActive: state.userActive,
      queueSize: state.pipelineQueueSize,
    })
  }

  /**
   * 获取 Evolution 对 PiperTTS 的当前行为建议。
   *
   * PiperOrchestrator 据此调整模型选择、语速、队列行为。
   */
  getEvolutionInfluence(): {
    /** 建议的模型选择倾向：'conservative' | 'normal' | 'expressive' */
    modelPreference: 'conservative' | 'normal' | 'expressive'
    /** 建议的语速调整因子（1.0 = 不变） */
    speedFactor: number
    /** 建议的最大队列深度（0 = 不限制） */
    maxQueueDepth: number
    /** 是否建议临时暂停合成 */
    pauseSuggested: boolean
  } {
    const state = this.context.evolutionState
    if (!state) {
      return { modelPreference: 'normal', speedFactor: 1.0, maxQueueDepth: 0, pauseSuggested: false }
    }

    let modelPreference: 'conservative' | 'normal' | 'expressive' = 'normal'
    let speedFactor = 1.0
    let maxQueueDepth = 0
    let pauseSuggested = false

    // ── 安全模式影响 ──
    if (state.safetyMode === 'review') {
      // review 模式：使用保守模型，避免实验性配置
      modelPreference = 'conservative'
      speedFactor *= 0.95 // 稍慢，更清晰
      maxQueueDepth = maxQueueDepth === 0 ? 15 : Math.min(maxQueueDepth, 15)
    }

    // ── 调度状态影响 ──
    switch (state.schedulerState) {
      case 'analyzing':
        // 分析中：降低 Piper 优先级，避免干扰
        speedFactor *= 0.9
        maxQueueDepth = maxQueueDepth === 0 ? 10 : Math.min(maxQueueDepth, 10)
        break
      case 'cooldown':
        // 冷却中：保守模式，降低故障风险
        modelPreference = modelPreference === 'normal' ? 'conservative' : modelPreference
        speedFactor *= 0.85
        maxQueueDepth = maxQueueDepth === 0 ? 8 : Math.min(maxQueueDepth, 8)
        if (state.inCooldown && state.executeFailures >= 3) {
          pauseSuggested = true
        }
        break
      case 'idle':
      default:
        // 空闲：正常模式
        break
    }

    // ── 失败次数影响 ──
    if (state.executeFailures >= 3) {
      modelPreference = 'conservative'
      speedFactor *= 0.9
    }

    // ── 用户活跃影响 ──
    if (state.userActive) {
      // 用户活跃时保持正常响应
      speedFactor = Math.max(speedFactor, 0.9)
    }

    // ── 冷却影响 ──
    if (state.inCooldown) {
      speedFactor *= 0.9
      pauseSuggested = pauseSuggested || state.executeFailures >= 2
    }

    return { modelPreference, speedFactor: Math.round(speedFactor * 100) / 100, maxQueueDepth, pauseSuggested }
  }

  // ════════════════════════════════════════
  //  方向二：Piper → Evolution
  // ════════════════════════════════════════

  /**
   * 采集 Piper 反馈数据。
   *
   * 从 PiperOrchestrator 和 TtsPiperBridge 读取当前状态，
   * 构建结构化反馈供 Evolution 管道消费。
   */
  collectPiperFeedback(): PiperToEvolutionFeedback {
    const now = Date.now()
    if (now - this.lastFeedbackCollection < this.config.feedbackMinIntervalMs) {
      // 返回缓存
      return this.context.piperFeedback ?? createDefaultPiperFeedback()
    }

    this.lastFeedbackCollection = now

    // 从 PiperOrchestrator 采集合成统计
    const stats: PiperSynthesisStats = piperOrchestrator.getSynthesisStats()
    const queueStatus = piperOrchestrator.getQueueStatus()

    // 从 TtsPiperBridge 采集模型性能快照
    const bridgeFeedback = ttsPiperBridge.getPiperFeedback()

    // 构建各模型性能快照
    const models: PiperModelPerformanceSnapshot[] = Object.entries(stats.perModel).map(([modelName, stat]) => {
      const bridgeStat = bridgeFeedback.models[modelName]
      const failureCount = stat.totalRequests - stat.successCount
      const recentSuccessRate = bridgeStat
        ? bridgeStat.totalSyntheses >= 10
          ? bridgeStat.successCount / bridgeStat.totalSyntheses
          : -1
        : -1

      return {
        model: modelName,
        totalSyntheses: stat.totalRequests,
        successCount: stat.successCount,
        failureCount,
        avgLatencyMs: stat.avgLatencyMs,
        fallbackCount: bridgeStat?.fallbackCount ?? 0,
        recentSuccessRate,
      }
    })

    const feedback: PiperToEvolutionFeedback = {
      models,
      queueDepth: queueStatus.queueSize,
      isProcessing: queueStatus.isProcessing,
      currentModel: queueStatus.currentModel,
      anyModelFailed: bridgeFeedback.anyModelFailed,
      recentAvgLatencyMs: bridgeFeedback.recentLatencyMs,
      totalRequests: stats.total.requests,
      totalSuccess: stats.total.success,
      totalFailure: stats.total.failure,
      timestamp: now,
    }

    this.context.piperFeedback = feedback
    this.context.version++
    this.notifyContextChange()

    log('DEBUG', 'evolution_piper_feedback_collected', {
      models: models.length,
      totalRequests: feedback.totalRequests,
      totalFailure: feedback.totalFailure,
      queueDepth: feedback.queueDepth,
      anyFailed: feedback.anyModelFailed,
    })

    return feedback
  }

  /**
   * 获取应报告的 Piper 性能问题列表。
   *
   * 供 PiperEvolutionPlugin 使用，将 Piper 的性能退化
   * 转换为 Evolution 管道可消费的优化问题。
   */
  detectProblems(): PiperProblemDescriptor[] {
    if (!this.config.autoProblemGeneration) return []

    const feedback = this.collectPiperFeedback()
    const problems: PiperProblemDescriptor[] = []

    // ── 检查各模型的失败率 ──
    for (const model of feedback.models) {
      const failureRate = model.totalSyntheses > 0 ? model.failureCount / model.totalSyntheses : 0
      if (failureRate > this.config.modelFailureThreshold && model.totalSyntheses >= 5) {
        problems.push({
          category: 'model_failure_rate',
          model: model.model,
          currentValue: failureRate,
          threshold: this.config.modelFailureThreshold,
          detail: `Piper 模型 "${model.model}" 失败率 ${(failureRate * 100).toFixed(1)}%（阈值 ${(this.config.modelFailureThreshold * 100).toFixed(0)}%），共 ${model.totalSyntheses} 次合成`,
        })
      }

      // ── 检查模型回退 ──
      if (model.fallbackCount >= 3 && model.totalSyntheses >= 5) {
        problems.push({
          category: 'fallback_chain',
          model: model.model,
          currentValue: model.fallbackCount,
          threshold: 3,
          detail: `Piper 模型 "${model.model}" 触发 ${model.fallbackCount} 次回退，建议检查模型文件完整性`,
        })
      }
    }

    // ── 检查整体延迟 ──
    if (feedback.recentAvgLatencyMs > this.config.latencyThresholdMs && feedback.totalRequests >= 3) {
      problems.push({
        category: 'high_latency',
        currentValue: feedback.recentAvgLatencyMs,
        threshold: this.config.latencyThresholdMs,
        detail: `Piper 平均延迟 ${feedback.recentAvgLatencyMs}ms（阈值 ${this.config.latencyThresholdMs}ms），建议检查系统资源或切换模型`,
      })
    }

    // ── 检查队列深度 ──
    if (feedback.queueDepth > this.config.queueDepthThreshold) {
      problems.push({
        category: 'queue_overload',
        currentValue: feedback.queueDepth,
        threshold: this.config.queueDepthThreshold,
        detail: `Piper 队列深度 ${feedback.queueDepth}（阈值 ${this.config.queueDepthThreshold}），建议优化合成频率或增加并发`,
      })
    }

    // ── 检查整体退化趋势 ──
    if (feedback.totalRequests >= 10) {
      const overallFailureRate = feedback.totalFailure / feedback.totalRequests
      if (overallFailureRate > this.config.modelFailureThreshold) {
        problems.push({
          category: 'degradation',
          currentValue: overallFailureRate,
          threshold: this.config.modelFailureThreshold,
          detail: `Piper 整体合成失败率 ${(overallFailureRate * 100).toFixed(1)}%（阈值 ${(this.config.modelFailureThreshold * 100).toFixed(0)}%），共 ${feedback.totalRequests} 次合成`,
        })
      }
    }

    return problems
  }

  // ════════════════════════════════════════
  //  查询接口
  // ════════════════════════════════════════

  /** 获取当前共享上下文的只读快照 */
  getContext(): Readonly<EvolutionPiperSharedContext> {
    return Object.freeze({ ...this.context })
  }

  /** 获取当前桥接器配置 */
  getConfig(): Readonly<EvolutionPiperBridgeConfig> {
    return Object.freeze({ ...this.config })
  }

  /** 更新桥接器配置 */
  updateConfig(partial: Partial<EvolutionPiperBridgeConfig>): void {
    this.config = { ...this.config, ...partial }
    log('INFO', 'evolution_piper_bridge_config_updated', {
      autoProblemGeneration: this.config.autoProblemGeneration,
      modelFailureThreshold: this.config.modelFailureThreshold,
    })
  }

  /** 重置所有状态和统计 */
  reset(): void {
    this.context = { evolutionState: null, piperFeedback: null, version: 0 }
    this.lastFeedbackCollection = 0
    this.lastStateSync = 0
    this.notifyContextChange()
    log('INFO', 'evolution_piper_bridge_reset')
  }

  /** 注册上下文变更回调 */
  setOnContextChange(cb: ((ctx: Readonly<EvolutionPiperSharedContext>) => void) | null): void {
    this.onContextChange = cb
  }

  private notifyContextChange(): void {
    this.onContextChange?.(Object.freeze({ ...this.context }))
  }
}

// ════════════════════════════════════════════
//  单例
// ════════════════════════════════════════════

/** 全局单例，供 SelfEvolutionService、PiperEvolutionPlugin 共享 */
export const evolutionPiperBridge = new EvolutionPiperBridge()
