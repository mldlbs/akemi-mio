/**
 * BlogModeMonitor — 博客写作模式监控器
 *
 * 职责：
 * 1. 持续监控博客写作的条件特征（输入特征、负载、响应时间要求）
 * 2. 评估当前场景应使用哪种执行模式（MCP / Plan:推理链）
 * 3. 当条件变化时发出模式切换建议
 *
 * 评估维度：
 * - 主题复杂度：关键词分析 + 历史写作习惯
 * - 用户交互偏好：实时对话 vs 批量处理
 * - 工作负载：活跃会话数
 * - 响应时间要求：用户表达的速度预期
 */

import { log } from '../../logger/Logger'
import type {
  BlogExecutionMode,
  InputFeatureProfile,
  ModeRecommendation,
} from './BlogExecutionMode'
import {
  evaluateInputFeatures,
  MCP_OPTIMAL_CONDITIONS,
  PLAN_CHAIN_OPTIMAL_CONDITIONS,
} from './BlogExecutionMode'
import type { WritingHabitProfile } from './types'

// =============================================================================
// 常量
// =============================================================================

/** 模式切换的置信度阈值 — 低于此值保持当前模式 */
const SWITCH_CONFIDENCE_THRESHOLD = 0.6

/** 用户连续输入用于判断模式的观察窗口（消息数） */
const OBSERVATION_WINDOW = 5

// =============================================================================
// BlogModeMonitor
// =============================================================================

export class BlogModeMonitor {
  /** 最近用户输入的历史，用于模式模式分析 */
  private recentInputs: string[] = []
  /** 当前活动会话数 */
  private activeSessionCount = 0

  // ==========================================================================
  // 核心推荐方法
  // ==========================================================================

  /**
   * 基于当前输入特征推荐最佳执行模式
   *
   * @param topic 博客主题
   * @param userInput 用户当前输入（自然语言）
   * @param profile 写作习惯画像
   * @returns 模式推荐，包含推荐模式、置信度和理由
   */
  recommendMode(
    topic: string,
    userInput: string,
    profile?: WritingHabitProfile,
  ): ModeRecommendation {
    const features = evaluateInputFeatures(topic, userInput, profile)
    const reasons: string[] = []
    let mcpScore = 0
    let planChainScore = 0

    // ── 维度 1：主题复杂度 ──
    if (features.topicComplexity <= MCP_OPTIMAL_CONDITIONS.inputFeatures.maxTopicComplexity) {
      mcpScore += 0.3
      reasons.push(`主题复杂度 ${features.topicComplexity.toFixed(2)} ≤ 0.5，适合 MCP 交互式写作`)
    }
    if (features.topicComplexity >= PLAN_CHAIN_OPTIMAL_CONDITIONS.inputFeatures.minTopicComplexity) {
      planChainScore += 0.25
      reasons.push(`主题复杂度 ${features.topicComplexity.toFixed(2)} ≥ 0.4，Plan 推理链可发挥自动化优势`)
    }

    // ── 维度 2：交互偏好 ──
    if (features.prefersInteractive) {
      mcpScore += 0.25
      reasons.push('用户偏好交互式步骤确认，MCP 模式更适合')
    } else {
      planChainScore += 0.15
      reasons.push('用户不坚持逐段确认，Plan 模式可以加速')
    }

    // ── 维度 3：结构化需求 ──
    if (features.hasStructuredRequirements) {
      planChainScore += 0.2
      reasons.push('有明确的结构化需求，Plan 推理链可按步骤有序执行')
    } else {
      mcpScore += 0.1
      reasons.push('大纲未定，MCP 模式可以边写边探索')
    }

    // ── 维度 4：深度分析需求 ──
    if (features.requiresDeepAnalysis) {
      planChainScore += 0.2
      reasons.push('需要深度技术分析，Plan 模式可自动完成代码分析、素材收集')
    }

    // ── 维度 5：跨平台发布 ──
    if (features.crossPlatformPublishing) {
      planChainScore += 0.15
      reasons.push('涉及多平台发布规划，Plan 模式可一键适配')
    }

    // ── 维度 6：紧急程度 ──
    if (features.urgencyLevel > 0.5) {
      mcpScore += 0.15
      reasons.push('用户表达急迫需求，MCP 模式可更快交互产出')
    }

    // ── 维度 7：负载 ──
    if (this.activeSessionCount >= MCP_OPTIMAL_CONDITIONS.loadRange.maxConcurrentSessions) {
      planChainScore += 0.2
      reasons.push(`当前活跃会话数 ${this.activeSessionCount}，MCP 模式接近负载上限`)
    }

    // ── 维度 8：修订历史 ──
    if (features.avgRevisionRounds >= 3) {
      planChainScore += 0.1
      reasons.push('历史修订轮次较多，Plan 模式可系统化处理迭代')
    }

    // ── 综合决策 ──
    const totalScore = mcpScore + planChainScore
    const normalizedMcp = totalScore > 0 ? mcpScore / totalScore : 0.5
    const normalizedPlan = totalScore > 0 ? planChainScore / totalScore : 0.5

    let recommendedMode: BlogExecutionMode
    let confidence: number

    if (normalizedMcp >= normalizedPlan) {
      recommendedMode = 'mcp'
      confidence = normalizedMcp
    } else {
      recommendedMode = 'plan_chain'
      confidence = normalizedPlan
    }

    log('DEBUG', 'blog_mode_recommendation', {
      mode: recommendedMode,
      confidence: confidence.toFixed(2),
      mcpScore: normalizedMcp.toFixed(2),
      planScore: normalizedPlan.toFixed(2),
      topicComplexity: features.topicComplexity.toFixed(2),
      prefersInteractive: features.prefersInteractive,
    })

    return {
      recommendedMode,
      confidence,
      reasons,
      features,
    }
  }

