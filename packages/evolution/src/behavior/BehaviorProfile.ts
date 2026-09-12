/**
 * BehaviorProfile — 行为驱动的用户画像组件
 *
 * 从 UserBehaviorAnalyzer 的运行时数据中提取用户交互特征，
 * 聚合成一个干净的可查询画像。
 *
 * 画像包含：
 * - 总交互次数、平均消息长度、工具调用频率
 * - 常用工具 ID 列表、工具使用率
 * - 活跃话题标签
 *
 * 画像数据供 BehaviorRuleEngine 做规则判断，
 * 也供 ChatExecutor 调整回复生成策略。
 *
 * 冷启动：无数据时返回默认画像（hasSufficientData = false）。
 *
 * 隐私注意：仅聚合最近窗口内的数据，不持久化原始文本。
 *
 * @module behavior
 */

import { userBehaviorAnalyzer } from '@akemi-mio/intelligence/agent/UserBehaviorAnalyzer'
import type { BehaviorPattern, SceneAnalysisResult } from '@akemi-mio/intelligence/agent/UserBehaviorAnalyzer'
import { log } from '@akemi-mio/core/logger/Logger'

// ══════════════════════════════════════════
// 类型定义
// ══════════════════════════════════════════

/**
 * 用户画像 — 从行为分析中聚合的关键特征。
 *
 * 这是 BehaviorRuleEngine 的输入数据源。
 * 所有字段均为纯数值或字符串数组，不含原始文本。
 */
export interface BehaviorProfile {
  /** 是否拥有足够数据（>= 3 次交互） */
  hasSufficientData: boolean

  // ── 交互统计 ──
  /** 窗口内总交互次数 */
  totalInteractions: number
  /** 窗口内用户消息平均长度（字符数） */
  avgMessageLength: number
  /** 窗口内用户消息长度中位数（字符数） */
  medianMessageLength: number

  // ── 工具使用统计 ──
  /** 工具使用率：工具调用数 / 总交互数 (0-1) */
  toolUsageRatio: number
  /** 常用工具 ID 列表（按调用次数降序，最多 10 个） */
  topToolIds: string[]
  /** 每个常用工具的调用次数 */
  toolCallCounts: Record<string, number>
  /** 工具调用成功率 (0-1)，无工具调用时为 1 */
  toolSuccessRate: number

  // ── 话题标签 ──
  /** 活跃话题标签列表（按出现次数降序，最多 5 个） */
  activeTopics: string[]

  // ── 时间特征 ──
  /** 距离上次用户消息的秒数 */
  secondsSinceLastMessage: number

  // ── 场景分析结果（含置信度） ──
  /** 检测到的交互场景 */
  scene: string
  /** 场景置信度 (0-1) */
  sceneConfidence: number
  /** 当前推荐的回复模式 */
  responseMode: string
}

/** 默认画像（冷启动无数据时使用） */
export const DEFAULT_PROFILE: BehaviorProfile = {
  hasSufficientData: false,
  totalInteractions: 0,
  avgMessageLength: 0,
  medianMessageLength: 0,
  toolUsageRatio: 0,
  topToolIds: [],
  toolCallCounts: {},
  toolSuccessRate: 1,
  activeTopics: [],
  secondsSinceLastMessage: 0,
  scene: 'unknown',
  sceneConfidence: 0,
  responseMode: 'warm_chat',
}

// ══════════════════════════════════════════
// 画像构建
// ══════════════════════════════════════════

/** 辅助：计算中位数 */
function computeMedian(nums: number[]): number {
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid]
}

/**
 * 从 UserBehaviorAnalyzer 的当前运行时数据构建 BehaviorProfile。
 *
 * @returns BehaviorProfile 当前用户画像
 */
