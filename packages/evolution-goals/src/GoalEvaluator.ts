import type { Evidence, ExecutionGoal } from './types'

export type GoalVerdict = 'completed' | 'blocked' | 'continue'

export interface GoalEvaluation {
  verdict: GoalVerdict
  matchedCriteria: string[]
  failedCriteria: string[]
  reason: string
}

interface CriterionRule {
  type: string
  keywords: RegExp
  satisfied: (evidence: Evidence[]) => boolean
}

/** 确定性判定规则：successCriteria 关键词 → 证据类型（M6.1 不含 LLM judge） */
const CRITERION_RULES: CriterionRule[] = [
  {
    type: 'test_result',
    keywords: /测试|test|验收|回归/i,
    satisfied: (evidence) => evidence.some((e) => e.type === 'test_result' && e.value === 'passed'),
  },
  {
    type: 'file_changed',
    keywords: /文件|file|修改|写入|编辑|创建|删除|代码|bug/i,
    satisfied: (evidence) => evidence.some((e) => e.type === 'file_changed' && e.success),
  },
  {
    type: 'artifact_created',
    keywords: /生成|产物|图片|海报|卡片|artifact|发布|publish/i,
    satisfied: (evidence) => evidence.some((e) => e.type === 'artifact_created' && e.success),
  },
  {
    type: 'command_success',
    keywords: /命令|执行|运行|command|install|部署|deploy|build|编译/i,
    satisfied: (evidence) => evidence.some((e) => e.type === 'command_success' && e.success),
  },
]

/**
 * 确定性 GoalEvaluator：用已收集证据判定 successCriteria 是否满足。
 * - 无 successCriteria → continue（无法判定，交后续 LLM 层）
 * - 测试门失败 → blocked
 * - 全部 criteria 命中 → completed
 * - 其余 → continue
 */
export function evaluateGoal(goal: ExecutionGoal): GoalEvaluation {
  if (!goal.successCriteria || goal.successCriteria.length === 0) {
    return { verdict: 'continue', matchedCriteria: [], failedCriteria: [], reason: 'no deterministic success criteria' }
  }

  const testGateFailed = goal.evidence.some((e) => e.type === 'test_result' && e.value === 'failed')
  if (testGateFailed) {
    return {
      verdict: 'blocked',
      matchedCriteria: [],
      failedCriteria: [...goal.successCriteria],
      reason: 'test gate failed',
    }
  }

  const matched: string[] = []
  const failed: string[] = []
  for (const criterion of goal.successCriteria) {
    const rule = CRITERION_RULES.find((r) => r.keywords.test(criterion))
    if (!rule) {
      failed.push(criterion)
      continue
    }
    if (rule.satisfied(goal.evidence)) matched.push(criterion)
    else failed.push(criterion)
  }

  if (matched.length > 0 && matched.length === goal.successCriteria.length) {
    return { verdict: 'completed', matchedCriteria: matched, failedCriteria: [], reason: 'all success criteria matched' }
  }

  return { verdict: 'continue', matchedCriteria: matched, failedCriteria: failed, reason: 'criteria not yet satisfied' }
}
