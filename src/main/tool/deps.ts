/** 模块级依赖注入 — 避免 LocalProvider 中跨模块 import */
import type { PlanManagerLike } from '../evolution/types'
import type { CredentialsManager } from '../credentials/CredentialsManager'
import type { MemoryService } from '../memory/MemoryService'
import type { SkillManager } from '../skill/SkillManager'
import type { ProceduralMemory } from '../agent/ProceduralMemory'
import type { CreativityService } from '../creativity/CreativityService'
import { creativityService } from '../creativity'
import type { SelfEvolutionService } from '../evolution/SelfEvolutionService'
import { evolutionService } from '../evolution'
import type { CognitiveService } from '../cognitive'
import type { RuntimeHealthManager } from '../health'
import type { InsightService } from '../insight/InsightService'
import type { ObserverService } from '../observer'
import type { LocalModelService } from '../creativity/LocalModelService'

import type { PersonaStateManager } from '../agent/PersonaStateManager'

let _planManager: PlanManagerLike | null = null
let _credentialsManager: CredentialsManager | null = null
let _memoryService: MemoryService | null = null
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
import type { TtsService } from '../tts/TtsService'

let _ttsService: TtsService | null = null

export function setTtsService(ts: TtsService | null): void {
  _ttsService = ts
}

export function getTtsService(): TtsService | null {
  return _ttsService
}

// ── ASR 服务（供 TypographyVerification 工具调用）──
import type { AsrService } from '../asr/AsrService'

let _asrService: AsrService | null = null

export function setAsrService(as: AsrService | null): void {
  _asrService = as
}

export function getAsrService(): AsrService | null {
  return _asrService
}
