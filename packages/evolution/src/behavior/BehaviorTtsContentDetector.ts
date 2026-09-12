/**
 * BehaviorTtsContentDetector — 用户消息内容行为检测器
 *
 * 在 TTS 调用前分析用户消息的内容特征，计算三个核心指标：
 *   1. 连续短消息数（<10 字）
 *   2. 最近提问间隔
 *   3. 句尾问号比例
 *
 * 根据这些指标匹配 BehaviorTtsContentMap 中的预设规则，
 * 输出对应的 TTS 参数调整建议。
 *
 * 与 ContextualTtsAdvisor（关注交互节奏 timing）互补：
 *   - ContextualTtsAdvisor: 用户什么时候交互（时间间隔模式）
 *   - BehaviorTtsContentDetector: 用户交互了什么（消息内容特征）
 *
 * 集成点：
 *   - ChatExecutor.run() → detector.recordMessage() 记录每条用户消息
 *   - ChatExecutor.applySentimentToTts() → detector.analyze() 获取内容行为分析
 *   → 结果传递给 buildTtsNeed() 作为新的行为源
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { matchContentBehavior, applyContentAdjustment, DEFAULT_CONTENT_ADJUSTMENT } from './BehaviorTtsContentMap'
import type { ContentBehaviorMetrics, ContentBehaviorAdjustment } from './BehaviorTtsContentMap'
import type { EmotionTtsParams } from '@akemi-mio/audio/types'

// ══════════════════════════════════════════
//  配置常量
// ══════════════════════════════════════════

/** 短消息字符数上限（<= 此值视为短消息） */
const SHORT_MESSAGE_CHAR_LIMIT = 10

/** 内容分析窗口大小（保留最近 N 条消息用于问号比例计算） */
const CONTENT_WINDOW_SIZE = 20

/** 内容分析缓存 TTL（毫秒） */
const ANALYSIS_CACHE_TTL_MS = 3000

/** 去抖时间（毫秒）：同一分析结果持续此时间后才再次通知，防止频繁切换 */
const DEBOUNCE_MS = 5000

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 单条用户消息记录 */
export interface UserMessageRecord {
  /** 消息文本 */
  text: string
  /** 消息长度（字符数） */
  charCount: number
  /** 是否以问号结尾 */
  endsWithQuestion: boolean
  /** 是否短消息（<10 字） */
  isShort: boolean
  /** 时间戳 */
  timestamp: number
}

/** 内容行为分析的完整结果 */
export interface ContentBehaviorAnalysis {
  /** 核心指标 */
  metrics: ContentBehaviorMetrics
  /** 匹配到的调整建议（可能为 DEFAULT_CONTENT_ADJUSTMENT） */
  adjustment: ContentBehaviorAdjustment
  /** 是否与上次分析结果有实质性差异 */
  changed: boolean
  /** 人类可读描述 */
  description: string
}

// ══════════════════════════════════════════
//  BehaviorTtsContentDetector
// ══════════════════════════════════════════

export class BehaviorTtsContentDetector {
  /** 用户消息环形缓冲区 */
  private messages: UserMessageRecord[] = []

  /** 上次分析结果缓存 */
  private lastAnalysis: ContentBehaviorAnalysis | null = null
  private lastAnalysisTime = 0

  /** 上次通知外部的内容行为分析（用于去抖） */
  private lastNotified: ContentBehaviorAdjustment | null = null
  private lastNotifyTime = 0

  /** 是否启用 */
  private enabled = true

  // ── 生命周期 ──

  /** 启用/禁用 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      this.lastAnalysis = null
      this.lastNotified = null
    }
    log('INFO', 'content_tts_detector_enabled', { enabled })
  }

  isEnabled(): boolean {
    return this.enabled
  }

  // ── 数据采集 ──

  /**
   * 记录一条用户消息。
   * 应在每次用户输入到达时调用（ChatExecutor.run() 开头）。
   *
   * @param text 用户消息原文
   */
  recordMessage(text: string): void {
    if (!this.enabled) return

    const charCount = text.trim().length
    const endsWithQuestion = /[？?]\s*$/.test(text.trim())
    const isShort = charCount <= SHORT_MESSAGE_CHAR_LIMIT

    const record: UserMessageRecord = {
      text,
      charCount,
      endsWithQuestion,
      isShort,
      timestamp: Date.now(),
    }

    this.messages.push(record)

    // 限制窗口大小
    if (this.messages.length > CONTENT_WINDOW_SIZE) {
      this.messages = this.messages.slice(-CONTENT_WINDOW_SIZE)
    }

    // 使分析缓存失效
    this.lastAnalysis = null
  }

  // ── 核心分析 ──

  /**
   * 执行内容行为分析。
   *
   * 计算三个核心指标并匹配映射规则。
   * 3 秒内有缓存直接返回。
   *
   * @returns 内容行为分析结果
   */
  analyze(): ContentBehaviorAnalysis {
    if (!this.enabled) {
      return this.neutralAnalysis('disabled')
    }

    const now = Date.now()
    if (this.lastAnalysis && now - this.lastAnalysisTime < ANALYSIS_CACHE_TTL_MS) {
      return this.lastAnalysis
    }

    const metrics = this.computeMetrics()
    const adjustment = matchContentBehavior(metrics)

    // 去抖检测：与上次通知的内容是否实质性不同
    const changed = this.isAdjustmentDifferent(adjustment)
    if (changed) {
      this.lastNotified = { ...adjustment }
      this.lastNotifyTime = now
    }

    const description = this.buildDescription(metrics, adjustment)

    const analysis: ContentBehaviorAnalysis = {
      metrics,
      adjustment,
      changed,
      description,
    }

    // 仅在非默认或有意义的变化时记录日志
    if (adjustment.label !== DEFAULT_CONTENT_ADJUSTMENT.label) {
      log('INFO', 'content_tts_analysis', {
        shortMessages: metrics.consecutiveShortMessages,
        consecutiveQuestions: metrics.consecutiveQuestions,
        intervalSec: metrics.recentMessageIntervalSec.toFixed(1),
        questionRatio: metrics.questionMarkRatio.toFixed(2),
        rateDelta: adjustment.rateDelta,
        pitchDelta: adjustment.pitchDelta,
        voiceOverride: adjustment.voiceOverride ?? 'none',
        label: adjustment.label,
        changed,
      })
    }

    this.lastAnalysis = analysis
    this.lastAnalysisTime = now
    return analysis
  }

