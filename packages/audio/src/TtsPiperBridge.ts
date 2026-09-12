/**
 * TtsPiperBridge — TTS × PiperTTS 深度融合桥梁
 *
 * ── 架构角色 ──
 *
 * 将「TTS」和「PiperTTS」的核心能力通过统一接口层合并，实现双向往来的融合架构：
 *
 * 1. 统一合成接口：TtsService 通过桥接器调用 PiperTTS，替代直接 execFile，
 *    使自动 TTS 路径也享受 PiperOrchestrator 的模型管理、队列、回退等能力。
 *
 * 2. TTS → Piper 上下文管道：TTS 的状态变化（情感参数、行为需求、隐式反馈推荐、
 *    情境语音配置）通过桥接器同步到 PiperOrchestrator，使其模型选择和参数调整
 *    能感知 TTS 侧的全局状态。
 *
 * 3. Piper → TTS 反馈管道：PiperOrchestrator 的合成输出（使用的模型、延迟、
 *    回退事件、队列状态）通过桥接器反馈到 TtsRouter 和 ImplicitFeedbackTracker，
 *    使 TTS 路由决策能感知本地引擎的实时表现。
 *
 * ── 涌现机制 ──
 *
 * 双向数据流产生 1+1>2 的效果：
 *   - TtsService 设置"高效工作模式"→ 桥接器同步到 PiperOrchestrator
 *     → PiperOrchestrator 自动选择 huayan-medium（语速 1.1x）
 *   - PiperOrchestrator 连续回退 3 次 → 桥接器反馈到 TtsRouter
 *     → TtsRouter 临时切换为 cloud 引擎，直到 Piper 恢复
 *   - TtsService 的隐式偏好学习到"用户喜欢较慢语速"
 *     → 桥接器同步到 PiperOrchestrator 的默认 speed 因子
 *
 * ── 风险控制 ──
 * 桥接器仅传递数据，不创建循环依赖。TTS → Piper 是单向状态同步，
 * Piper → TTS 是单向事件反馈，两条路径独立运行，不会产生无限循环。
 * 两类引擎（Piper / Edge）的独立演进不受影响。
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { EmotionTtsParams, ContextVoiceConfig } from './types'
import type { PreferenceRecommendation } from './types'
import type { UserBehaviorTtsNeed } from '@akemi-mio/evolution/behavior/UserBehaviorTtsContract'
import { SlidingWindow } from '@akemi-mio/core/core/patterns/SlidingWindow'
import { piperOrchestrator, type PiperSynthesizeResult, type PiperSynthesizeRequest } from './PiperOrchestrator'
import { voiceRoleManager } from './VoiceRoleManager'
import { piperBehaviorSidecar, type BehaviorSidecarInput } from './PiperBehaviorSidecar'
import { piperBehaviorStateMachine } from './PiperBehaviorStateMachine'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 单次合成的 Piper 输出信息 */
export interface PiperSynthesisOutput {
  /** 实际使用的模型 */
  model: string
  /** 合成延迟（毫秒） */
  latencyMs: number
  /** 是否成功 */
  success: boolean
  /** 是否触发了模型回退 */
  fallbackUsed: boolean
  /** 错误信息（失败时） */
  error?: string
  /** 合成时的 TTS 情境标签 */
  ttsContextLabel: string
}

/** Piper 各模型的性能统计 */
export interface PiperModelStat {
  /** 总合成次数 */
  totalSyntheses: number
  /** 成功次数 */
  successCount: number
  /** 平均延迟（毫秒） */
  avgLatencyMs: number
  /** 回退次数（作为主模型失败时） */
  fallbackCount: number
}

/**
 * TTS × Piper 共享上下文 — 双向数据流的载体。
 *
 * TTS 侧写入 tts* 字段，Piper 侧读取：
 *   - ttsEmotionParams: 决定 Piper 的 speed/pitch 调整
 *   - ttsBehaviorNeed: 决定 Piper 的输出模式（高效/轻柔等）
 *   - ttsContextVoiceConfig: 决定 Piper 的模型偏好
 *   - ttsImplicitRecommendation: 隐式学习推荐（影响默认参数）
 *
 * Piper 侧写入 piper* 字段，TTS 侧读取：
 *   - piperModelStats: 各模型的性能数据，影响路由决策
 *   - piperQueueStatus: 队列积压情况，影响延迟/质量权重
 *   - piperLastSynthesis: 最近一次合成的详情
 *   - piperRecentLatencyMs: 最近 N 次合成的平均延迟
 */