export function buildBehaviorProfile(): BehaviorProfile {
  try {
    // 从分析器获取行为模式
    const pattern: BehaviorPattern = userBehaviorAnalyzer.analyze()

    // 获取场景分析结果
    const sceneResult: SceneAnalysisResult = userBehaviorAnalyzer.analyzeScene()

    // 计算平均消息长度（从场景结果读取，或从 pattern 推断）
    const avgLength = sceneResult.avgUserMessageLength

    // 计算中位数消息长度（从交互详情中提取）
    const interactionDetails = userBehaviorAnalyzer.getInteractionDetails()
    const userLengths: number[] = []
    for (const d of interactionDetails) {
      if (d.type === 'user_message' && typeof d.length === 'number') {
        userLengths.push(d.length)
      }
    }
    const medianLength = userLengths.length > 0 ? computeMedian(userLengths) : avgLength

    // 提取 top 工具 ID
    const toolEntries = Object.entries(pattern.toolCallCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
    const topTools = toolEntries.map(([name]) => name)

    // 计算工具使用率
    const toolRatio = sceneResult.toolUsageRatio

    // 计算工具成功率
    const qualityMetrics = userBehaviorAnalyzer.getToolQualityMetrics()
    let totalCalls = 0
    let totalSuccess = 0
    for (const [, metrics] of qualityMetrics) {
      totalCalls += metrics.totalCalls
      totalSuccess += Math.round(metrics.successRate * metrics.totalCalls)
    }
    const successRate = totalCalls > 0 ? totalSuccess / totalCalls : 1

    // 计算距离上次消息的秒数
    const recentMessages = userBehaviorAnalyzer.getRecentUserMessages()
    let lastMsgSec = 0
    if (recentMessages.length > 0) {
      const last = recentMessages[recentMessages.length - 1]
      if (last && typeof last.timestamp === 'number') {
        lastMsgSec = Math.round((Date.now() - last.timestamp) / 1000)
      }
    }

    const profile: BehaviorProfile = {
      hasSufficientData: pattern.hasSufficientData || sceneResult.hasSufficientData,
      totalInteractions: pattern.totalInteractions,
      avgMessageLength: avgLength,
      medianMessageLength: medianLength,
      toolUsageRatio: toolRatio,
      topToolIds: topTools,
      toolCallCounts: pattern.toolCallCounts,
      toolSuccessRate: Math.round(successRate * 100) / 100,
      activeTopics: sceneResult.dominantTopics.slice(0, 5),
      secondsSinceLastMessage: lastMsgSec,
      scene: sceneResult.scene,
      sceneConfidence: Math.round(sceneResult.confidence * 100) / 100,
      responseMode: sceneResult.responseMode,
    }

    return profile
  } catch (err) {
    log('WARN', 'behavior_profile_build_error', { error: String(err) })
    return { ...DEFAULT_PROFILE }
  }
}

/**
 * 构建简要画像快照（轻量版，仅含关键指标）。
 * 用于不需要完整场景分析的场景（如规则引擎的热路径）。
 */
export function buildProfileSnapshot(): Pick<
  BehaviorProfile,
  'hasSufficientData' | 'totalInteractions' | 'avgMessageLength' | 'toolUsageRatio' | 'topToolIds' | 'activeTopics' | 'responseMode'
> {
  try {
    const pattern = userBehaviorAnalyzer.analyze()
    const sceneResult = userBehaviorAnalyzer.analyzeScene()
    const toolEntries = Object.entries(pattern.toolCallCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
    return {
      hasSufficientData: pattern.hasSufficientData || sceneResult.hasSufficientData,
      totalInteractions: pattern.totalInteractions,
      avgMessageLength: sceneResult.avgUserMessageLength,
      toolUsageRatio: sceneResult.toolUsageRatio,
      topToolIds: toolEntries.map(([name]) => name),
      activeTopics: sceneResult.dominantTopics.slice(0, 5),
      responseMode: sceneResult.responseMode,
    }
  } catch {
    return {
      hasSufficientData: false,
      totalInteractions: 0,
      avgMessageLength: 0,
      toolUsageRatio: 0,
      topToolIds: [],
      activeTopics: [],
      responseMode: 'warm_chat',
    }
  }
}
