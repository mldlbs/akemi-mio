import { DrizzlePlanManager } from './DrizzlePlanManager'
import { SelfEvolutionService } from './SelfEvolutionService'
import { DevPlan } from './types'
import { AgentService } from '../agent/AgentService'
import { EvolutionScheduler, EvolutionSchedulerState } from './EvolutionScheduler'
import { EvolutionHistoryManager } from './EvolutionHistory'
import { EvolutionStateManager } from './EvolutionStateManager'
import { EvolutionGitOps, RollbackLevel } from './EvolutionGitOps'
import { ProposalValidator } from './ProposalValidator'
import { ANALYSIS_PROMPT, PLAN_EXECUTE_PROMPT, detectPlanMode, pickBestPlan, buildPlanInjection } from './EvolutionPromptBuilder'
import type { AnalysisMode } from './EvolutionPromptBuilder'
import type { PlanManagerLike } from './types'
import type { EvolutionSafetyMode } from './types'
import type { Proposal, ProposalValidation } from './ProposalValidator'

export { EvolutionScheduler, EvolutionSchedulerState } from './EvolutionScheduler'
export type { SchedulerCallbacks } from './EvolutionScheduler'
export { EvolutionHistoryManager } from './EvolutionHistory'
export type { EvolutionHistoryEntry, EvolutionHistory } from './EvolutionHistory'
export { EvolutionStateManager } from './EvolutionStateManager'
export { EvolutionGitOps } from './EvolutionGitOps'
export { RollbackLevel } from './EvolutionGitOps'
export { ProposalValidator } from './ProposalValidator'
export type { Proposal, ProposalValidation } from './ProposalValidator'
export { ANALYSIS_PROMPT, PLAN_EXECUTE_PROMPT, detectPlanMode, pickBestPlan, buildPlanInjection } from './EvolutionPromptBuilder'
export type { AnalysisMode } from './EvolutionPromptBuilder'
export { SelfEvolutionService, EvolutionSchedulerState as ServiceSchedulerState } from './SelfEvolutionService'
export type { EvolutionSafetyMode } from './types'
export type { PlanManagerLike } from './types'

// Pipeline 阶段导出
export { EvolutionAnalyzer, EvolutionStrategizer, EvolutionExecutor, EvolutionReviewer, setSandboxRoot } from './pipeline'
export type {
  AnalysisInput,
  AnalysisResult,
  StrategyContext,
  ExecutionInput,
  ExecutionResult,
  ReviewInput,
  ReviewResult,
  IEvolutionStage,
  IAnalyzer,
  IStrategizer,
  IExecutor,
  IReviewer,
} from './pipeline/types'

export const planManager = new DrizzlePlanManager()
export let evolutionService: SelfEvolutionService | null = null

export function initEvolution(agentService: AgentService): SelfEvolutionService {
  if (!evolutionService) {
    evolutionService = new SelfEvolutionService(agentService, undefined, undefined, planManager)
  }
  return evolutionService
}

export function getPlanContext(): string {
  return planManager.getFormattedContext()
}
