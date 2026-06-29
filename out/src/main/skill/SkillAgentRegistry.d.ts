import type { SkillManifest } from './SkillTypes';
export interface SkillAgentDef {
    skillName: string;
    allowedTools: string[];
    systemPrompt: string;
    outputSchema: Record<string, unknown>;
    requiresInput: Record<string, unknown>;
}
/**
 * SkillAgentRegistry — Executor 技能注册表
 *
 * 加载 executor 类型的技能时，记录其工具列表、SKILL.md 生成的 system prompt、
 * 以及输入/输出 schema，供 ScopedAgent 创建时使用。
 */
export declare class SkillAgentRegistry {
    private agents;
    /**
     * 注册一个 executor 技能
     */
    register(manifest: SkillManifest, allowedTools: string[], skillsDir: string): void;
    /**
     * 取消注册一个技能
     */
    unregister(skillName: string): void;
    /**
     * 获取已注册的 executor 技能
     */
    get(skillName: string): SkillAgentDef | undefined;
    /**
     * 获取所有 executor 技能定义
     */
    getAll(): SkillAgentDef[];
    /**
     * 判断是否存在
     */
    has(skillName: string): boolean;
    private buildSystemPrompt;
}
/** 全局单例 */
export declare const skillAgentRegistry: SkillAgentRegistry;