  /**
   * 判断是否需要切换模式
   * 仅在置信度超过阈值且新模式与当前模式不同时建议切换
   */
  shouldSwitch(
    currentMode: BlogExecutionMode,
    topic: string,
    userInput: string,
    profile?: WritingHabitProfile,
  ): { shouldSwitch: boolean; recommendation: ModeRecommendation } {
    const recommendation = this.recommendMode(topic, userInput, profile)
    const shouldSwitch =
      recommendation.recommendedMode !== currentMode &&
      recommendation.confidence >= SWITCH_CONFIDENCE_THRESHOLD

    if (shouldSwitch) {
      log('INFO', 'blog_mode_switch_suggested', {
        from: currentMode,
        to: recommendation.recommendedMode,
        confidence: recommendation.confidence,
        reasons: recommendation.reasons,
      })
    }

    return { shouldSwitch, recommendation }
  }

  // ==========================================================================
  // 用户输入跟踪（用于流式检测交互偏好变化）
  // ==========================================================================

  /**
   * 记录用户输入，更新观察窗口
   */
  recordUserInput(input: string): void {
    this.recentInputs.push(input)
    if (this.recentInputs.length > OBSERVATION_WINDOW) {
      this.recentInputs.shift()
    }
  }

  /**
   * 分析最近的用户输入，检测交互偏好变化趋势
   * - 如果用户最近多次使用"继续/好/通过"等批准型指令 → 偏好 MCP
   * - 如果用户最近多次使用"批量/自动/全部"等批量指令 → 偏好 Plan
   */
  detectInteractionTrend(): 'mcp_favoring' | 'plan_favoring' | 'neutral' {
    if (this.recentInputs.length < 2) return 'neutral'

    const approvePattern = /继续|好|可以|通过|批准|ok|yes|go|next|approve/i
    const batchPattern = /批量|全部|自动|一次.*完|batch|all|auto|bulk/i

    let approveCount = 0
    let batchCount = 0

    for (const input of this.recentInputs) {
      if (approvePattern.test(input)) approveCount++
      if (batchPattern.test(input)) batchCount++
    }

    const threshold = Math.ceil(this.recentInputs.length * 0.4)

    if (approveCount >= threshold && approveCount > batchCount) return 'mcp_favoring'
    if (batchCount >= threshold) return 'plan_favoring'
    return 'neutral'
  }

  // ==========================================================================
  // 负载跟踪
  // ==========================================================================

  /**
   * 更新活跃会话数
   */
  setActiveSessionCount(count: number): void {
    this.activeSessionCount = count
  }

  /**
   * 获取当前负载评估
   */
  getLoadAssessment(): { activeSessions: number; isHighLoad: boolean } {
    return {
      activeSessions: this.activeSessionCount,
      isHighLoad: this.activeSessionCount >= MCP_OPTIMAL_CONDITIONS.loadRange.maxConcurrentSessions,
    }
  }

  // ==========================================================================
  // 重置
  // ==========================================================================

  reset(): void {
    this.recentInputs = []
    this.activeSessionCount = 0
    log('DEBUG', 'blog_mode_monitor_reset')
  }
}

// =============================================================================
// 全局单例
// =============================================================================

export const blogModeMonitor = new BlogModeMonitor()
