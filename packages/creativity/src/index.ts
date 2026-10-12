import { CreativityService } from './CreativityService'
import { DrizzleIdeaStore } from './DrizzleIdeaStore'
import type { CreativitySource } from './types'
import type { TaskRunner } from '@akemi-mio/core/core/tasks/unified/TaskRunner'

export let creativityService: CreativityService | null = null
export let ideaStore: DrizzleIdeaStore | null = null

export function initCreativity(
  filePath: string,
  deps: {
    getSources: () => CreativitySource[]
    getBehaviorSources?: () => CreativitySource[]
    getInsights: () => { title: string; description: string; score: number }[]
    getFailedHypotheses: () => { title: string; idea: string; risk: string }[]
    getExternalSources?: () => CreativitySource[]
    getFeedbackSources?: () => CreativitySource[]
  },
  chatJson: (
    userText: string,
    options?: { system?: string; temperature?: number; timeoutMs?: number; requestId?: string },
  ) => Promise<{ data?: any; error?: string }>,
  temperature = 0.3,
  reportDir = '',
  taskRunner?: TaskRunner | null,
  observerDir?: string,
  chatJsonWithCode?: (
    userText: string,
    options?: { system?: string; temperature?: number; timeoutMs?: number; requestId?: string },
  ) => Promise<{ data?: any; error?: string }>,
): CreativityService {
  if (!creativityService) {
    const store = new DrizzleIdeaStore()
    ideaStore = store
    creativityService = new CreativityService(
      store,
      deps,
      chatJson,
      chatJsonWithCode,
      temperature,
      undefined,
      undefined,
      reportDir,
      taskRunner ?? undefined,
      observerDir,
    )
  }
  return creativityService
}

export { CreativityService, DrizzleIdeaStore }
export { ContentEnhancer } from './ContentEnhancer'
export type { EnhancedSource } from './ContentEnhancer'
export { deriveMechanismGraph, relationsToEdges, isMechanismHypothesis } from './MechanismGraph'
export type { MechanismGraph, MechanismEdge, TraceEventLike } from './MechanismGraph'
export {
  runWhenThenRule,
  evaluateWhen,
  evaluateCondition,
  lookupField,
  compileBudgetToConstraints,
  topologicalOrder,
} from './WhenThenRunner'
export type {
  WhenThenRule,
  ThenAction,
  WhenCondition,
  CompareOp,
  ResourceBudgetSpec,
  StepExecInput,
  StepExecResult,
  StepExecutor,
  RunnerEvent,
  RunnerEventSink,
  RunRuleResult,
} from './WhenThenRunner'
export {
  parseStoppingRule,
  evaluateStoppingRule,
  checkPromotionGate,
  assignExperimentMode,
  routeExperimentMemoryPath,
  isExperimentMode,
  DEFAULT_STOPPING_RULE,
} from './ExperimentRunStore'
export type {
  ExperimentRun,
  ExperimentAssignment,
  ExperimentOutcome,
  StoppingRuleConfig,
  StoppingDecision,
  AssignmentResult,
  PromotionGateResult,
} from './ExperimentRunStore'
export { sampleVariant, computeSamplingMetrics, runInsightSamplingExperiment, reportToExperimentRuns } from './InsightSamplingExperiment'
export type { SamplingVariant, SamplingMetrics, VariantResult, CapabilityDeltaReport } from './InsightSamplingExperiment'
export { MechanismRegistryStore, canIndependentlyApprove, checkSubmitGate } from './MechanismRegistry'
export type {
  MechanismStatus,
  MechanismVersion,
  ApprovalStatus,
  PromotionRequest,
  SubmitGateResult,
  SubmitPromotionInput,
  SubmitResult,
  DecideResult,
  RollbackResult,
} from './MechanismRegistry'
export * from './types'
