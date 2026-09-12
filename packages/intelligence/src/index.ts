// ── Observer ──
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
  observerService,
  initObserver,
} from '@akemi-mio/intelligence-observer'

// ── MCP ──
export { ServerManager } from '@akemi-mio/intelligence-mcp'
export { mcpRegistry } from '@akemi-mio/intelligence-mcp'
export { setMemoryService } from '@akemi-mio/intelligence-mcp'
export { Phase0EvidenceAnalyzer } from '@akemi-mio/intelligence-mcp'

// ── Memory ──
export { MemoryService } from '@akemi-mio/intelligence-memory'
export { VoiceBookmarkService } from '@akemi-mio/intelligence-memory'
export { MemoryEvolutionBridge } from '@akemi-mio/intelligence-memory'
export { MemoryIndexer } from '@akemi-mio/intelligence-memory'

// ── Agent ──
export { AgentService } from './agent/AgentService'
export { SleepOrchestrator, sleepOrchestrator } from './agent/SleepOrchestrator'
export { setCapabilityAdapter } from './agent/context'
export { SessionRecoveryManager } from './agent/SessionRecoveryManager'
export { UIBridge } from './agent/UIBridge'

// ── LLM ──
export { LlmService } from './llm/LlmService'