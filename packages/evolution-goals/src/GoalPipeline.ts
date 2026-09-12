import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import type { ToolCallInfo } from '@akemi-mio/intelligence/llm/LlmService'
import type { ToolResult } from '@akemi-mio/intelligence/agent/ToolScheduler'
import { ExecutionGoalStore } from './ExecutionGoalStore'
import { collectEvidence } from './EvidenceCollector'
import { evaluateGoal, type GoalEvaluation } from './GoalEvaluator'
import type { Evidence, ExecutionGoal, ExecutionGoalInput } from './types'
import { verifyGoalCompletion, type GoalCompletionVerifierLlm, type GoalVerificationResult } from './GoalCompletionVerifier'

export interface GoalRoundResult {
  evidence: Evidence[]
  evaluation: GoalEvaluation
}

/**
 * 从用户请求文本确定性推导 successCriteria（M6.1 占位实现）。
 * M6.2 起可替换为 LLM 抽取；本实现保证 evaluator 有可判定的标准。
 */
export function deriveSuccessCriteria(text: string): string[] {
  const criteria: string[] = []
  if (/测试|test|验收|回归/i.test(text)) criteria.push('测试通过')
  if (/修改|写入|编辑|文件|file|bug|修复|改一改|改动/i.test(text)) criteria.push('文件修改成功')
  if (/生成|图片|海报|卡片|产物|artifact|发布|publish|写文章|写作/i.test(text)) criteria.push('产物生成成功')
  if (/命令|执行|运行|install|部署|deploy|build|编译/i.test(text)) criteria.push('命令执行成功')
  return criteria
}

/** M6.1 Goal Pipeline：收集证据 → 持久化 → 判定 → 更新目标状态 */
export class GoalPipeline {
  constructor(private store: ExecutionGoalStore) {}

  createGoal(input: ExecutionGoalInput): ExecutionGoal {
    const goal = this.store.create(input)
    eventBus.emit('execution_goal.created', {
      id: goal.id,
      sessionId: goal.sessionId,
      objective: goal.objective,
      criteriaCount: goal.successCriteria.length,
      timestamp: Date.now(),
    })
    return goal
  }

  markExecuting(goalId: string): boolean {
    return this.store.markExecuting(goalId)
  }

  /** 将未终结目标标记为 abandoned（被新请求取代 / 用户停止 / NO_REPLY / 内部错误）。终态不可变。 */
  abandonGoal(goalId: string, reason: string): boolean {
    const goal = this.store.get(goalId)
    if (!goal) return false
    if (goal.status === 'completed' || goal.status === 'abandoned') return false
    if (!this.store.abandon(goalId)) return false
    this.store.appendEvidence(goalId, {
      type: 'abandoned',
      value: reason,
      tool: 'goal_pipeline',
      step: goal.currentStep,
      success: false,
      detail: reason,
      createdAt: Date.now(),
    })
    log('INFO', 'execution_goal_abandoned', { id: goalId, reason, from: goal.status })
    eventBus.emit('execution_goal.abandoned', {
      id: goalId,
      sessionId: goal.sessionId,
      reason,
      evidenceCount: goal.evidence.length,
      timestamp: Date.now(),
    })
    return true
  }

  /** toolLoop 每轮工具执行后调用。返回本轮证据与判定；无动作证据或目标不存在时返回 null。 */
  recordRound(goalId: string, toolCalls: ToolCallInfo[], toolResults: ToolResult[], step: number): GoalRoundResult | null {
    const goal = this.store.get(goalId)
    if (!goal) return null
    this.store.advanceStep(goalId, step)
    const evidence = collectEvidence(toolCalls, toolResults, step)
    if (evidence.length === 0) return null

    for (const e of evidence) this.store.appendEvidence(goalId, e)
    const updated = this.store.get(goalId)
    if (!updated) return null
    const evaluation = evaluateGoal(updated)

    if (evaluation.verdict === 'completed') {
      this.store.complete(goalId)
      log('INFO', 'execution_goal_completed', { id: goalId, matched: evaluation.matchedCriteria })
      eventBus.emit('execution_goal.completed', {
        id: goalId,
        sessionId: updated.sessionId,
        matchedCriteria: evaluation.matchedCriteria,
        evidenceCount: updated.evidence.length,
        timestamp: Date.now(),
      })
    } else if (evaluation.verdict === 'blocked') {
      this.store.markBlocked(goalId)
      log('WARN', 'execution_goal_blocked', { id: goalId, failed: evaluation.failedCriteria })
      eventBus.emit('execution_goal.blocked', {
        id: goalId,
        sessionId: updated.sessionId,
        failedCriteria: evaluation.failedCriteria,
        reason: evaluation.reason,
        timestamp: Date.now(),
      })
    }
    return { evidence, evaluation }
  }

  /** Optional LLM completion re-check. Does not mutate terminal status; appends a verification evidence. */
  async verifyCompletion(goalId: string, llm: GoalCompletionVerifierLlm, requestId?: string): Promise<GoalVerificationResult | null> {
    const goal = this.store.get(goalId)
    if (!goal || goal.status !== 'completed') return null
    const result = await verifyGoalCompletion(goal, llm, requestId)
    if (result) {
      this.store.appendEvidence(goalId, {
        type: 'verification',
        value: result.verdict,
        tool: 'goal_verifier',
        step: goal.currentStep,
        success: result.verdict === 'confirmed',
        detail: result.reason,
        createdAt: Date.now(),
      })
      log('INFO', 'execution_goal_verified', { id: goalId, verdict: result.verdict })
      eventBus.emit('execution_goal.verified', {
        id: goalId,
        sessionId: goal.sessionId,
        verdict: result.verdict,
        reason: result.reason,
        timestamp: Date.now(),
      })
    }
    return result
  }
}
