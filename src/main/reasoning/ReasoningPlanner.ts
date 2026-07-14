/**
 * ReasoningPlanner — 推理规划器
 *
 * 职责：
 *  输入：当前用户的 intent + context
 *  输出：ReasoningDirective（纯数据契约）
 *
 * 设计原则：
 *  - 纯规则引擎，不调用 LLM
 *  - 每次只输出一个 Directive
 *  - 不可用时返回 EMPTY_DIRECTIVE，调用方自行降级
 */

import { log } from '../logger/Logger'
import type { ReasoningDirective, ThinkingPattern } from './types'
import { EMPTY_DIRECTIVE } from './types'

export interface PlannerInput {
  /** 用户消息原文 */
  text: string
  /** 内容分类（code / writing / evolution / qa / chat） */
  category?: string
  /** 当前场景标签（由 UserBehaviorAnalyzer 提供） */
  scene?: string
}

/**
 * 分类文本对应的思维模式映射。
 * 纯规则匹配，无 LLM 调用。
 */
function classifyPattern(input: PlannerInput): ThinkingPattern {
  const { text, category, scene } = input

  // 优先级 1：场景标签透传（场景分析器已做语义理解）
  if (scene === 'deep_discussion') return 'goal_constraint_tradeoff'
  if (scene === 'analysis') return 'cause_effect'
  if (scene === 'decision') return 'option_evaluation'

  // 优先级 2：基于 category 分类
  if (category === 'code' || category === 'evolution') {
    if (text.length < 15) return 'none'
    return 'goal_constraint_tradeoff'
  }

  // 优先级 3：关键词规则匹配
  const whyPatterns = /为什么|为何|原因|根因|cause|root.reason|why\s/
  const comparePatterns = /比较|对比|区别|vs|or|哪个好|选哪个|compari|difference/
  const evaluatePatterns = /评估|评价|怎么样|值得|优缺点|trade.?off|pro.?con/
  const hypothesisPatterns = /是不是|会不会|可能|假设|猜测|suspect|hypothesis/

  if (whyPatterns.test(text)) return 'cause_effect'
  if (comparePatterns.test(text)) return 'option_evaluation'
  if (evaluatePatterns.test(text)) return 'goal_constraint_tradeoff'
  if (hypothesisPatterns.test(text)) return 'hypothesis_verification'

  return 'none'
}

/**
 * 根据思维模式推导推理目标和约束。
 */
function deriveDirective(pattern: ThinkingPattern, _input: PlannerInput): ReasoningDirective {
  switch (pattern) {
    case 'cause_effect':
      return {
        pattern,
        goals: [{ type: 'identify_root_cause' }, { type: 'explain_causality' }],
        constraints: [],
        outputStyle: 'causal_narrative',
      }

    case 'hypothesis_verification':
      return {
        pattern,
        goals: [{ type: 'explain_causality' }],
        constraints: [{ type: 'assumption', description: '列出关键假设后再验证' }],
        outputStyle: 'causal_narrative',
      }

    case 'option_evaluation':
      return {
        pattern,
        goals: [{ type: 'compare_options' }, { type: 'evaluate_tradeoffs' }],
        constraints: [{ type: 'scope', description: '在明确的标准下比较' }],
        outputStyle: 'structured_comparison',
      }

    case 'goal_constraint_tradeoff':
      return {
        pattern,
        goals: [{ type: 'evaluate_tradeoffs' }, { type: 'provide_recommendation' }],
        constraints: [{ type: 'priority', description: '先明确目标和约束再分析方案' }],
        outputStyle: 'conclusion_first',
      }

    default:
      return EMPTY_DIRECTIVE
  }
}

/**
 * 推理入口：根据用户输入生成 ReasoningDirective。
 *
 * 纯同步，无 LLM 调用。
 * 返回 EMPTY_DIRECTIVE 时调用方应继续原逻辑。
 */
export function plan(input: PlannerInput): ReasoningDirective {
  const pattern = classifyPattern(input)
  const directive = deriveDirective(pattern, input)

  if (pattern !== 'none') {
    log('INFO', 'reasoning_planned', {
      pattern,
      text: input.text.slice(0, 60),
      category: input.category ?? 'unknown',
    })
  }

  return directive
}