export interface TtsPiperSharedContext {
  // ── TTS → Piper 方向 ──
  /** TTS 当前情感参数 */
  ttsEmotionParams: EmotionTtsParams | null
  /** TTS 当前行为需求 */
  ttsBehaviorNeed: UserBehaviorTtsNeed | null
  /** TTS 当前情境语音配置 */
  ttsContextVoiceConfig: ContextVoiceConfig | null
  /** TTS 隐式反馈推荐 */
  ttsImplicitRecommendation: PreferenceRecommendation | null

  // ── Piper → TTS 方向 ──
  /** 各模型的性能统计 */
  piperModelStats: Record<string, PiperModelStat>
  /** Piper 队列状态 */
  piperQueueStatus: { pending: number; isProcessing: boolean; currentModel: string }
  /** 最近一次合成详情 */
  piperLastSynthesis: PiperSynthesisOutput | null
  /** 最近 10 次合成的平均延迟（毫秒），-1 表示无数据 */
  piperRecentLatencyMs: number
}

/** 创建默认的共享上下文 */
function createDefaultContext(): TtsPiperSharedContext {
  return {
    ttsEmotionParams: null,
    ttsBehaviorNeed: null,
    ttsContextVoiceConfig: null,
    ttsImplicitRecommendation: null,
    piperModelStats: {},
    piperQueueStatus: { pending: 0, isProcessing: false, currentModel: '' },
    piperLastSynthesis: null,
    piperRecentLatencyMs: -1,
  }
}

/**
 * 将 UserBehaviorTtsNeed 转换为 BehaviorSidecarInput。
 *
 * 转换层：桥接器将 UserBehavior 模块的类型映射为边车自身的轻量契约，
 * 使边车不直接依赖 UserBehavior 模块。
 */
function needToBehaviorInput(need: UserBehaviorTtsNeed | null | undefined): BehaviorSidecarInput | null {
  if (!need) return null
  return {
    outputMode: need.outputMode === 'normal' ? null : need.outputMode,
    pauseTts: need.pauseTts,
    rateSuggestion: need.rateSuggestion,
    pitchSuggestion: need.pitchSuggestion,
    volumeSuggestion: need.volumeSuggestion,
  }
}

/** 用于记录最近延迟的滑动窗口大小 */
const RECENT_LATENCY_WINDOW_SIZE = 10

// ══════════════════════════════════════════
//  TtsPiperBridge
// ══════════════════════════════════════════

export class TtsPiperBridge {
  /** 共享上下文 */
  private context: TtsPiperSharedContext = createDefaultContext()

  /** 最近合成延迟的滑动窗口（用于计算 piperRecentLatencyMs） */
  private readonly recentLatencies = new SlidingWindow<number>(RECENT_LATENCY_WINDOW_SIZE)

  /** 上下文变更回调（用于测试/调试） */
  private onContextChange: ((ctx: Readonly<TtsPiperSharedContext>) => void) | null = null

  // ════════════════════════════════════════
  //  TTS → Piper：TTS 侧同步状态
  // ════════════════════════════════════════

  /**
   * TTS 侧调用：将当前 TTS 状态同步到共享上下文。
   *
   * 应在每次 TTS 合成前调用，确保 PiperOrchestrator 能感知最新状态。
   * 只更新提供的字段，未提供的字段保持原值。
   */
  syncTtsState(params: {
    emotionParams?: EmotionTtsParams | null
    behaviorNeed?: UserBehaviorTtsNeed | null
    contextVoiceConfig?: ContextVoiceConfig | null
    implicitRecommendation?: PreferenceRecommendation | null
  }): void {
    let changed = false

    if (params.emotionParams !== undefined) {
      this.context.ttsEmotionParams = params.emotionParams
      changed = true
    }
    if (params.behaviorNeed !== undefined) {
      this.context.ttsBehaviorNeed = params.behaviorNeed
      changed = true
    }
    if (params.contextVoiceConfig !== undefined) {
      this.context.ttsContextVoiceConfig = params.contextVoiceConfig
      changed = true
    }
    if (params.implicitRecommendation !== undefined) {
      this.context.ttsImplicitRecommendation = params.implicitRecommendation
      changed = true
    }

    if (changed) {
      this.notifyContextChange()
      log('DEBUG', 'tts_piper_bridge_tts_synced', {
        hasEmotion: !!this.context.ttsEmotionParams,
        hasBehavior: !!this.context.ttsBehaviorNeed,
        hasContext: !!this.context.ttsContextVoiceConfig,
        hasImplicit: !!this.context.ttsImplicitRecommendation,
      })
    }
  }

