/** 模块级依赖注入 — 避免 LocalProvider 中跨模块 import */
import type { PlanManagerLike } from '../evolution/types'
import type { CredentialsManager } from '../credentials/CredentialsManager'
import type { MemoryService } from '../memory/MemoryService'
import type { SkillManager } from '../skill/SkillManager'
import type { ProceduralMemory } from '../agent/ProceduralMemory'
import type { CognitiveService } from '../cognitive'
import type { PersonaStateManager } from '../agent/PersonaStateManager'
import type { CreativityService } from '../creativity/CreativityService'
import type { InsightService } from '../insight/InsightService'
import type { SelfEvolutionService } from '../evolution/SelfEvolutionService'
import type { SubAgentPool } from '../agent/SubAgentPool'
import type { LocalModelService } from '../creativity/LocalModelService'
import type { ObserverService } from '../observer/ObserverService'
import type { RuntimeHealthManager } from '../health/RuntimeHealthManager'

let _planManager: PlanManagerLike | null = null
let _credentialsManager: CredentialsManager | null = null
let _memoryService: MemoryService | null = null
let _skillManager: SkillManager | null = null
let _proceduralMemory: ProceduralMemory | null = null
let _cognitiveService: CognitiveService | null = null
let _personaStateManager: PersonaStateManager | null = null
let _creativityService: CreativityService | null = null
let _insightService: InsightService | null = null
let _evolutionService: SelfEvolutionService | null = null
let _subAgentPool: SubAgentPool | null = null
let _localModelService: LocalModelService | null = null
let _observerService: ObserverService | null = null
let _healthManager: RuntimeHealthManager | null = null

export function setPlanManager(pm: PlanManagerLike | null): void {
  _planManager = pm
}
export function setCredentialsManager(cm: CredentialsManager | null): void {
  _credentialsManager = cm
}
export function setMemoryService(ms: MemoryService | null): void {
  _memoryService = ms
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
export function setPersonaStateManager(ps: PersonaStateManager | null): void {
  _personaStateManager = ps
}
export function setCreativityService(cs: CreativityService | null): void {
  _creativityService = cs
}
export function setInsightService(is: InsightService | null): void {
  _insightService = is
}
export function setEvolutionService(es: SelfEvolutionService | null): void {
  _evolutionService = es
}
export function setSubAgentPool(sp: SubAgentPool | null): void {
  _subAgentPool = sp
}
export function setLocalModelService(lm: LocalModelService | null): void {
  _localModelService = lm
}
export function setObserverService(os: ObserverService | null): void {
  _observerService = os
}
export function setHealthManager(hm: RuntimeHealthManager | null): void {
  _healthManager = hm
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
export function getSkillManager(): SkillManager | null {
  return _skillManager
}
export function getProceduralMemory(): ProceduralMemory | null {
  return _proceduralMemory
}
export function getCognitiveService(): CognitiveService | null {
  return _cognitiveService
}
export function getPersonaStateManager(): PersonaStateManager | null {
  return _personaStateManager
}
export function getCreativityService(): CreativityService | null {
  return _creativityService
}
export function getInsightService(): InsightService | null {
  return _insightService
}
export function getEvolutionService(): SelfEvolutionService | null {
  return _evolutionService
}
export function getSubAgentPool(): SubAgentPool | null {
  return _subAgentPool
}
export function getLocalModelService(): LocalModelService | null {
  return _localModelService
}
export function getObserverService(): ObserverService | null {
  return _observerService
}
export function getHealthManager(): RuntimeHealthManager | null {
  return _healthManager
}
