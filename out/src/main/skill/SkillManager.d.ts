import type { SkillManifest, InstalledSkill } from './SkillTypes';
export type { SkillManifest, InstalledSkill };
export declare class SkillManager {
    private promptCache;
    private loadedTools;
    private skills;
    private matcher;
    initialize(): Promise<void>;
    getAllSkills(): InstalledSkill[];
    /** 返回所有已启用技能的 prompt（全量注入） */
    getEnabledPromptModules(): string[];
    /**
     * 根据用户输入返回匹配的已启用技能 prompt（按需注入）
     * 仅返回 knowledge 类型 + 匹配到的技能 prompt
     */
    getMatchedPromptModules(userInput: string): string[];
    /** 用输入匹配所有已启用技能，返回匹配到的 manifest 列表 */
    matchSkills(input: string): SkillManifest[];
    enableSkill(name: string): Promise<string>;
    disableSkill(name: string): Promise<string>;
    private scanDirectory;
    private loadEnabled;
    private saveManifest;
    private loadSkillTools;
}
export declare function setSkillManager(sm: SkillManager | null): void;
export declare function getSkillManager(): SkillManager | null;
