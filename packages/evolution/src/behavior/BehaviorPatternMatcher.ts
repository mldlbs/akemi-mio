/**
 * BehaviorPatternMatcher — 行为模式前件匹配与对话预加载
 *
 * ## 职责
 * 1. 在对话流中检测用户输入是否匹配已有行为规则的前件（antecedent）
 * 2. 匹配成功后提供后件（consequent）的预测上下文
 * 3. 记录匹配命中以增强规则置信度
 *
 * ## 工作流程
 *   MemoryService.recordInteraction(userText)
 *     → BehaviorPatternMatcher.match(userText)
 *       → 扫描 BehaviorPatternStore 中的活跃规则
 *       → 若 userText 包含规则的 antecedent 关键词
 *         → 记录匹配 (recordMatch)
 *         → 返回匹配结果（含 consequent 和概率）
 *     → MemoryService.getFormattedContext()
 *       → BehaviorPatternMatcher.getPredictionContext()
 *         → 格式化匹配结果为 system prompt 注入文本
 *
 * ## 匹配算法
 * - 精确匹配：用户输入直接包含规则 antecedent 关键词
 * - 模糊匹配：用户输入的主题标签与 antecedent 匹配
 * - 多规则匹配时按置信度降序排列，取 Top-K
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { BehaviorPatternStore, behaviorPatternStore as _sharedStore, type BehaviorPatternRule } from './BehaviorPatternStore'
import { BEHAVIOR_PATTERN_MATCH_MIN_CONFIDENCE, BEHAVIOR_PATTERN_MATCH_MAX_RESULTS } from '@akemi-mio/core/config'

// ══════════════════════════════════════════
//  话题 → 关键词映射（与 Miner 共享的匹配表）
// ══════════════════════════════════════════

const TOPIC_KEYWORDS: Record<string, string[]> = {
  天气: ['天气', '温度', '下雨', '下雪', '刮风', '晴', '阴', '台风', '气温', '预报'],
  时间: ['时间', '几点', '现在', '日期', '今天', '明天', '昨天', '星期', '月份', '钟'],
  新闻: ['新闻', '时事', '报道', '最新', '热点', '头条', '消息'],
  编程: ['代码', '编程', '写代码', 'bug', '调试', '重构', '算法', '编译', '部署', '程序'],
  写作: ['写', '文章', '内容', '创作', '文案', '文本', '文档', '编辑'],
  学习: ['学习', '教程', '教学', '课程', '练习', '理解', '概念'],
  翻译: ['翻译', '英文', '中文', '语言', '外语', '意思'],
  图片: ['图片', '图像', '照片', '画画', '生成图', '画图', '设计图'],
  音乐: ['音乐', '歌', '播放', '曲', '旋律', '歌词'],
  视频: ['视频', '播放', '看', '电影', '剧', '短视频'],
  搜索: ['搜索', '查找', '找', '查询', '搜一下'],
  设置: ['设置', '配置', '修改', '调整', '更改', '选项'],
  帮助: ['帮助', '怎么', '如何', '能不能', '可以吗', '怎样'],
  推荐: ['推荐', '建议', '什么好', '选择', '推'],
}

// ══════════════════════════════════════════
//  常量
// ══════════════════════════════════════════

const DEFAULT_MIN_CONFIDENCE = 0.3 // 匹配的最小置信度
const DEFAULT_MAX_RESULTS = 3 // 每次最多返回的匹配结果数

// ══════════════════════════════════════════
//  匹配结果类型
// ══════════════════════════════════════════

export interface MatchedPattern {
  /** 匹配的规则 */
  rule: BehaviorPatternRule
  /** 匹配方式 */
  matchType: 'exact' | 'fuzzy'
  /** 匹配得分 (0-1) */
  score: number
  /** 是否应该主动提示用户 */
  suggestProactive: boolean
}

// ══════════════════════════════════════════
//  BehaviorPatternMatcher
// ══════════════════════════════════════════

export class BehaviorPatternMatcher {
  private store: BehaviorPatternStore
  private minConfidence: number
  private maxResults: number

  constructor(
    store: BehaviorPatternStore,
    config?: {
      minConfidence?: number
      maxResults?: number
    },
  ) {
    this.store = store
    this.minConfidence = config?.minConfidence ?? BEHAVIOR_PATTERN_MATCH_MIN_CONFIDENCE ?? DEFAULT_MIN_CONFIDENCE
    this.maxResults = config?.maxResults ?? BEHAVIOR_PATTERN_MATCH_MAX_RESULTS ?? DEFAULT_MAX_RESULTS
  }

  // ══════════════════════════════════════════
  //  核心匹配 API
  // ══════════════════════════════════════════

