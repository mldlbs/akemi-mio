/**
 * PersonaStateManager — 人格仲裁状态管理
 *
 * 独立于 ChatExecutor，管理人格等级检测、过渡、prompt 注入。
 * 可测试、可复用，TaskExecutor 将来也能接入。
 *
 * Persona 等级：
 * - core:   无写作偏置（默认）
 * - hybrid: 轻量表达偏置（中置信度写作意图）
 * - writer: 完整作家偏置（高置信度写作意图）
 *
 * 过渡规则（状态惯性优先，当前状态是强先验）：
 *   writer(惯性) → score ≤ 0.35 → hybrid → score ≤ 0.2 → core
 *   hybrid(惯性) → score ≥ 0.6 → writer | score ≤ 0.25 → core
 *   core(基线)    → score ≥ 0.75 → writer | score ≥ 0.4 → hybrid
 *
 * 人格漂移防护：降级时返回 transition signal，由调用方注入对话上下文，
 * 显式打断历史回复的残留偏置。
 */
import { type PersonaLevel } from './writing-prompt';
export type { PersonaLevel };
export interface PersonaUpdateResult {
    /** 需要注入的 prompt modules（由 getExtraModules 读取） */
    changed: boolean;
    /** 降级信号 — 放入 scratchpad 以注入消息层面，打断历史偏置 */
    transitionSignal: string | null;
}
export declare class PersonaStateManager {
    private level;
    /** 对输入进行意图评分并更新人格等级（带滞后） */
    update(text: string): PersonaUpdateResult;
    /** 返回当前人格等级 */
    getCurrentLevel(): PersonaLevel;
    /** 是否处于写作相关状态（hybrid 或 writer） */
    isActive(): boolean;
    /** 根据当前人格返回需要注入的 extra prompt module(s) */
    getExtraModules(): string[];
    /** 重置到 core（跨会话/测试清理） */
    reset(): void;
    private grade;
}
