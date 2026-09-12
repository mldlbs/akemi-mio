/**
 * LearningTtsAdapter — Plan:TypeScript → TTS 适配器
 *
 * 将 PlanTypeScriptExecutor 产生的各种学习事件和内容，
 * 转换为结构化的 TTS 需求声明（LearningTtsNeed）。
 *
 * ── 集成方式 ──
 * 由 ChatExecutor 在收到学习事件或需要播报学习内容时调用。
 * 输出 LearningTtsNeed 供 TtsService 消费。
 *
 * ── 与 UserBehaviorTtsContract 的关系 ──
 * UserBehaviorTtsContract：决定「什么时候说、说多大声」
 * LearningTtsContract：   决定「说什么格式、说多快、失败了怎么办」
 * 两者在 TtsService 中合并：先应用 LearningTtsNeed（内容需求），
 * 再叠加 UserBehaviorTtsNeed（行为约束）。
 *
 * ── 对比之前 ──
 * Before: 学习系统直接拼接文本 → ttsService.speak(text)
 *         （TTS 不知道是教学内容还是反馈，无法优化语速/容错）
 * After:  学习系统通过适配器构建 LearningTtsNeed →
 *         TtsService 根据 contentType/outputMode 调整参数
 *         （TTS 知道内容类型，可以针对性地调整语速、停顿、容错）
 *
 * @module learning/LearningTtsAdapter
 */

import { learningVocabularyManager } from './LearningVocabularyManager'
import type { LearningProgress } from './types'
import type { OralCodeResult } from './types'
import type { LearningMatchResult } from './LearningAsrBridge'
import type { LearningContentType, LearningTtsNeed, LearningTtsContent } from './LearningTtsContract'
import { CONTENT_TYPE_TTS_NEED_MAP, getContentTypeRoutingWeights } from './LearningTtsContract'

// ══════════════════════════════════════════
//  内容构建器 — 将学习事件/数据转换为结构化 TTS 内容
// ══════════════════════════════════════════

/**
 * 从学习进度数据构建 TTS 内容。
 *
 * @param progress - 学习进度
 * @returns 播报学习进度的结构化 TTS 内容
 */
function buildProgressContent(progress: LearningProgress): LearningTtsContent {
  const overallPercent = Math.round(progress.overallMastery * 100)
  const weakCategories = progress.categorySummary.filter((c) => c.avgMastery < 0.6).slice(0, 3)

  const parts: string[] = [
    `TypeScript 学习进度：`,
    `共 ${progress.totalItems} 个知识点，`,
    `已掌握 ${progress.masteredCount} 个，`,
    `总体掌握率 ${overallPercent}%。`,
  ]

  if (progress.totalAttempts > 0) {
    const accuracy = Math.round((progress.totalCorrect / progress.totalAttempts) * 100)
    parts.push(`练习正确率 ${accuracy}%。`)
  }

  if (weakCategories.length > 0) {
    parts.push(`需要加强的领域：${weakCategories.map((c) => c.category).join('、')}。`)
  }

  return {
    primaryText: parts.join(''),
    emphasis: weakCategories.map((c) => c.category),
    masteryInfo: {
      current: overallPercent,
      target: 80,
    },
  }
}

/**
 * 从步骤完成事件构建 TTS 内容。
 *
 * @param stepDescription - 步骤描述
 * @param success - 是否成功
 * @param conceptName - 可选的知识点名称
 * @returns 播报步骤反馈的结构化 TTS 内容
 */
function buildStepFeedbackContent(stepDescription: string, success: boolean, conceptName?: string): LearningTtsContent {
  const maxLen = 60
  const truncated = stepDescription.length > maxLen ? stepDescription.slice(0, maxLen) + '…' : stepDescription

  if (success) {
    return {
      primaryText: `完成了步骤：${truncated}。做得不错，继续加油！`,
      conceptName,
      emphasis: conceptName ? [conceptName] : undefined,
    }
  }

  const encouragement = ['没关系，再试一次。', '遇到困难是学习的一部分。']

  return {
    primaryText: `步骤没有通过：${truncated}。${encouragement[Math.floor(Math.random() * encouragement.length)]}`,
    secondaryText: conceptName ? `建议复习知识点「${conceptName}」。` : '建议回顾当前分类的基础概念。',
    conceptName,
    emphasis: conceptName ? [conceptName] : undefined,
  }
}

/**
 * 从知识点查询结果构建 TTS 内容。
 *
 * @param matchResult - LearningAsrBridge 的匹配结果
 * @returns 播报知识点解释的结构化 TTS 内容
 */
