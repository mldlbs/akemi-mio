/**
 * ReasoningPlanner v2 — 评分式推理规划器
 * 输入：ReasoningContext（用户输入+对话快照）
 * 输出：ReasoningDirective（纯数据契约）
 * 评分制替代"首个命中即返回"，保留评分明细便于调试
 * 纯函数，不调用LLM/Tool/Memory/Network
 */

import { log } from './runtime'
import type { ReasoningDirective, ThinkingPattern, ReasoningContext } from './types'
import { EMPTY_DIRECTIVE } from './types'

interface ScoringFactor {
  tag: string
  pattern: ThinkingPattern
  score: number
  matcher: (input: ReasoningContext) => boolean
}

const FACTORS: ScoringFactor[] = [
  { tag: 'scene:deep_discussion', pattern: 'goal_constraint_tradeoff', score: 5, matcher: (ctx) => ctx.input.scene === 'deep_discussion' },
  { tag: 'scene:analysis', pattern: 'cause_effect', score: 5, matcher: (ctx) => ctx.input.scene === 'analysis' },
  { tag: 'scene:decision', pattern: 'option_evaluation', score: 5, matcher: (ctx) => ctx.input.scene === 'decision' },
  {
    tag: 'cat:code_long',
    pattern: 'goal_constraint_tradeoff',
    score: 3,
    matcher: (ctx) => ['code', 'evolution'].includes(ctx.input.category ?? '') && (ctx.input.text?.length ?? 0) >= 15,
  },
  {
    tag: 'why_question',
    pattern: 'cause_effect',
    score: 3,
    matcher: (ctx) => /为什么|为何|原因|根因|cause|root.reason|why\s/.test(ctx.input.text ?? ''),
  },
  {
    tag: 'explain_trigger',
    pattern: 'cause_effect',
    score: 2,
    matcher: (ctx) =>
      /怎么回事|怎么产生|触发条件|工作原理|如何工作|explain|how\s+(does|to|do|can|would|is)|解决了什么|是什么/.test(ctx.input.text ?? ''),
  },
  { tag: 'condition_analysis', pattern: 'cause_effect', score: 2, matcher: (ctx) => /在什么条件|什么情况下/.test(ctx.input.text ?? '') },
  {
    tag: 'comparison',
    pattern: 'option_evaluation',
    score: 3,
    matcher: (ctx) => /比较|对比|区别|compari|difference|比\s+\S+\s+好/.test(ctx.input.text ?? ''),
  },
  {
    tag: 'choose_question',
    pattern: 'option_evaluation',
    score: 3,
    matcher: (ctx) => /[\w一-龥]+\s*还是\s*[一-龥\w]+|选择|选哪个|推荐|reco(mmend)?/.test(ctx.input.text ?? ''),
  },
  {
    tag: 'tradeoff_question',
    pattern: 'goal_constraint_tradeoff',
    score: 2,
    matcher: (ctx) => /优缺点|pro.?con|trade.?off|利.?弊/.test(ctx.input.text ?? ''),
  },
  { tag: 'suitability', pattern: 'option_evaluation', score: 2, matcher: (ctx) => /更适合|更合适|哪个数据库/.test(ctx.input.text ?? '') },
  {
    tag: 'evaluate',
    pattern: 'goal_constraint_tradeoff',
    score: 3,
    matcher: (ctx) => /评估|评价|怎么样|值得|升级|方案|approach|migrate/.test(ctx.input.text ?? ''),
  },
  {
    tag: 'analysis_request',
    pattern: 'goal_constraint_tradeoff',
    score: 2,
    matcher: (ctx) => /分析|analy|review|audit|check/.test(ctx.input.text ?? ''),
  },
  { tag: 'should_decision', pattern: 'goal_constraint_tradeoff', score: 2, matcher: (ctx) => /应该/.test(ctx.input.text ?? '') },
  {
    tag: 'hypothesis',
    pattern: 'hypothesis_verification',
    score: 3,
    matcher: (ctx) => /是不是|会不会|可能|假设|猜测|suspect|hypothesis/.test(ctx.input.text ?? ''),
  },
  {
    tag: 'debug',
    pattern: 'hypothesis_verification',
    score: 2,
    matcher: (ctx) => /报错|出错|崩溃|异常|bug|fail|error|crash/.test(ctx.input.text ?? ''),
  },
  {
    tag: 'planning',
    pattern: 'goal_constraint_tradeoff',
    score: 2,
    matcher: (ctx) => /步骤|流程|怎么实现|如何.*(做|迁移|保证|部署|设计|给)|工作计划|计划|step|plan|roadmap/.test(ctx.input.text ?? ''),
  },
  {
    tag: 'implementation',
    pattern: 'goal_constraint_tradeoff',
    score: 2,
    matcher: (ctx) => /怎样设计|从哪里开始|实施|迁移步骤|需要做.*准备|添加.*CI|部署.*准备/.test(ctx.input.text ?? ''),
  },
]

const SCENE_OVERRIDE: Record<string, ThinkingPattern | undefined> = {
  deep_discussion: 'goal_constraint_tradeoff',
  analysis: 'cause_effect',
  decision: 'option_evaluation',
}

export interface ScoringDetail {
  scores: Record<string, number>
  hits: Array<{ tag: string; pattern: string; score: number }>
  overriddenByScene?: string
  selected?: ThinkingPattern
}

function scorePatterns(input: ReasoningContext): ScoringDetail {
  const scores: Record<string, number> = {}
  const hits: Array<{ tag: string; pattern: string; score: number }> = []
  for (const f of FACTORS) {
    if (f.matcher(input)) {
      const key = f.pattern
      scores[key] = (scores[key] ?? 0) + f.score
      hits.push({ tag: f.tag, pattern: key, score: f.score })
    }
  }
  const detail: ScoringDetail = { scores, hits }
  if (input.input.scene && SCENE_OVERRIDE[input.input.scene]) {
    detail.overriddenByScene = input.input.scene
  }
  return detail
}

function selectPattern(detail: ScoringDetail, input: ReasoningContext): ThinkingPattern | undefined {
  if (input.input.scene && SCENE_OVERRIDE[input.input.scene]) return SCENE_OVERRIDE[input.input.scene]
  const entries = Object.entries(detail.scores) as [ThinkingPattern, number][]
  if (entries.length === 0) return undefined
  entries.sort((a, b) => b[1] - a[1])
  if (entries[0][1] < 2) return undefined
  return entries[0][0]
}

function deriveDirective(pattern: ThinkingPattern | undefined): ReasoningDirective {
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

export function plan(input: ReasoningContext): ReasoningDirective {
  const detail = scorePatterns(input)
  const pattern = selectPattern(detail, input)
  const directive = deriveDirective(pattern)
  if (pattern) {
    detail.selected = pattern
    log('INFO', 'reasoning_planned', {
      pattern,
      score: detail.scores[pattern] ?? 0,
      hits: detail.hits.map((h) => h.tag).join(','),
      overriddenByScene: detail.overriddenByScene,
      text: input.input.text.slice(0, 60),
    })
  }
  if (detail.hits.length > 0) {
    log('DEBUG', 'reasoning_scoring', { scores: detail.scores, hitCount: detail.hits.length, selected: pattern ?? 'none' })
  }
  return directive
}

export function score(input: ReasoningContext): ScoringDetail {
  return scorePatterns(input)
}