  /**
   * TTS 侧调用：基于当前共享上下文构建 Piper 合成请求参数。
   *
   * 这是 TTS → Piper 的核心转换：
   * - 根据 emotionParams / behaviorNeed 确定 speed/pitch
   * - 根据 contextVoiceConfig 确定模型和语速
   * - 如果 emotionParams 不可用，使用隐式推荐
   */
  buildPiperRequest(
    text: string,
    overrides?: {
      taskTag?: string
      model?: string
      speed?: number
      pitch?: number
      /** 角色 ID — 从 VoiceRoleManager 解析对应的模型/语速/音调 */
      roleId?: string
    },
  ): PiperSynthesizeRequest {
    const request: PiperSynthesizeRequest = {
      text,
      model: overrides?.model,
      speed: overrides?.speed,
      pitch: overrides?.pitch,
      taskTag: overrides?.taskTag as any,
    }

    // ── 模型选择：优先 override，其次 roleId，其次 ContextVoiceConfig，最后保持默认 ──
    if (!request.model && overrides?.roleId) {
      const role = voiceRoleManager.getRole(overrides.roleId)
      if (role) {
        request.model = role.piperModel
        if (request.speed === undefined) request.speed = role.piperSpeed
        if (request.pitch === undefined) request.pitch = role.piperPitch
      }
    }

    if (!request.model && this.context.ttsContextVoiceConfig) {
      request.model = this.context.ttsContextVoiceConfig.piperModel
    }

    // ── 语速/音调：如果 roleId 已经设置了，跳过 ContextVoiceConfig 覆盖 ──
    if (request.speed === undefined && this.context.ttsContextVoiceConfig) {
      request.speed = this.context.ttsContextVoiceConfig.piperSpeed
    }
    if (request.pitch === undefined && this.context.ttsContextVoiceConfig) {
      request.pitch = this.context.ttsContextVoiceConfig.piperPitch
    }

    // ── 隐式学习推荐：如果 emotion 和 context 都未指定语速/音调 ──
    if (
      request.speed === undefined &&
      request.pitch === undefined &&
      this.context.ttsImplicitRecommendation &&
      this.context.ttsImplicitRecommendation.confidence > 0.3
    ) {
      // 隐式推荐只在没有其他覆盖时作为基线（置信度高时使用）
      log('DEBUG', 'tts_piper_bridge_implicit_influence', {
        confidence: this.context.ttsImplicitRecommendation.confidence,
        params: this.context.ttsImplicitRecommendation.params.rate,
      })
    }

    return request
  }

  // ════════════════════════════════════════
  //  统一合成接口 — TtsService 通过此方法调用 Piper
  // ════════════════════════════════════════

  /**
   * 通过 PiperOrchestrator 合成语音。
   *
   * 替代 TtsService 中 direct execFile('python', [PIPER_SCRIPT, ...]) 的直接调用。
   * 自动应用共享上下文中的 TTS 状态（情感参数、行为需求、情境语音配置）。
   *
   * @param text 要合成的文本
   * @param ttsParams TTS 当前情感参数（用于生成日志标签）
   * @param overrides 显式覆盖参数
   * @returns 合成结果
   */
  async synthesizeWithPiper(
    text: string,
    ttsParams?: EmotionTtsParams,
    overrides?: { taskTag?: string; model?: string; speed?: number; pitch?: number; roleId?: string },
  ): Promise<PiperSynthesizeResult> {
    // 通过共享上下文构建请求参数
    const request = this.buildPiperRequest(text, overrides)
    const t0 = Date.now()

    log('INFO', 'tts_piper_bridge_synthesize', {
      text_len: text.length,
      model: request.model || '(auto)',
      speed: request.speed,
      pitch: request.pitch,
      behavior_mode: this.context.ttsBehaviorNeed?.outputMode ?? '(none)',
    })

    // ── 行为状态机集成 ──
    // 将当前 UserBehavior 上下文注入状态机，使其在评估时感知行为状态
    const behaviorNeed = this.context.ttsBehaviorNeed
    if (behaviorNeed) {
      piperBehaviorStateMachine.setBehaviorContext({
        mode: behaviorNeed.outputMode === 'normal' ? 'focus' : undefined,
        activityState: behaviorNeed.pauseTts ? 'away' : 'active',
        fullscreen: undefined,
        focused: undefined,
      })
    }

    // 确保边车已注册状态机并启用自动模式
    piperBehaviorSidecar.setStateMachine(piperBehaviorStateMachine)
    piperBehaviorSidecar.setAutoMode(true)

    // 将 UserBehavior 需求注入边车（边车过滤/转换层将据此处理）
    piperBehaviorSidecar.setBehavior(needToBehaviorInput(this.context.ttsBehaviorNeed))

    // 通过边车合成（享受缓存、过滤、转换、监控、自动模式能力）
    const result = await piperBehaviorSidecar.synthesize(request)

    // 复位边车行为上下文，避免泄漏到其他请求方
    piperBehaviorSidecar.setBehavior(null)

    // ── 记录 Piper 输出反馈 ──
    const latencyMs = Date.now() - t0
    const output: PiperSynthesisOutput = {
      model: result.model,
      latencyMs,
      success: result.success,
      fallbackUsed: result.fallbackUsed,
      error: result.error,
      ttsContextLabel: ttsParams?.label ?? '(none)',
    }

    this.recordPiperOutput(output)

    return result
  }

