/**
 * ImplicitFeedbackTracker — 隐式反馈驱动的语音自适应跟踪器
 *
 * 职责：
 *   1. 在 TTS 输出时注入钩子，记录输出参数（音色/语速/语调）
 *   2. 采集用户后续行为（重听/跳过/继续对话/修改指令等）
 *   3. 将行为映射为隐式反馈分数，传递到 VoicePreferenceModel
 *   4. 提供回调注册机制，方便 TtsService 在输出时通知
 *
 * 集成点：
 *   - TtsService.speak() / speakInternal() → tracker.onTtsOutput()
 *   - 渲染进程用户界面（重听/停止按钮）→ IPC → tracker.onUserAction()
 *   - ChatExecutor toolLoop → 检测"继续对话"和"修改指令"模式
 *
 * 用户行为检测策略：
 *   REPLAY              — 用户主动点击重听按钮（渲染进程触发 IPC）
 *   SKIP                — 用户点击停止/跳过（渲染进程触发 IPC）
 *   INTERRUPT_SPEECH    — VAD 检测到用户打断 TTS 说话（VoiceInput 已实现）
 *   CONTINUE_CONVERSATION — 用户发送新消息（ChatExecutor.run 检测）
 *   MODIFY_REQUEST      — 用户新消息与上条消息相似（UserBehaviorAnalyzer 检测）
 *   COMPLETED_NATURALLY — TTS 播放自然结束（TtsService 播放完成回调）
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { EmotionTtsParams, ImplicitFeedbackAction } from './types'
import { voicePreferenceModel } from './VoicePreferenceModel'
import type { PreferenceRecommendation } from './types'

// ══════════════════════════════════════════
//  ImplicitFeedbackTracker
// ══════════════════════════════════════════

export class ImplicitFeedbackTracker {
  /** 最近一次 TTS 输出的 outputId（用于便捷反馈） */
  private lastOutputId: string | null = null

  /** 是否启用 */
  private enabled = true

  /** 当前待确认的输出（播放中但尚未结束）的 outputId */
  private activeOutputId: string | null = null

  /** 当前待确认的输出开始时间 */
  private activeOutputStartTime = 0

  /** 标记：是否已记录 COMPLETED_NATURALLY（避免重复触发） */
  private completedRecorded = false

  // ── 生命周期 ──

  /** 启用/禁用隐式反馈跟踪 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      this.lastOutputId = null
      this.activeOutputId = null
    }
    log('INFO', 'implicit_feedback_tracker_enabled', { enabled })
  }

  isEnabled(): boolean {
    return this.enabled
  }

  // ── TTS 输出钩子 ──

  /**
   * 在 TTS 输出开始时调用。
   * 记录本次 TTS 的参数并创建一条新的跟踪记录。
   */
  onTtsOutput(params: EmotionTtsParams, textSnippet: string): string {
    if (!this.enabled) return ''

    const outputId = voicePreferenceModel.recordOutput(params, textSnippet)
    this.lastOutputId = outputId
    this.activeOutputId = outputId
    this.activeOutputStartTime = Date.now()
    this.completedRecorded = false

    return outputId
  }

  /**
   * 在 TTS 播放自然结束时调用。
   * 如果用户没有打断/跳过，记录 COMPLETED_NATURALLY。
   */
  onTtsCompleted(): void {
    if (!this.enabled || !this.activeOutputId || this.completedRecorded) return

    // 检查是否已有负面反馈（如 SKIP），有则不再记录 COMPLETED
    const hasNegativeFeedback = false // 运行时动态检查较复杂，保持简单
    voicePreferenceModel.recordAction(this.activeOutputId, 'COMPLETED_NATURALLY')
    this.completedRecorded = true
    this.activeOutputId = null
  }

  // ── 用户行为记录 ──

  /**
   * 记录用户对 TTS 的隐式反馈动作。
   * 可以从渲染进程 IPC、VAD 打断检测、ChatExecutor 等途径调用。
   */
  recordUserAction(action: ImplicitFeedbackAction, targetOutputId?: string): void {
    if (!this.enabled) return

    const outputId = targetOutputId || this.activeOutputId || this.lastOutputId
    if (!outputId) {
      log('WARN', 'implicit_feedback_no_output_id', { action })
      return
    }

    voicePreferenceModel.recordAction(outputId, action)

    // 如果用户跳过了播放，清除活跃输出（不再记录 COMPLETED）
    if (action === 'SKIP' || action === 'INTERRUPT_SPEECH') {
      this.activeOutputId = null
    }
  }

  /**
   * 针对最近一次 TTS 输出记录反馈动作。
   * 渲染进程的简单操作（如重听按钮）使用此方法。
   */
  recordSimpleAction(action: ImplicitFeedbackAction): void {
    if (!this.enabled) return

    if (action === 'REPLAY' && this.lastOutputId) {
      // 重听：可能是因为喜欢当前的语音风格
      voicePreferenceModel.recordAction(this.lastOutputId, 'REPLAY')
    } else if (action === 'SKIP') {
      this.recordUserAction('SKIP')
    }
  }

  // ── 情境检测 ──

  /**
   * 检测用户"继续对话"行为。
   * 在 ChatExecutor.run() 收到新用户消息时调用。
   * 如果此时 TTS 已经播放完毕（或接近完毕），视为用户接受 TTS 质量。
   */
  onUserContinuedConversation(): void {
    if (!this.enabled) return

    // 如果还有活跃的 TTS 输出且用户已开始输入新对话
    if (this.activeOutputId && !this.completedRecorded) {
      voicePreferenceModel.recordAction(this.activeOutputId, 'CONTINUE_CONVERSATION')
      this.activeOutputId = null
    }
  }

  /**
   * 检测用户"修改指令"行为。
   * 当 UserBehaviorAnalyzer 检测到重复/修改模式时调用。
   */
  onUserModifiedRequest(): void {
    if (!this.enabled) return

    if (this.activeOutputId && !this.completedRecorded) {
      voicePreferenceModel.recordAction(this.activeOutputId, 'MODIFY_REQUEST')
      this.activeOutputId = null
    } else if (this.lastOutputId) {
      voicePreferenceModel.recordAction(this.lastOutputId, 'MODIFY_REQUEST')
    }
  }

  // ── 代理到模型 ──

  /** 获取模型推荐 */
  getRecommendation(): PreferenceRecommendation {
    return voicePreferenceModel.getRecommendation()
  }

  /** 手动触发模型更新 */
  updateModel(): void {
    voicePreferenceModel.updateModel()
  }

  /** 重置所有跟踪数据 */
  reset(): void {
    this.lastOutputId = null
    this.activeOutputId = null
    this.activeOutputStartTime = 0
    this.completedRecorded = false
    voicePreferenceModel.reset()
    log('INFO', 'implicit_feedback_tracker_reset')
  }

  /** 获取模型状态摘要（供调试/日志） */
  getStatus(): {
    enabled: boolean
    lastOutputId: string | null
    activeOutput: boolean
    modelInitialized: boolean
    totalSamples: number
    historySize: number
    confidence: number
    recommendedVoice: string
  } {
    const rec = voicePreferenceModel.getRecommendation()
    return {
      enabled: this.enabled,
      lastOutputId: this.lastOutputId,
      activeOutput: !!this.activeOutputId,
      modelInitialized: voicePreferenceModel.isInitialized(),
      totalSamples: voicePreferenceModel.getTotalSamples(),
      historySize: voicePreferenceModel.getHistorySize(),
      confidence: rec.confidence,
      recommendedVoice: rec.params.voice,
    }
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例，供 TtsService 和 ChatExecutor 共享 */
export const implicitFeedbackTracker = new ImplicitFeedbackTracker()
