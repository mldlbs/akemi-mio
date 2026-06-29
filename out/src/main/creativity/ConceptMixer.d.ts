import type { CreativitySource, ConceptCombo, Strategy } from './types';
/**
 * ConceptMixer — 创造力核心：旧概念随机重组产生新想法
 *
 * 人类创造力 ≈ 已有概念的重新组合
 * 输入来源越多、越多样，组合越新颖
 *
 * v2 改动：mix() 接受 strategy 参数，在配对前约束组合空间。
 * strategy 决定了允许哪些 type 配对，而不只是事后评分。
 * 参见策略定义：Strategy = 'stable' | 'explore' | 'signal'
 */
export declare class ConceptMixer {
    private rng;
    constructor(seed?: number);
    /**
     * 将所有来源两两配对并打分，返回前 N 个最有潜力的组合
     * @param exploredPairs 已探索过的 pair key 列表（"A|B" 格式，已排序），用于降权
     * @param strategy 策略约束：stable/explore/signal，默认为 'explore'
     *   策略决定哪些 type 配对被允许、评分权重如何调整。
     */
    mix(sources: CreativitySource[], maxCombos?: number, exploredPairs?: string[], strategy?: Strategy): {
        combo: ConceptCombo;
        score: number;
    }[];
    /**
     * 按策略约束生成配对 — 核心改动：
     * - stable:   只同类型配对（去掉 novelty bonus 主导的跨类型噪声）
     * - explore:  跨类型优先，保留现有的多样性行为
     * - signal:   强制包含 provocation/insight/trend，限制纯知识配对
     */
    private generatePairs;
    private scorePair;
    private calculateNoveltyBonus;
    private describeCombo;
    /**
     * 随机抽取一组来源（温度越高，越可能选中低权重来源）
     */
    pickRandomSources(sources: CreativitySource[], temperature: number, minCount?: number): CreativitySource[];
}
