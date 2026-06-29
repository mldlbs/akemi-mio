/** 模块级依赖注入 — 避免 LocalProvider 中跨模块 import */
import type { PlanManagerLike } from '../evolution/types';
import type { CredentialsManager } from '../credentials/CredentialsManager';
import type { MemoryService } from '../memory/MemoryService';
import type { SkillManager } from '../skill/SkillManager';
import type { ProceduralMemory } from '../agent/ProceduralMemory';
export declare function setPlanManager(pm: PlanManagerLike | null): void;
export declare function setCredentialsManager(cm: CredentialsManager | null): void;
export declare function setMemoryService(ms: MemoryService | null): void;
export declare function setSkillManager(sm: SkillManager | null): void;
export declare function setProceduralMemory(pm: ProceduralMemory | null): void;
export declare function getPlanManager(): PlanManagerLike | null;
export declare function getCredentialsManager(): CredentialsManager | null;
export declare function getMemoryService(): MemoryService | null;
export declare function getSkillManager(): SkillManager | null;
export declare function getProceduralMemory(): ProceduralMemory | null;
