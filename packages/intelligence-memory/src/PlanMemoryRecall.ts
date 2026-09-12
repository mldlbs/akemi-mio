/**
 * PlanMemoryRecall — 计划感知记忆恢复
 *
 * 按计划 ID 存储对话上下文摘要，当用户切换或重新启动计划时自动召回相关记忆。
 *
 * 核心流程：
 *   1. 对话结束后，检测当前活跃计划，将用户输入和系统回复的摘要存入 Memory
 *   2. 初始化计划对话时，查询该计划的最近 K 条记录并格式化注入系统提示
 *
 * 设计原则：
 * - 使用 MemoryEntry (type='plan_conversation') 存储，复现现有记忆衰减机制
 * - 通过 structuredData JSON 字段保存计划的元数据
 * - 每个摘要条目独立存储，按 planId 分组检索
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { MemoryService } from './MemoryService'
import type { MemoryEntry, PlanConversationData } from './types'

// ══════════════════════════════════════════
//  配置常量
// ══════════════════════════════════════════

/** 默认每次检索的最大条数 */
const DEFAULT_RECALL_LIMIT = 5
/** 存储内容的最大字符数 */
const MAX_CONTENT_LENGTH = 300
/** 默认置信度 */
const DEFAULT_CONFIDENCE = 0.7
/** 摘要的默认记忆层级（半永久，慢衰减） */
const DEFAULT_TIER: MemoryEntry['tier'] = 'semi'

// ══════════════════════════════════════════
//  PlanMemoryRecall
// ══════════════════════════════════════════

export class PlanMemoryRecall {
  private memoryService: MemoryService | null = null

  /**
   * 注入 MemoryService 实例。
   * 允许延迟注入，便于依赖解析。
   */
  setMemoryService(memoryService: MemoryService): void {
    this.memoryService = memoryService
  }

  /**
   * 获取当前 MemoryService 实例。
   */
  private getMemory(): MemoryService | null {
    return this.memoryService
  }

  // ── 存储 ──────────────────────────────────────────────

  /**
   * 存储一条计划对话记忆。
   * 在对话交互完成后，检测到活跃计划上下文时调用。
   * 自动截断过长内容，以 planId 为 key 组织。
   *
   * @param planId 计划 ID
   * @param planTitle 计划标题
   * @param userMessage 用户消息（摘录）
   * @param assistantReply 助手回复（摘录）
   */
  storePlanConversation(planId: string, planTitle: string, userMessage: string, assistantReply: string): void {
    const ms = this.getMemory()
    if (!ms) {
      log('WARN', 'plan_memory_recall_no_memory', { planId })
      return
    }

    // 截断内容到最大长度
    const userText = userMessage.slice(0, MAX_CONTENT_LENGTH)
    const replyText = assistantReply.slice(0, MAX_CONTENT_LENGTH)

    // 构造人类可读的摘要内容
    const content = this.buildContent(planTitle, userText, replyText)

    // 构造结构化数据（存 planId / planTitle / 摘要）
    const structuredData: PlanConversationData = {
      planId,
      planTitle,
      userMessageSummary: userText,
      assistantReplySummary: replyText,
      timestamp: Date.now(),
    }

    ms.addEntry('plan_conversation', content, DEFAULT_CONFIDENCE, {
      tier: DEFAULT_TIER,
      structuredData: JSON.stringify(structuredData),
    })

    log('INFO', 'plan_conversation_stored', {
      planId,
      planTitle: planTitle.slice(0, 30),
      userLen: userText.length,
      replyLen: replyText.length,
    })
  }

  /**
   * 为多个活跃计划存储对话摘要。
   * 当多个计划同时活跃时，为每个计划独立存储一条摘要。
   *
   * @param planIds 计划 ID 列表（含标题映射）
   * @param planTitles 计划 ID → 标题 的 Map
   * @param userMessage 用户消息
   * @param assistantReply 助手回复
   */
  storeForPlans(planIds: string[], planTitles: Map<string, string>, userMessage: string, assistantReply: string): void {
    if (planIds.length === 0) return
    for (const planId of planIds) {
      const title = planTitles.get(planId) || planId
      this.storePlanConversation(planId, title, userMessage, assistantReply)
    }
  }

