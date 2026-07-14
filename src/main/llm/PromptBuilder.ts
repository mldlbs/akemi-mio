/**
 * PromptBuilder — LLM 层模型适配翻译器
 *
 * 职责：
 *  将 ReasoningDirective 翻译为当前模型可以理解的 Prompt 段落。
 *  更换模型时只需要修改此文件，不需要修改 ReasoningPlanner。
 *
 * 设计原则：
 *  - 纯翻译，不做推理决策
 *  - 输出简短的约束性说明，不堆砌规则
 *  - 位于 LLM 层，Reasoning 层不包含任何 Prompt 概念
 */

import type { ReasoningDirective, ThinkingPattern, OutputStyle } from '../reasoning/types'

/** Pattern 到中文指导语的映射 */
const PATTERN_PROMPTS: Record<ThinkingPattern, string> = {
  cause_effect: '分析因果关系：先明确前因后果链，再给出结论。',
  hypothesis_verification: '按假设验证框架分析：现象 → 假设 → 验证依据 → 结论。',
  option_evaluation: '在约束下比较各选项：明确评估标准 → 逐项对比 → 给出推荐。',
  goal_constraint_tradeoff: '按目标约束分析：明确目标和限制 → 列出方案 → 权衡利弊 → 推荐。',
  none: '',
}

/** OutputStyle 到中文风格指导语的映射 */
const STYLE_PROMPTS: Record<OutputStyle, string> = {
  causal_narrative: '按因果顺序叙述，说明每一步推导的依据。',
  structured_comparison: '结构化对比，让差异一目了然。',
  conclusion_first: '先给出结论，再展开分析过程。',
  default: '',
}

/**
 * 翻译 Directive 为 Prompt 段落。
 *
 * @param directive ReasoningPlanner 生成的推理指令
 * @returns 可以注入到 system prompt 的文本片段，空字符串表示无特殊要求
 */
export function translate(directive: ReasoningDirective): string {
  const { pattern, goals, constraints, outputStyle } = directive
  if (pattern === 'none' && outputStyle === 'default') return ''

  const parts: string[] = []

  const patternText = PATTERN_PROMPTS[pattern]
  if (patternText) parts.push(patternText)

  const styleText = STYLE_PROMPTS[outputStyle]
  if (styleText) parts.push(styleText)

  if (constraints.length > 0) {
    for (const c of constraints) {
      parts.push(c.description)
    }
  }

  return `【推理框架】${parts.join('')}`
}
