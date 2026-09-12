import { ExecutionGoalStore } from './ExecutionGoalStore'
export { ExecutionGoalStore } from './ExecutionGoalStore'
export type {
  ExecutionGoal,
  ExecutionGoalInput,
  ExecutionGoalMethodologyStat,
  ExecutionGoalStats,
  ExecutionGoalStatus,
  Evidence,
} from './types'
export { collectEvidence } from './EvidenceCollector'
export { evaluateGoal, type GoalEvaluation, type GoalVerdict } from './GoalEvaluator'
export { GoalPipeline, deriveSuccessCriteria, type GoalRoundResult } from './GoalPipeline'
export {
  verifyGoalCompletion,
  buildGoalVerificationPrompt,
  parseGoalVerificationReply,
  type GoalCompletionVerifierLlm,
  type GoalVerificationResult,
} from './GoalCompletionVerifier'
export { formatExecutionGoalContext } from './executionGoalContext'

/** 全局共享实例：ChatExecutor 的 GoalPipeline 与 Evolution/仪表盘统计共用同一存储 */
export const executionGoalStore = new ExecutionGoalStore()
