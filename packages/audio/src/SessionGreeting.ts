/**
 * SessionGreeting — 会话开场问候生成器
 *
 * 在新会话开始时，查询 Memory 中的上一次对话摘要，生成带记忆连贯性的问候语。
 * 例如："欢迎回来！上次我们聊到了 TypeScript 的类型系统…"
 *
 * 设计目标：
 * - 新会话第一次 TTS 输出时，自动提及上次对话的关键点
 * - 增强语音交互的连贯性和个性化体验
 * - 用户感受到系统"记得"之前的交流内容
 *
 * 风险控制：
 * - 无上一次对话摘要时静默跳过（不生成问候）
 * - 问候仅首次触发一次，避免每轮都重复
 * - 所有操作内部 catch 异常，不传播到调用方
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { MemoryService } from '@akemi-mio/intelligence-memory/MemoryService'
import type { SessionGreetingResult } from './types'

/** 问候生成的最低置信度 */
const MIN_GREETING_CONFIDENCE = 0.3

/** 摘要引用最大长度（防止问候语过长） */
const MAX_SUMMARY_LENGTH = 60

// ═══════════════════════════════════════════════
//  SessionGreeting
// ═══════════════════════════════════════════════

export class SessionGreeting {
  private memoryService: MemoryService | null = null

  /** 本会话是否已展示过问候（初始化时基于外部标记） */
  private greetingShownThisSession = false

  constructor() {
    log('INFO', 'session_greeting_created')
  }

  /** 注入 MemoryService 引用（由 PreferenceEnhancer 设置） */
  setMemoryService(ms: MemoryService): void {
    this.memoryService = ms
    log('INFO', 'session_greeting_memory_attached')
  }

  // ════════════════════════════════════════════
  //  状态管理
  // ════════════════════════════════════════════

  /** 重置会话状态（例如新 Electron 窗口创建时） */
  resetSession(): void {
    this.greetingShownThisSession = false
    log('INFO', 'session_greeting_reset')
  }

  /** 标记问候已展示 */
  markGreetingShown(): void {
    this.greetingShownThisSession = true
  }

  /** 检查是否应展示问候 */
  shouldGreet(): boolean {
    return !this.greetingShownThisSession
  }

  // ════════════════════════════════════════════
  //  问候生成
  // ════════════════════════════════════════════

  /**
   * 生成会话开场问候文本。
   *
   * 从 MemoryService 的 SummaryMemory 读取最新一条对话摘要，
   * 提取关键话题和摘要文本，生成自然的中文问候语。
   *
   * @returns 问候结果（含文本和来源信息），或 null（无可用摘要）
   */
  generateGreeting(): SessionGreetingResult | null {
    // 已展示过则不重复生成
    if (this.greetingShownThisSession) return null
    if (!this.memoryService) return null

    try {
      const ms = this.memoryService

      // 获取最近的对话摘要
      const recentSummaries = ms.summary.getRecentFull(1)
      if (recentSummaries.length === 0) return null

      const lastSummary = recentSummaries[0]
      if (!lastSummary.summary || lastSummary.summary.length < 5) return null

      // 提取摘要文本（截断过长摘要）
      const summaryText = lastSummary.summary.slice(0, MAX_SUMMARY_LENGTH)
      const hasEllipsis = lastSummary.summary.length > MAX_SUMMARY_LENGTH

      // 生成问候语
      const topics = lastSummary.topics || []
      let greeting: string

      if (topics.length > 0) {
        // 有话题标签：更精确的问候
        const topicStr = topics.slice(0, 2).join('、')
        greeting = `欢迎回来！上次我们聊到了${topicStr}，${summaryText}${hasEllipsis ? '…' : ''}`
      } else {
        // 无话题标签：基于摘要的一般性问候
        greeting = `欢迎回来！上次说到${summaryText}${hasEllipsis ? '…' : ''}`
      }

      log('INFO', 'session_greeting_generated', {
        topics: topics.join(','),
        summaryLength: lastSummary.summary.length,
        greetingLength: greeting.length,
      })

      return {
        greeting,
        lastSummary: lastSummary.summary,
        lastTopics: topics,
        confidence: MIN_GREETING_CONFIDENCE + 0.2, // 有摘要信息时置信度较高
      }
    } catch (err) {
      log('WARN', 'session_greeting_generate_failed', { error: String(err) })
      return null
    }
  }

  /**
   * 生成问候并自动标记已展示。
   * 适用于"消费即标记"的场景。
   */
  generateAndMark(): SessionGreetingResult | null {
    const result = this.generateGreeting()
    if (result) {
      this.markGreetingShown()
    }
    return result
  }
}

/** 模块级单例 */
export const sessionGreeting = new SessionGreeting()
