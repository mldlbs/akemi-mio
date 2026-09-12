import { ObserverService } from './ObserverService'
import { ObserverStore } from './ObserverStore'
import { ObserverLlmService } from './ObserverLlmService'
import { DagStateMachine } from './DagStateMachine'
import { TrendEngine } from './TrendEngine'
import { TensionFieldEngine } from './TensionFieldEngine'
import { DeepResearchEngine } from './DeepResearchEngine'
import { MultiBrainModel } from './MultiBrainModel'
import { InsightComposer } from './InsightComposer'
import { WorldModelStore } from './WorldModelStore'
import { SelfEvolutionEngine } from './SelfEvolutionEngine'
import { FermentationEngine } from './FermentationEngine'
import { WritingGate } from './WritingGate'
import { OutputLayer } from './OutputLayer'
import { RSSCollector } from './collectors/RSSCollector'
import { BilibiliCollector } from './collectors/BilibiliCollector'
import { HackerNewsCollector } from './collectors/HackerNewsCollector'
import { GitHubTrendingCollector } from './collectors/GitHubTrendingCollector'
import { DouyinCollector } from './collectors/DouyinCollector'
import { WeiboCollector } from './collectors/WeiboCollector'

export {
  ObserverService,
  ObserverStore,
  ObserverLlmService,
  DagStateMachine,
  TrendEngine,
  TensionFieldEngine,
  DeepResearchEngine,
  MultiBrainModel,
  InsightComposer,
  WorldModelStore,
  SelfEvolutionEngine,
  FermentationEngine,
  WritingGate,
  OutputLayer,
  RSSCollector,
  BilibiliCollector,
  HackerNewsCollector,
  GitHubTrendingCollector,
  DouyinCollector,
  WeiboCollector,
}

export type {
  Observation,
  AssociationCluster,
  AssociationResult,
  DailyObservations,
  Collector,
  TaskState,
  DagStateFile,
  TrendSignal,
  TrendReport,
  TopicCandidate,
  TopicSelection,
  ResearchPhaseName,
  ResearchPhase,
  ResearchResult,
  BrainName,
  BrainOutput,
  WritingMode,
  InsightSection,
  BrainContributions,
  InsightOutput,
  WorldEntityType,
  WorldEntity,
  WorldEvent,
  TrendDirection,
  WorldTrend,
  NarrativeEvolution,
  WorldNarrative,
  WorldUncertainty,
  RelationType,
  WorldRelation,
  WorldModelSnapshot,
  FeedbackDimension,
  FeedbackSignal,
  UserFeedback,
  TrendLatencyRecord,
  EvolutionWeights,
  EvolutionThresholds,
  EvolutionParams,
  OutputType,
  OutputEnvelope,
} from './types'

export { DEFAULT_EVOLUTION_WEIGHTS, DEFAULT_EVOLUTION_THRESHOLDS, DEFAULT_EVOLUTION_PARAMS, WRITING_MODE_LABELS, INSIGHT_SECTION_TITLES } from './types'

export let observerService: ObserverService | null = null

export function initObserver(baseDir?: string): ObserverService {
  if (!observerService) {
    observerService = new ObserverService(baseDir)
  }
  return observerService
}
