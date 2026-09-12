export { PipelineOrchestrator } from './PipelineOrchestrator'
export type { PipelineConfig, PipelineMetrics } from './PipelineOrchestrator'
export { ProblemQueue } from './ProblemQueue'
export { TscCollector } from './TscCollector'
export { TestCollector } from './TestCollector'
export { EslintCollector } from './EslintCollector'
export { ClaudeCodeExecutor } from './ClaudeCodeExecutor'
export { CreativityCollector } from './CreativityCollector'
export { CreativityExecutor } from './CreativityExecutor'
export { MemoryAnalysisCollector } from './MemoryAnalysisCollector'
export { MemoryOptimizationCollector } from './MemoryOptimizationCollector'
export { MemoryOptimizationExecutor } from './MemoryOptimizationExecutor'
export { AsrLogCollector } from './AsrLogCollector'
export { AsrOptimizationExecutor } from './AsrOptimizationExecutor'
export { AsrReasoningChainExecutor } from './AsrReasoningChainExecutor'
export { AsrVocabEvolutionExecutor } from './AsrVocabEvolutionExecutor'
export { AsrAcousticOptimizationExecutor } from './AsrAcousticOptimizationExecutor'
export { WallpaperCollector } from './WallpaperCollector'
export { WallpaperOptimizationExecutor } from './WallpaperOptimizationExecutor'
export { PlanLogCollector } from './PlanLogCollector'
export { AutoPatchExecutor } from './AutoPatchExecutor'
export { BehaviorCollector } from './BehaviorCollector'
export { BehaviorOptimizationExecutor } from './BehaviorOptimizationExecutor'
export { ToolEvolutionCollector } from './ToolEvolutionCollector'
export { ToolAnalyticsCollector } from './ToolAnalyticsCollector'
export { ToolEvolutionExecutor } from './ToolEvolutionExecutor'
export { ToolConfigOptimizationExecutor } from './ToolConfigOptimizationExecutor'
export { ToolCompositeCollector } from './ToolCompositeCollector'
export { ToolCompositeExecutor } from './ToolCompositeExecutor'
export { TtsPreferenceCollector } from './TtsPreferenceCollector'
export { TtsConfigOptimizationExecutor } from './TtsConfigOptimizationExecutor'
export { TtsTypographyCollector } from './TtsTypographyCollector'
export { TtsTypographyExecutor } from './TtsTypographyExecutor'
export { FileOrganizerCollector } from '@akemi-mio/evolution-file-organizer'
export { FileOrganizerExecutor } from '@akemi-mio/evolution-file-organizer'
export { CicdCollector } from '@akemi-mio/evolution-cicd'
export { BlogOptimizationCollector } from '@akemi-mio/evolution-blog'
export { BlogOptimizationExecutor } from '@akemi-mio/evolution-blog'
export { EvidenceCollector } from './EvidenceCollector'

// ── 使用模式采集与参数调整（行为驱动的自进化优化）──
export { BehaviorUsageCollector } from './BehaviorUsageCollector'
export { BehaviorParamAdjustmentExecutor } from './BehaviorParamAdjustmentExecutor'
export { UserErrorPatternCollector, userErrorPatternCollector } from './UserErrorPatternCollector'
export { LearningCurveExecutor, learningCurveExecutor } from './LearningCurveExecutor'
export { ParameterSelfEvolutionAnalyzer, parameterSelfEvolutionAnalyzer } from '@akemi-mio/evolution-self-parameter'
export { ParameterSelfEvolutionExecutor } from '@akemi-mio/evolution-self-parameter'
export { EvidenceBridge, EVIDENCE_REPORT_READY } from './EvidenceBridge'
export type { EvidenceReportReadyPayload, EvidenceEmitter } from './EvidenceBridge'
export { ExecutionPolicy } from './ExecutionPolicy'
export type { ExecutionLevel, ExecutionMode, ExecutionVerdict, VerdictAction, PolicyDecisionEvent } from './ExecutionPolicy'
export { SyntheticTscExecutor, SYNTHETIC_EXECUTOR_NAME } from './SyntheticTscExecutor'
export {
  CAPABILITY_PROBLEM_IDENTITY_VERSION,
  buildCapabilityProblemIdentityKey,
  normalizeCapabilityProblemIdentity,
} from './CapabilityProblemIdentity'
export { buildCapabilityProblemShadowArtifacts } from './CapabilityProblemShadowPipeline'
export {
  buildCapabilityDecisionCandidates,
  buildCapabilityMigrationComparisonReport,
  buildDecisionDiffReport,
  buildLegacyDecisionCandidates,
} from './CapabilityDecisionShadowPipeline'
export { CapabilityMigrationArtifactStore } from './CapabilityMigrationArtifactStore'
export { evaluateCapabilityMigrationGate } from './CapabilityMigrationGateEvaluator'
export {
  buildLegacyProblemsFromShadowRuns,
  deriveIssueTypeFromShadowMetrics,
  loadShadowObservationRuns,
} from './CapabilityShadowRunHydrator'
export { evaluatePilotDecisionEligibility } from './CapabilityPilotDecisionGate'
export type { CapabilityPilotDecision, CapabilityPilotRunRecord } from './CapabilityPilotDecisionGate'
export { CapabilityPilotStore } from './CapabilityPilotStore'
export { evaluatePilotExitCriteria } from './CapabilityPilotHealthMonitor'
export type { CapabilityPilotHealthReport, CapabilityPilotHealthInput, PilotHealthDecision } from './CapabilityPilotHealthMonitor'

// ── 自适应步长求解器（自进化 ODE 求解器升级）──
export { SolverScannerCollector, AdaptiveSolverExecutor } from '@akemi-mio/evolution-adaptivesolver'

// ═══════════════════════════════════════════
//  MCP 模式迁移导出
// ═══════════════════════════════════════════

export { ProblemErrorType, classifyProblemError, shouldRetryOnError, shouldCacheErrorType } from './ProblemErrorType'
export { ProblemFixCache, problemFixCache } from './ProblemFixCache'
export {
  buildCollector,
  buildExecutor,
  collectorRegistry,
  executorRegistry,
  registerCollector,
  registerExecutor,
  getAllCollectors,
  getAllExecutors,
  getExecutorsBySource,
  getCollectorsBySource,
} from './registry'

export type { CollectorDef, ExecutorDef } from './registry'
export type {
  Problem,
  AssignedProblem,
  FixResult,
  SignalCollector,
  FixExecutor,
  ProblemSource,
  Severity,
  PipelineStats,
  CollectorExecutionEvent,
  SyntheticProblemDef,
  CapabilityProblemCandidate,
  CapabilityDecisionCandidate,
  CapabilityMigrationComparisonReport,
  CapabilityMigrationGateInput,
} from './types'
export type { ReasoningStep, ReasoningStepStatus, ReasoningChain } from './types'
export type { CapabilityProblemIdentity } from './CapabilityProblemIdentity'
