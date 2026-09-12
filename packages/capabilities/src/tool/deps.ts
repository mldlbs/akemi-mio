/** 模块级依赖注入 — 避免 LocalProvider 中跨模块 import */
import type { PlanManagerLike } from '@akemi-mio/evolution/types'
import type { CredentialsManager } from '@akemi-mio/core/credentials/CredentialsManager'
import type { MemoryService } from '@akemi-mio/intelligence-memory/MemoryService'
import type { SkillManager } from '@akemi-mio/intelligence-skill/SkillManager'
import type { ProceduralMemory } from '@akemi-mio/intelligence/agent/ProceduralMemory'
import type { CreativityService } from '@akemi-mio/creativity/CreativityService'
import { creativityService } from '@akemi-mio/creativity'
import type { SelfEvolutionService } from '@akemi-mio/evolution/SelfEvolutionService'
import { evolutionService } from '@akemi-mio/evolution'
import type { CognitiveService } from '@akemi-mio/intelligence/cognitive'
import type { RuntimeHealthManager } from '@akemi-mio/monitoring/health'
import type { InsightService } from '@akemi-mio/intelligence-insight/InsightService'
import type { ObserverService } from '@akemi-mio/intelligence-observer'
import type { LocalModelService } from '@akemi-mio/creativity/LocalModelService'
import type { MemoryResourceProvider } from '@akemi-mio/intelligence-mcp/MemoryResourceProvider'
import type { AsrVocabularyResource } from '@akemi-mio/intelligence-mcp/AsrVocabularyResource'

import type { PersonaStateManager } from '@akemi-mio/intelligence/agent/PersonaStateManager'

let _planManager: PlanManagerLike | null = null
let _credentialsManager: CredentialsManager | null = null
let _memoryService: MemoryService | null = null
let _memoryResourceProvider: MemoryResourceProvider | null = null
let _asrVocabularyResource: AsrVocabularyResource | null = null
let _skillManager: SkillManager | null = null
let _proceduralMemory: ProceduralMemory | null = null
let _cognitiveService: CognitiveService | null = null
let _healthManager: RuntimeHealthManager | null = null
let _insightService: InsightService | null = null
let _observerService: ObserverService | null = null
let _localModelService: LocalModelService | null = null

export function setPlanManager(pm: PlanManagerLike | null): void {
  _planManager = pm
}
export function setCredentialsManager(cm: CredentialsManager | null): void {
  _credentialsManager = cm
}
export function setMemoryService(ms: MemoryService | null): void {
  _memoryService = ms
}
export function setMemoryResourceProvider(rp: MemoryResourceProvider | null): void {
  _memoryResourceProvider = rp
}
export function setSkillManager(sm: SkillManager | null): void {
  _skillManager = sm
}
export function setProceduralMemory(pm: ProceduralMemory | null): void {
  _proceduralMemory = pm
}
export function setCognitiveService(cs: CognitiveService | null): void {
  _cognitiveService = cs
}

export function getPlanManager(): PlanManagerLike | null {
  return _planManager
}
export function getCredentialsManager(): CredentialsManager | null {
  return _credentialsManager
}
export function getMemoryService(): MemoryService | null {
  return _memoryService
}
export function getMemoryResourceProvider(): MemoryResourceProvider | null {
  return _memoryResourceProvider
}
export function setAsrVocabularyResource(rp: AsrVocabularyResource | null): void {
  _asrVocabularyResource = rp
}
export function getAsrVocabularyResource(): AsrVocabularyResource | null {
  return _asrVocabularyResource
}
export function getSkillManager(): SkillManager | null {
  return _skillManager
}
export function getProceduralMemory(): ProceduralMemory | null {
  return _proceduralMemory
}

export function getCreativityService(): CreativityService | null {
  return creativityService
}

export function getEvolutionService(): SelfEvolutionService | null {
  return evolutionService
}

export function getCognitiveService(): CognitiveService | null {
  return _cognitiveService
}

let _personaStateManager: PersonaStateManager | null = null

export function setPersonaStateManager(psm: PersonaStateManager | null): void {
  _personaStateManager = psm
}

export function getPersonaStateManager(): PersonaStateManager | null {
  return _personaStateManager
}

export function setHealthManager(hm: RuntimeHealthManager | null): void {
  _healthManager = hm
}

export function getHealthManager(): RuntimeHealthManager | null {
  return _healthManager
}

export function setInsightService(is: InsightService | null): void {
  _insightService = is
}

export function getInsightService(): InsightService | null {
  return _insightService
}

export function setLocalModelService(lm: LocalModelService | null): void {
  _localModelService = lm
}

export function setObserverService(os: ObserverService | null): void {
  _observerService = os
}

export function getObserverService(): ObserverService | null {
  return _observerService
}

