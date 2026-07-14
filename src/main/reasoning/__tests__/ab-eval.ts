/**
 * PromptBuilder A/B Evaluation Script
 *
 * Compares old and new PromptBuilder output for the same input.
 * Evaluates 4 dimensions on 1-5 scale without knowing which is which.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { plan } from '../ReasoningPlanner'
import { translate as translateOld } from '../../llm/PromptBuilder'

// Capture the file at a known state — we need the NEW version too
import type { ReasoningDirective, ThinkingPattern, OutputStyle, ReasoningContext } from '../types'

// New prompt templates (from current file)
const PATTERN_PROMPTS_NEW: Record<string, string> = {
  cause_effect: '按因果分析结构组织回复：先给出分析对象或现象定义，然后分解影响因素，再梳理因果关系链，最后得出结论。',
  hypothesis_verification: '按假设验证结构组织回复：明确当前现象，提出可能原因作为假设，逐一验证或排除，最后给出结论。',
  option_evaluation: '按决策分析结构组织回复：明确决策目标和评估标准，列出候选方案，逐项对比权衡利弊，最后给出推荐和适用条件。',
  goal_constraint_tradeoff: '按方案评估结构组织回复：明确目标和约束条件，列出可行方案，分析各方案的利弊与风险，给出推荐及其依据。',
  default: '',
}

// Old prompt templates
const PATTERN_PROMPTS_OLD: Record<string, string> = {
  cause_effect: '分析因果关系：先明确前因后果链，再给出结论。',
  hypothesis_verification: '按假设验证框架分析：现象 → 假设 → 验证依据 → 结论。',
  option_evaluation: '在约束下比较各选项：明确评估标准 → 逐项对比 → 给出推荐。',
  goal_constraint_tradeoff: '按目标约束分析：明确目标和限制 → 列出方案 → 权衡利弊 → 推荐。',
  default: '',
}

const STYLE_PROMPTS: Record<string, string> = {
  causal_narrative: '按因果顺序叙述，说明每一步推导的依据。',
  structured_comparison: '结构化对比，让差异一目了然。',
  conclusion_first: '先给出结论，再展开分析过程。',
  default: '',
}

function buildPrompt(version: 'old' | 'new', directive: ReasoningDirective): string {
  const prompts = version === 'old' ? PATTERN_PROMPTS_OLD : PATTERN_PROMPTS_NEW
  if (!directive.pattern || directive.pattern === 'default') return ''
  const parts: string[] = []
  const patternText = prompts[directive.pattern]
  if (patternText) parts.push(patternText)
  const styleText = STYLE_PROMPTS[directive.outputStyle]
  if (styleText) parts.push(styleText)
  if (directive.constraints.length > 0) {
    for (const c of directive.constraints) {
      parts.push(c.description)
    }
  }
  return `【推理框架】${parts.join('')}`
}

// SAMPLE: 12 cases, 3 per pattern
// Analysis: 3
// Decision: 3
// Planning: 3
// Creation: 3
const SAMPLES: Array<{ id: string; text: string }> = [
  { id: 'A-Q04', text: '为什么用 Rust 写系统软件比 C 更安全？' },
  { id: 'A-Q06', text: 'Guardrail Coverage 为什么会这么低？' },
  { id: 'A-Q08', text: '这个性能瓶颈在什么条件下会出现？' },
  { id: 'D-D01', text: 'PostgreSQL 还是 SQLite？' },
  { id: 'D-D05', text: '用微服务还是单体架构？' },
  { id: 'D-D08', text: '你觉得我们应该重构这部分代码吗？' },
  { id: 'P-P01', text: '怎么实现这个功能？' },
  { id: 'P-P02', text: '如何从单体迁移到微服务？' },
  { id: 'P-P10', text: '如何保证这次上线不出问题？' },
  { id: 'C-C03', text: '这个 API 的 README 应该怎么写？' },
  { id: 'C-C07', text: '画一个架构图来描述这个系统' },
  { id: 'C-C09', text: '给这个模块写一个测试计划' },
]

console.log('\n=== A/B Prompt Evaluation ===\n')
console.log('Sampled 12 cases (3 per pattern)\n')
console.log('Blind comparison — do NOT look at version label during evaluation\n')

for (const sample of SAMPLES) {
  const ctx: ReasoningContext = { input: { text: sample.text } }
  const directive = plan(ctx)
  const promptA = buildPrompt('old', directive)
  const promptB = buildPrompt('new', directive)

  const pattern = directive.pattern ?? '(none)'
  console.log(`--- ${sample.id} [${pattern}] "${sample.text}" ---`)
  console.log(`A: ${promptA}`)
  console.log(`B: ${promptB}`)
  console.log(`  Logic(1-5)    A:___  B:___`)
  console.log(`  Completeness(1-5) A:___  B:___`)
  console.log(`  Actionable(1-5)   A:___  B:___`)
  console.log(`  Natural(1-5)      A:___  B:___`)
  console.log(`  Better? A/B/Same  Reason:`)
  console.log()
}

console.log('=== A/B Prompt Evaluation Complete ===')