function buildExplanationContent(matchResult: LearningMatchResult): LearningTtsContent {
  if (!matchResult.matched || matchResult.items.length === 0) {
    return {
      primaryText: matchResult.explanation || `关于「${matchResult.query}」没有找到匹配的知识点。`,
    }
  }

  const item = matchResult.items[0]
  const masteryPercent = Math.round(item.mastery * 100)

  return {
    primaryText: matchResult.explanation.split('。')[0] + '。',
    secondaryText: masteryPercent < 100 ? `你当前掌握度为 ${masteryPercent}%，建议多练习这个知识点。` : undefined,
    conceptName: item.name,
    category: item.category,
    emphasis: [item.name],
    masteryInfo: {
      current: masteryPercent,
      target: 80,
    },
  }
}

/**
 * 从口述代码结果构建 TTS 内容。
 *
 * 支持代码朗读模式：将代码按行分段，标记停顿位置。
 *
 * @param result - OralCodeService 的生成结果
 * @returns 播报代码的结构化 TTS 内容（带停顿位置）
 */
function buildCodeReadingContent(result: OralCodeResult): LearningTtsContent {
  if (!result.success) {
    return {
      primaryText: result.explanation || '无法生成代码。',
    }
  }

  // 按行分割代码，计算停顿位置（每行末尾）
  const codeLines = result.code.split('\n')
  const pausePositions: number[] = []
  let charPos = 0
  for (const line of codeLines) {
    charPos += line.length + 1 // +1 换行符
    if (line.trim() && !line.trim().startsWith('//')) {
      pausePositions.push(charPos)
    }
  }

  return {
    primaryText: result.explanation,
    secondaryText: `生成的代码类型：${result.label}。`,
    codeSnippet: result.code,
    conceptName: result.label,
    pausePositions: pausePositions.slice(0, 10), // 最多 10 个停顿点
    emphasis: [result.label],
  }
}

/**
 * 从困难记录构建鼓励 TTS 内容。
 *
 * @param conceptName - 困难的知识点名称
 * @param description - 困难描述
 * @param frequency - 已出错的次数
 * @returns 鼓励性 TTS 内容
 */
function buildEncouragementContent(conceptName: string, description: string, frequency: number): LearningTtsContent {
  const encouragements = [
    `「${conceptName}」确实有些难度，这很正常。`,
    `「${conceptName}」是 TypeScript 中的重要概念，多练习几次就能掌握。`,
  ]

  if (frequency >= 3) {
    return {
      primaryText: `${encouragements[0]}你已经遇到 ${frequency} 次困难了，建议换一种学习方式，比如先看看基础概念再回来。`,
      conceptName,
      emphasis: [conceptName],
    }
  }

  return {
    primaryText: `在「${conceptName}」上遇到了困难：${description.slice(0, 80)}。${encouragements[1]}`,
    conceptName,
    emphasis: [conceptName],
  }
}

/**
 * 从学习关注焦点构建 TTS 内容。
 *
 * @param focusCategories - 关注分类列表
 * @param recentConcepts - 最近遇到的知识点
 * @returns 当前关注焦点的结构化 TTS 内容
 */
function buildFocusContent(focusCategories: string[], recentConcepts: string[]): LearningTtsContent {
  const parts: string[] = []

  if (focusCategories.length > 0) {
    parts.push(`当前重点关注：${focusCategories.join('、')}。`)
  }

  if (recentConcepts.length > 0) {
    const recentStr = recentConcepts.slice(0, 5).join('、')
    parts.push(`最近学到的知识点：${recentStr}。`)
  }

  if (parts.length === 0) {
    parts.push('当前没有活跃的学习关注点。')
  }

  return {
    primaryText: parts.join(''),
    emphasis: focusCategories.length > 0 ? focusCategories : undefined,
  }
}

// ══════════════════════════════════════════
//  LearningTtsAdapter
// ══════════════════════════════════════════

export class LearningTtsAdapter {
  /**
   * 从学习进度构建 TTS 需求。
   * 适合 ChatExecutor 定时播报学习进度。
   *
   * @param progress - 学习进度
   * @returns 进度报告的 LearningTtsNeed
   */
  buildProgressNeed(progress: LearningProgress): LearningTtsNeed {
    const defaults = CONTENT_TYPE_TTS_NEED_MAP.progress
    return {
      contentType: 'progress',
      outputMode: defaults.outputMode,
      priority: defaults.priority,
      faultTolerance: defaults.faultTolerance,
      content: buildProgressContent(progress),
      reason: '学习进度报告播报',
    }
  }

