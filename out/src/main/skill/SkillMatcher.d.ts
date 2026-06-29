import { SkillManifest } from './SkillTypes';
export interface MatchedSkill {
    manifest: SkillManifest;
    weight: number;
    matchType: 'keyword' | 'description' | 'semantic';
}
/**
 * SkillMatcher — Trigger 匹配引擎
 *
 * 根据用户输入匹配已安装技能的 triggers，返回匹配列表。
 * 匹配优先级：精确命中 > 描述模糊匹配 > 语义兜底
 */
export declare class SkillMatcher {
    /**
     * 精确关键词匹配：input 包含 trigger 中的任意一个词
     */
    matchByKeyword(input: string, triggers: string[]): boolean;
    /**
     * 描述模糊匹配：检查技能名称或 description 是否包含 input 中的关键片段
     */
    matchByDescription(input: string, manifest: SkillManifest): boolean;
    /**
     * 综合匹配入口
     */
    match(input: string, allSkills: SkillManifest[]): MatchedSkill[];
}