  // ── 检索 ──────────────────────────────────────────────

  /**
   * 查询指定计划的最近 K 条对话记忆。
   * 从 MemoryService 中检索 type='plan_conversation' 的条目，
   * 按 updatedAt 降序排列，取最新的 limit 条。
   *
   * @param planId 计划 ID
   * @param limit 最大返回条数（默认 5）
   * @returns 按时间降序排列的 MemoryEntry 列表
   */
  getRecentPlanMemories(planId: string, limit: number = DEFAULT_RECALL_LIMIT): MemoryEntry[] {
    const ms = this.getMemory()
    if (!ms) return []

    const allConversations = ms.getEntriesByType('plan_conversation')
    const matched = allConversations
      .filter((e) => {
        if (!e.structuredData) return false
        try {
          const data = JSON.parse(e.structuredData) as PlanConversationData
          return data.planId === planId
        } catch {
          return false
        }
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)

    return matched
  }

  /**
   * 查询多个计划的最近对话记忆（去重合并）。
   * 当 session 中有多个活跃计划时，获取所有计划的最近记录。
   *
   * @param planIds 计划 ID 数组
   * @param limit 每计划最大条数（默认 5）
   * @returns 按时间降序排列的 MemoryEntry 列表
   */
  getMultiPlanMemories(planIds: string[], limit: number = DEFAULT_RECALL_LIMIT): MemoryEntry[] {
    if (planIds.length === 0) return []

    const allConversations = this.getMemory()?.getEntriesByType('plan_conversation') || []
    const planIdSet = new Set(planIds)

    const matched = allConversations
      .filter((e) => {
        if (!e.structuredData) return false
        try {
          const data = JSON.parse(e.structuredData) as PlanConversationData
          return planIdSet.has(data.planId)
        } catch {
          return false
        }
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)

    return matched
  }

  // ── 格式化上下文 ──────────────────────────────────────

  /**
   * 获取计划对话记忆的格式化上下文，用于注入 system prompt。
   *
   * 输出格式：
   * ---
   * 【计划对话记忆】
   * 以下是你与用户就当前活跃计划的历史对话摘要：
   * - [计划标题] 摘要内容...
   * - [计划标题] 摘要内容...
   * ---
   *
   * @param planIds 活跃计划 ID 列表
   * @param limit 最大返回条数
   * @returns 格式化字符串，无记录时返回空字符串
   */
  getFormattedContext(planIds: string[], limit: number = DEFAULT_RECALL_LIMIT): string {
    if (planIds.length === 0) return ''

    const entries = this.getMultiPlanMemories(planIds, limit)
    if (entries.length === 0) return ''

    const parts: string[] = ['---', '【计划对话记忆】', '以下是你与用户就当前活跃计划的历史对话摘要：']

    for (const entry of entries) {
      let planTitle = ''
      let userSummary = ''
      let replySummary = ''

      if (entry.structuredData) {
        try {
          const data = JSON.parse(entry.structuredData) as PlanConversationData
          planTitle = data.planTitle || ''
          userSummary = data.userMessageSummary || ''
          replySummary = data.assistantReplySummary || ''
        } catch {
          // 结构化数据损坏时使用 content 字段
        }
      }

      const displayContent = planTitle
        ? `[${planTitle}] 用户: ${userSummary.slice(0, 60)} → ${replySummary.slice(0, 60)}`
        : entry.content.slice(0, 120)

      parts.push(`- ${displayContent}`)
    }

    parts.push('---')
    return parts.join('\n')
  }

  // ── 内部方法 ──────────────────────────────────────────

  /**
   * 构建人类可读的摘要内容，用作 MemoryEntry.content。
   */
  private buildContent(planTitle: string, userText: string, replyText: string): string {
    const parts = [`【计划对话】${planTitle}`, `用户: ${userText}`, `助手: ${replyText}`]
    return parts.join(' | ').slice(0, MAX_CONTENT_LENGTH)
  }
}

/** 单例导出 */
export const planMemoryRecall = new PlanMemoryRecall()
