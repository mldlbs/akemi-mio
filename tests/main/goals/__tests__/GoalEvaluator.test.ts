import { describe, it, expect } from 'vitest'
import { evaluateGoal } from '@akemi-mio/evolution/goals/GoalEvaluator'
import type { Evidence, ExecutionGoal } from '@akemi-mio/evolution/goals/types'

function goal(criteria: string[], evidence: Evidence[]): ExecutionGoal {
  return {
    id: 'g1',
    sessionId: 's1',
    objective: 'objective',
    successCriteria: criteria,
    status: 'executing',
    planId: null,
    currentStep: 0,
    evidence,
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
  }
}

const ev = (type: string, value: string, success = true): Evidence => ({
  type,
  value,
  tool: 't',
  step: 0,
  success,
  createdAt: 0,
})

describe('GoalEvaluator (M6.1 deterministic)', () => {
  it('returns continue when no success criteria are defined', () => {
    expect(evaluateGoal(goal([], []))).toMatchObject({ verdict: 'continue' })
  })

  it('completes when all criteria are matched by evidence', () => {
    const result = evaluateGoal(goal(['测试通过', '文件修改成功'], [ev('test_result', 'passed'), ev('file_changed', 'changed')]))
    expect(result).toMatchObject({ verdict: 'completed', matchedCriteria: ['测试通过', '文件修改成功'] })
  })

  it('continues when only part of the criteria are matched', () => {
    const result = evaluateGoal(goal(['测试通过', '文件修改成功'], [ev('test_result', 'passed')]))
    expect(result).toMatchObject({ verdict: 'continue', matchedCriteria: ['测试通过'] })
  })

  it('blocks when the test gate fails', () => {
    const result = evaluateGoal(goal(['测试通过'], [ev('test_result', 'failed', false)]))
    expect(result).toMatchObject({ verdict: 'blocked', reason: 'test gate failed' })
  })

  it('matches artifact criteria', () => {
    const result = evaluateGoal(goal(['产物生成成功'], [ev('artifact_created', 'created')]))
    expect(result.verdict).toBe('completed')
  })

  it('matches command criteria', () => {
    const result = evaluateGoal(goal(['命令执行成功'], [ev('command_success', 'ok')]))
    expect(result.verdict).toBe('completed')
  })

  it('continues when a criterion has no matching rule', () => {
    const result = evaluateGoal(goal(['优化性能'], [ev('command_success', 'ok')]))
    expect(result).toMatchObject({ verdict: 'continue', failedCriteria: ['优化性能'] })
  })
})