export function getLocalModelService(): LocalModelService | null {
  return _localModelService
}

// ── TTS 服务（供 PiperTTS 工具调用）──
import type { TtsService } from '@akemi-mio/audio/TtsService'

let _ttsService: TtsService | null = null

export function setTtsService(ts: TtsService | null): void {
  _ttsService = ts
}

export function getTtsService(): TtsService | null {
  return _ttsService
}

// ── ASR 服务（供 TypographyVerification 工具调用）──
import type { AsrService } from '@akemi-mio/audio/AsrService'

let _asrService: AsrService | null = null

export function setAsrService(as: AsrService | null): void {
  _asrService = as
}

export function getAsrService(): AsrService | null {
  return _asrService
}

// ── Blog Memory 服务（供 Plan Memory Blog 时光机调用）──
import type { BlogMemoryRecorder, BlogMemoryRetriever } from '@akemi-mio/intelligence-memory/plan-memory-blog'

let _blogMemoryRecorder: BlogMemoryRecorder | null = null
let _blogMemoryRetriever: BlogMemoryRetriever | null = null

export function setBlogMemoryRecorder(r: BlogMemoryRecorder | null): void {
  _blogMemoryRecorder = r
}

export function getBlogMemoryRecorder(): BlogMemoryRecorder | null {
  return _blogMemoryRecorder
}

export function setBlogMemoryRetriever(r: BlogMemoryRetriever | null): void {
  _blogMemoryRetriever = r
}

export function getBlogMemoryRetriever(): BlogMemoryRetriever | null {
  return _blogMemoryRetriever
}

// ── Blog Mode Service（供 Blog Dual-Mode Switching 使用）──
import type { BlogModeService } from '@akemi-mio/intelligence/agent/blog/BlogModeService'

let _blogModeService: BlogModeService | null = null

export function setBlogModeService(bms: BlogModeService | null): void {
  _blogModeService = bms
}

export function getBlogModeService(): BlogModeService | null {
  return _blogModeService
}

// ── TaskTemplateRegistry（供 AdaptiveOrchestrator 使用）──
import type { TaskTemplateRegistry } from '@akemi-mio/intelligence/agent/task-template/TaskTemplateRegistry'

let _taskTemplateRegistry: TaskTemplateRegistry | null = null

export function setTaskTemplateRegistry(reg: TaskTemplateRegistry | null): void {
  _taskTemplateRegistry = reg
}

export function getTaskTemplateRegistry(): TaskTemplateRegistry | null {
  return _taskTemplateRegistry
}

// ── AdaptiveOrchestrator（供工具调用）──

let _adaptiveOrchestrator: any = null

export function setAdaptiveOrchestrator(orchestrator: any): void {
  _adaptiveOrchestrator = orchestrator
}

export function getAdaptiveOrchestrator(): any {
  return _adaptiveOrchestrator
}

// ── PlanSchedulerCoordinator（供 PlanSchedulerTools 调用）──

import type { PlanSchedulerCoordinator } from '@akemi-mio/evolution-plan-scheduler'

let _planSchedulerCoordinator: PlanSchedulerCoordinator | null = null

export function setPlanSchedulerCoordinator(c: PlanSchedulerCoordinator | null): void {
  _planSchedulerCoordinator = c
}

export function getPlanSchedulerCoordinator(): PlanSchedulerCoordinator | null {
  return _planSchedulerCoordinator
}

// ── ToolChainOrchestrator（供工具链编排工具调用）──

import type { ToolChainOrchestrator } from '@akemi-mio/intelligence/orchestrator'

let _toolChainOrchestrator: ToolChainOrchestrator | null = null

export function setToolChainOrchestrator(orch: ToolChainOrchestrator | null): void {
  _toolChainOrchestrator = orch
}

export function getToolChainOrchestrator(): ToolChainOrchestrator | null {
  return _toolChainOrchestrator
}
// ???? WallpaperToolBridge??? WallpaperIntegrationTools ????????
import type { WallpaperToolBridge } from '@akemi-mio/platform/wallpaper/WallpaperToolBridge'

let _wallpaperToolBridge: WallpaperToolBridge | null = null

export function setWallpaperToolBridge(bridge: WallpaperToolBridge | null): void {
  _wallpaperToolBridge = bridge
}

export function getWallpaperToolBridge(): WallpaperToolBridge | null {
  return _wallpaperToolBridge
}

// ???? WritingPlanAgent??? WritingPlanTools ????????
import type { WritingPlanAgent } from '@akemi-mio/creativity/writing/WritingPlanAgent'

let _writingPlanAgent: WritingPlanAgent | null = null

export function setWritingPlanAgent(agent: WritingPlanAgent | null): void {
  _writingPlanAgent = agent
}

export function getWritingPlanAgent(): WritingPlanAgent | null {
  return _writingPlanAgent
}