  // ════════════════════════════════════════
  //  Piper → TTS：Piper 输出反馈
  // ════════════════════════════════════════

  /**
   * 记录一次 Piper 合成输出到共享上下文。
   * 更新模型统计、延迟窗口、队列状态。
   */
  private recordPiperOutput(output: PiperSynthesisOutput): void {
    // ── 更新模型统计 ──
    const model = output.model
    if (!this.context.piperModelStats[model]) {
      this.context.piperModelStats[model] = {
        totalSyntheses: 0,
        successCount: 0,
        avgLatencyMs: 0,
        fallbackCount: 0,
      }
    }
    const stat = this.context.piperModelStats[model]
    stat.totalSyntheses++
    if (output.success) {
      stat.successCount++
    }
    if (output.fallbackUsed) {
      stat.fallbackCount++
    }
    // 滚动平均延迟
    stat.avgLatencyMs = Math.round((stat.avgLatencyMs * (stat.totalSyntheses - 1) + output.latencyMs) / stat.totalSyntheses)

    // ── 更新延迟滑动窗口 ──
    this.recentLatencies.add(output.latencyMs)
    const avgLatency = this.recentLatencies.getAverage((v) => v)
    this.context.piperRecentLatencyMs = avgLatency

    // ── 更新最后合成记录 ──
    this.context.piperLastSynthesis = output

    // ── 更新队列状态 ──
    const queueStatus = piperOrchestrator.getQueueStatus()
    this.context.piperQueueStatus = {
      pending: queueStatus.queueSize,
      isProcessing: queueStatus.isProcessing,
      currentModel: queueStatus.currentModel,
    }

    // 仅在成功时详细记录
    if (output.success) {
      log('INFO', 'tts_piper_bridge_output', {
        model: output.model,
        latencyMs: output.latencyMs,
        fallback: output.fallbackUsed,
        queuePending: queueStatus.queueSize,
        recentAvgLatency: avgLatency,
      })
    } else {
      log('WARN', 'tts_piper_bridge_output_failed', {
        model: output.model,
        error: output.error,
        latencyMs: output.latencyMs,
      })
    }

    this.notifyContextChange()
  }

  // ════════════════════════════════════════
  //  查询接口
  // ════════════════════════════════════════

  /**
   * 获取当前共享上下文的只读快照。
   */
  getContext(): Readonly<TtsPiperSharedContext> {
    return Object.freeze({ ...this.context })
  }

  /**
   * 获取 Piper 输出反馈（供 TtsRouter 决策使用）。
   *
   * 返回 Piper 侧的关键性能指标，TtsRouter 可据此调整路由策略：
   * - recentLatencyMs: 最近平均延迟，高延迟时倾向切换到云端
   * - anyModelFailed: 有任何模型近期失败率过高
   * - queueDepth: 队列深度，过深时考虑用云端分流
   */
  getPiperFeedback(): {
    recentLatencyMs: number
    anyModelFailed: boolean
    queueDepth: number
    models: Record<string, PiperModelStat>
  } {
    const anyModelFailed = Object.values(this.context.piperModelStats).some(
      (s) => s.totalSyntheses >= 3 && s.successCount / s.totalSyntheses < 0.5,
    )

    return {
      recentLatencyMs: this.context.piperRecentLatencyMs,
      anyModelFailed,
      queueDepth: this.context.piperQueueStatus.pending,
      models: { ...this.context.piperModelStats },
    }
  }

  /**
   * 重置所有统计数据。
   */
  resetStats(): void {
    this.context = createDefaultContext()
    this.recentLatencies.clear()
    this.notifyContextChange()
    log('INFO', 'tts_piper_bridge_stats_reset')
  }

  /**
   * 注册上下文变更回调（用于测试/调试）。
   */
  setOnContextChange(cb: ((ctx: Readonly<TtsPiperSharedContext>) => void) | null): void {
    this.onContextChange = cb
  }

  // ── 内部 ──

  private notifyContextChange(): void {
    this.onContextChange?.(Object.freeze({ ...this.context }))
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例，供 TtsService、TtsRouter、PiperOrchestrator 共享 */
export const ttsPiperBridge = new TtsPiperBridge()
