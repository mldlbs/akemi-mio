import { ObserverService } from './ObserverService'
import { ObserverStore } from './ObserverStore'
import { ObserverLlmService } from './ObserverLlmService'
import type { ObserverLlmConfig } from './ObserverLlmService'
import { DagStateMachine } from './DagStateMachine'
import { TrendEngine } from './TrendEngine'
import { TensionFieldEngine } from './TensionFieldEngine'
import { DeepResearchEngine } from './DeepResearchEngine'
import { MultiBrainModel } from './MultiBrainModel'
import { InsightComposer } from './InsightComposer'
import { WorldModelStore } from './WorldModelStore'
import { SelfEvolutionEngine } from './SelfEvolutionEngine'
import { OutputLayer } from './OutputLayer'

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
  OutputLayer,
}

export let observerService: ObserverService | null = null

export function initObserver(baseDir?: string, llmConfig?: ObserverLlmConfig): ObserverService {
  if (!observerService) {
    observerService = new ObserverService(baseDir, llmConfig)
  }
  return observerService
}