  /**
   * 从步骤完成事件构建 TTS 需求。
   * 适合 PlanTypeScriptExecutor.onPlanStepCompleted() 后调用。
   *
   * @param stepDescription - 步骤描述
   * @param success - 是否成功
   * @param conceptName - 可选的知识点名称
   * @returns 反馈类型的 LearningTtsNeed
   */
  buildStepFeedbackNeed(stepDescription: string, success: boolean, conceptName?: string): LearningTtsNeed {
    const defaults = CONTENT_TYPE_TTS_NEED_MAP.feedback
    return {
      contentType: 'feedback',
      outputMode: defaults.outputMode,
      priority: defaults.priority,
      faultTolerance: defaults.faultTolerance,
      content: buildStepFeedbackContent(stepDescription, success, conceptName),
      reason: `学习步骤${success ? '完成' : '失败'}反馈`,
    }
  }

  /**
   * 从知识点查询结果构建 TTS 需求。
   * 适合 LearningAsrBridge.matchQuery() 后调用。
   *
   * @param matchResult - ASR 查询匹配结果
   * @returns 解释类型的 LearningTtsNeed
   */
  buildExplanationNeed(matchResult: LearningMatchResult): LearningTtsNeed {
    const defaults = CONTENT_TYPE_TTS_NEED_MAP.explanation
    return {
      contentType: 'explanation',
      outputMode: defaults.outputMode,
      priority: defaults.priority,
      faultTolerance: defaults.faultTolerance,
      content: buildExplanationContent(matchResult),
      reason: '学习知识点解释播报',
    }
  }

  /**
   * 从口述代码构建 TTS 需求（代码朗读模式）。
   * 适合 OralCodeService.process() 后调用。
   *
   * @param result - 口述代码生成结果
   * @returns 代码朗读类型的 LearningTtsNeed
   */
  buildCodeReadingNeed(result: OralCodeResult): LearningTtsNeed {
    const defaults = CONTENT_TYPE_TTS_NEED_MAP.code_reading
    return {
      contentType: 'code_reading',
      outputMode: defaults.outputMode,
      priority: defaults.priority,
      faultTolerance: defaults.faultTolerance,
      content: buildCodeReadingContent(result),
      reason: `口述代码播报：${result.label}`,
    }
  }

  /**
   * 从困难记录构建 TTS 需求（鼓励类型）。
   * 适合 PlanTypeScriptExecutor.recordDifficulty() 后调用。
   *
   * @param conceptName - 困难的知识点名称
   * @param description - 困难描述
   * @param frequency - 已出错的次数
   * @returns 鼓励类型的 LearningTtsNeed
   */
  buildEncouragementNeed(conceptName: string, description: string, frequency: number): LearningTtsNeed {
    const defaults = CONTENT_TYPE_TTS_NEED_MAP.encouragement
    return {
      contentType: 'encouragement',
      outputMode: defaults.outputMode,
      priority: defaults.priority,
      faultTolerance: defaults.faultTolerance,
      content: buildEncouragementContent(conceptName, description, frequency),
      reason: `学习困难鼓励播报（${conceptName}，已出错 ${frequency} 次）`,
    }
  }

  /**
   * 从关注焦点构建 TTS 需求。
   * 适合 PlanTypeScriptExecutor.syncFocusContext() 后调用。
   *
   * @param focusCategories - 关注分类列表
   * @param recentConcepts - 最近遇到的知识点
   * @returns 教学/提示类型的 LearningTtsNeed
   */
  buildFocusNeed(focusCategories: string[], recentConcepts: string[]): LearningTtsNeed {
    const defaults = CONTENT_TYPE_TTS_NEED_MAP.teaching
    return {
      contentType: 'teaching',
      outputMode: defaults.outputMode,
      priority: defaults.priority,
      faultTolerance: defaults.faultTolerance,
      content: buildFocusContent(focusCategories, recentConcepts),
      reason: '学习关注焦点播报',
    }
  }

  /**
   * 获取当前学习计划摘要的 TTS 需求。
   * 从 LearningVocabularyManager 读取实时数据构建。
   *
   * @returns 进度报告的 LearningTtsNeed
   */
  buildSummaryNeed(): LearningTtsNeed {
    const progress = learningVocabularyManager.getProgress()
    return this.buildProgressNeed(progress)
  }

  /**
   * 将 LearningTtsNeed 简化为纯文本（用于后备方案或日志）。
   */
  toPlainText(need: LearningTtsNeed): string {
    const parts = [need.content.primaryText]
    if (need.content.secondaryText) {
      parts.push(need.content.secondaryText)
    }
    return parts.join(' ')
  }

  /**
   * 获取 LearningTtsNeed 的路由权重（质量/延迟权衡）。
   * ChatExecutor 可在设置 ttsService 路由权重时参考此值。
   */
  getRoutingWeights(need: LearningTtsNeed): { qualityWeight: number; latencyWeight: number } {
    return getContentTypeRoutingWeights(need.contentType)
  }
}

/** 全局单例 */
export const learningTtsAdapter = new LearningTtsAdapter()
