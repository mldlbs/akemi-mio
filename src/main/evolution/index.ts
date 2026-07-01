import { DrizzlePlanManager } from './DrizzlePlanManager'
import { SelfEvolutionService } from './SelfEvolutionService'
import { DevPlan } from './types'
import { AgentService } from '../agent/AgentService'
import { EvolutionHistoryManager } from './EvolutionHistory'
import { EvolutionStateManager } from './EvolutionStateManager'
import { EvolutionGitOps, RollbackLevel } from './EvolutionGitOps'
import { ProposalValidator } from './ProposalValidator'
import { ANALYSIS_PROMPT, PLAN_EXECUTE_PROMPT, detectPlanMode, pickBestPlan, buildPlanInjection } from './EvolutionPromptBuilder'
import type { AnalysisMode } from './EvolutionPromptBuilder'
import type { PlanManagerLike } from './types'
import type { EvolutionSafetyMode } from './types'
import type { Proposal, ProposalValidation } from './ProposalValidator'

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
export { ActionRegistry } from './ActionRegistry'
export { plan as planActions, formatActionPlan } from './ActionPlanner'
export { ExecutionTracer } from './ExecutionTracer'
export { IntentExtractor } from './IntentExtractor'
export type { ActionContext } from './ActionContext'
export type { ExecutionTrace, TraceNode, TraceEdge } from './ExecutionTracer'
export type { IntentTrace } from './IntentExtractor'
export { PatternMiner } from './PatternMiner'
export { CapabilityRegistry } from './CapabilityRegistry'
export { CapabilityCompiler } from './CapabilityCompiler'
export { CapabilityExecutor } from './CapabilityExecutor'
export { setCapabilityRegistry as setActionCapabilityRegistry } from './ActionRegistry'
export type { PatternCandidate } from './PatternMiner'
export type { Capability } from './CapabilityRegistry'
export { MetaLearner } from './MetaLearner'
export { EvaluatorCalibrator } from './EvaluatorCalibrator'
export { PreservationEngine } from './PreservationEngine'
export type { PreservationReport, PreservationSummary, DimensionResult } from './PreservationEngine'
export { CapabilityGC } from './CapabilityGC'
export type { GCResult } from './CapabilityGC'
export { BehavioralRegressor } from './cpp/BehavioralRegressor'
export type { RegressorResult } from './cpp/BehavioralRegressor'
export { ContaminationDetector } from './cpp/ContaminationDetector'
export type { ContaminationResult } from './cpp/ContaminationDetector'
// Phase 5
export { EvolutionController } from './EvolutionController'
export type { ControllerState } from './EvolutionController'
export { EvolutionDecider } from './EvolutionDecider'
export type { DirectionDecision, DeciderInput, EvolutionDirection, ExpandMode } from './EvolutionDecider'
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