  /**
   * 匹配用户输入文本与行为规则的前件。
   *
   * @param userText 用户输入的文本
   * @returns 按匹配得分降序排列的匹配结果
   */
  match(userText: string): MatchedPattern[] {
    if (!userText || userText.trim().length === 0) return []

    const activeRules = this.store.getActive(this.minConfidence)
    if (activeRules.length === 0) return []

    const lowerText = userText.toLowerCase()
    const results: MatchedPattern[] = []

    for (const rule of activeRules) {
      const matchResult = this.evaluateMatch(rule, lowerText, userText)
      if (matchResult) {
        results.push(matchResult)
      }
    }

    // 按得分降序排列
    results.sort((a, b) => b.score - a.score)

    // 取 Top-K
    const top = results.slice(0, this.maxResults)

    // 记录命中
    for (const match of top) {
      this.store.recordMatch(match.rule.id)
    }

    if (top.length > 0) {
      log('INFO', 'behavior_pattern_matched', {
        userText: userText.slice(0, 50),
        matches: top.map((m) => `${m.rule.antecedent}→${m.rule.consequent}(${(m.score * 100).toFixed(0)}%)`),
      })
    }

    return top
  }

  /**
   * 获取预测上下文的格式化文本（用于注入 system prompt）。
   * 基于匹配结果生成自然语言提示。
   *
   * @param matches 匹配结果（由 match() 返回）
   * @returns 格式化上下文文本，空字符串表示无内容
   */
  getPredictionContext(matches: MatchedPattern[]): string {
    if (matches.length === 0) return ''

    const lines: string[] = ['---', '【行为模式预测】根据历史行为模式，用户可能接下来会：']

    for (const match of matches) {
      const prob = (match.rule.probability * 100).toFixed(0)
      const confidence = (match.rule.confidence * 100).toFixed(0)

      lines.push(`- 提到「${match.rule.consequent}」相关（概率 ${prob}%，置信度 ${confidence}%）`)
    }

    lines.push('你可以提前准备相关信息，或在适当时机主动询问是否需要帮助。', '---')

    return lines.join('\n')
  }

  /**
   * 获取主动建议文本（用于 Agent 在回复中包含主动提问）。
   * 仅对高置信度、高概率的匹配触发主动建议。
   *
   * @param matches 匹配结果
   * @returns 主动建议文本，空表示不建议主动提问
   */
  getProactiveSuggestions(matches: MatchedPattern[]): string {
    const proactive = matches.filter((m) => m.suggestProactive && m.rule.probability >= 0.5)
    if (proactive.length === 0) return ''

    const lines: string[] = ['【主动建议】以下行为模式概率较高，可考虑主动询问：']

    for (const match of proactive) {
      lines.push(
        `- 用户提到「${match.rule.antecedent}」后，有 ${(match.rule.probability * 100).toFixed(0)}% 可能关注「${match.rule.consequent}」，可以询问是否需要帮助`,
      )
    }

    return lines.join('\n')
  }

  /** 获取当前匹配器统计 */
  getStats(): { activeRules: number; minConfidence: number } {
    return {
      activeRules: this.store.getActive(this.minConfidence).length,
      minConfidence: this.minConfidence,
    }
  }

  // ══════════════════════════════════════════
  //  内部匹配逻辑
  // ══════════════════════════════════════════

  /**
   * 评估单条规则是否匹配用户输入。
   * 使用两级匹配策略：
   * 1. 精确匹配：用户文本直接包含 antecedent 关键词
   * 2. 模糊匹配：通过话题-关键词映射表检查
   */
  private evaluateMatch(rule: BehaviorPatternRule, lowerText: string, _originalText: string): MatchedPattern | null {
    const antecedent = rule.antecedent.toLowerCase()

    // 1. 精确匹配：文本直接包含 antecedent 关键词
    if (lowerText.includes(antecedent)) {
      const score = rule.confidence * rule.probability
      return {
        rule,
        matchType: 'exact',
        score: Math.round(score * 100) / 100,
        suggestProactive: rule.confidence >= 0.5 && rule.probability >= 0.45,
      }
    }

    // 2. 模糊匹配：通过话题关键词表匹配
    const topicKeywords = TOPIC_KEYWORDS[rule.antecedent]
    if (topicKeywords) {
      for (const keyword of topicKeywords) {
        if (lowerText.includes(keyword)) {
          // 模糊匹配的分数打 8 折
          const score = rule.confidence * rule.probability * 0.8
          return {
            rule,
            matchType: 'fuzzy',
            score: Math.round(score * 100) / 100,
            suggestProactive: false, // 模糊匹配不做主动建议
          }
        }
      }
    }

    return null
  }
}

// ══════════════════════════════════════════
//  全局单例
// ══════════════════════════════════════════

export const behaviorPatternMatcher = new BehaviorPatternMatcher(_sharedStore)