  /**
   * 获取内容行为调整建议（便捷方法，直接返回调整值）。
   */
  getAdjustment(): ContentBehaviorAdjustment {
    return this.analyze().adjustment
  }

  /**
   * 基于内容行为分析，在 EmotionTtsParams 上叠加调整。
   *
   * @param base 基础 TTS 参数
   * @returns 叠加内容行为调整后的新参数
   */
  applyToParams(base: EmotionTtsParams): EmotionTtsParams {
    const adjustment = this.getAdjustment()
    return applyContentAdjustment(base, adjustment)
  }

  // ── 私有：指标计算 ──

  /**
   * 从消息历史中计算三个核心指标。
   */
  private computeMetrics(): ContentBehaviorMetrics {
    const window = this.messages

    if (window.length === 0) {
      return {
        consecutiveShortMessages: 0,
        consecutiveQuestions: 0,
        recentMessageIntervalSec: 0,
        questionMarkRatio: 0,
        totalMessagesInWindow: 0,
      }
    }

    const now = Date.now()

    // ── 指标 1: 连续短消息数（从末尾往前数）──
    let consecutiveShortMessages = 0
    for (let i = window.length - 1; i >= 0; i--) {
      if (window[i].isShort) {
        consecutiveShortMessages++
      } else {
        break
      }
    }

    // ── 指标 2: 最近提问间隔（从末尾往前找第一个问句，计算时间差）──
    let consecutiveQuestions = 0
    for (let i = window.length - 1; i >= 0; i--) {
      if (window[i].endsWithQuestion) {
        consecutiveQuestions++
      } else {
        break
      }
    }

    // 距上一条消息的间隔
    const recentMessageIntervalSec = window.length >= 2 ? (now - window[window.length - 1].timestamp) / 1000 : 0

    // ── 指标 3: 问号比例 ──
    const questionCount = window.filter((m) => m.endsWithQuestion).length
    const questionMarkRatio = window.length > 0 ? questionCount / window.length : 0

    return {
      consecutiveShortMessages,
      consecutiveQuestions,
      recentMessageIntervalSec,
      questionMarkRatio: Math.round(questionMarkRatio * 100) / 100,
      totalMessagesInWindow: window.length,
    }
  }

  // ── 私有：去抖 ──

  /**
   * 判断两次调整是否有实质性差异（用于防止频繁切换）。
   */
  private isAdjustmentDifferent(a: ContentBehaviorAdjustment): boolean {
    if (!this.lastNotified) return true

    const now = Date.now()
    if (now - this.lastNotifyTime < DEBOUNCE_MS) return false

    return (
      Math.abs(a.rateDelta - this.lastNotified.rateDelta) >= 5 ||
      Math.abs(a.pitchDelta - this.lastNotified.pitchDelta) >= 3 ||
      a.voiceOverride !== this.lastNotified.voiceOverride ||
      Math.abs(a.speedFactor - this.lastNotified.speedFactor) >= 0.1
    )
  }

  // ── 私有：描述生成 ──

  /**
   * 生成人类可读的分析描述。
   */
  private buildDescription(metrics: ContentBehaviorMetrics, adjustment: ContentBehaviorAdjustment): string {
    const parts: string[] = []

    if (metrics.consecutiveShortMessages >= 2) {
      parts.push(`${metrics.consecutiveShortMessages}条短消息`)
    }
    if (metrics.consecutiveQuestions >= 2) {
      parts.push(`${metrics.consecutiveQuestions}个连续提问`)
    }
    if (metrics.questionMarkRatio > 0.3) {
      parts.push(`问号率${Math.round(metrics.questionMarkRatio * 100)}%`)
    }

    const prefix = parts.length > 0 ? parts.join('·') : '常规'
    const suffix = adjustment.label
    return `${prefix}→${suffix}`
  }

  // ── 状态查询 ──

  /** 获取消息历史（供调试/UI 展示） */
  getMessageHistory(): UserMessageRecord[] {
    return [...this.messages]
  }

  /** 获取当前内容指标（供调试/UI 展示） */
  getMetrics(): ContentBehaviorMetrics {
    return this.computeMetrics()
  }

  /** 重置所有运行时数据 */
  reset(): void {
    this.messages = []
    this.lastAnalysis = null
    this.lastAnalysisTime = 0
    this.lastNotified = null
    this.lastNotifyTime = 0
  }

  // ── 私有工具方法 ──

  /** 生成禁用/中性分析结果 */
  private neutralAnalysis(reason: string): ContentBehaviorAnalysis {
    return {
      metrics: {
        consecutiveShortMessages: 0,
        consecutiveQuestions: 0,
        recentMessageIntervalSec: 0,
        questionMarkRatio: 0,
        totalMessagesInWindow: 0,
      },
      adjustment: { ...DEFAULT_CONTENT_ADJUSTMENT },
      changed: false,
      description: reason,
    }
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例，供 ChatExecutor 使用 */
export const behaviorTtsContentDetector = new BehaviorTtsContentDetector()
