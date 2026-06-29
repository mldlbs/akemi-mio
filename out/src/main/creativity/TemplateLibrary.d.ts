import type { CreativitySource, ConceptCombo, Hypothesis } from './types';
/**
 * TemplateLibrary — 本地假设生成引擎
 *
 * 使用方式：
 *   1. selectBest(combo, sources) 根据来源类型选择 2-3 个最佳模板
 *   2. fill(template, sourceA, sourceB) 填充模板内容
 *   3. 直接 generate(combo, sources) 一站式生成 Hypothesis
 */
export declare class TemplateLibrary {
    private rng;
    constructor(seed?: number);
    /**
     * 为一个 ConceptCombo 生成一条假设
     * @returns 生成的 Hypothesis，如果无适用模板则返回 null
     */
    generate(combo: ConceptCombo, sources: CreativitySource[]): Hypothesis | null;
    /**
     * 返回适用于某个类型组合的所有模板列表
     * @param nameKey 对 source name 排序后的组合键，用于 nameFit 二次路由
     */
    private selectForType;
    private typeKey;
    /** 对 source name 排序生成 nameFit 查询键 */
    private nameKey;
    private stableHash;
    /** 评分的小幅随机扰动（0-15），保持一定多样性 */
    private scoreNoise;
}
