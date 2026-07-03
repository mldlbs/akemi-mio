/** 模块级依赖注入 — 避免 LocalProvider 中跨模块 import */
import type { PlanManagerLike } from '../evolution/types'
import type { CredentialsManager } from '../credentials/CredentialsManager'
import type { MemoryService } from '../memory/MemoryService'
import type { SkillManager } from '../skill/SkillManager'
import type { ProceduralMemory } from '../agent/ProceduralMemory'
import type { CreativityService } from '../creativity/CreativityService'
import { creativityService } from '../creativity'

let _planManager: PlanManagerLike | null = null
let _credentialsManager: CredentialsManager | null = null
let _memoryService: MemoryService | null = null
let _skillManager: SkillManager | null = null
let _proceduralMemory: ProceduralMemory | null = null

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
