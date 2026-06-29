import type { CreativitySource, ConceptCombo, Hypothesis, CreativeIdea, Strategy, ExternalSignal } from './types';
/**
 * IdeaGenerator — 创造力引擎的核心编排器
 *
 * 流程：
 * 1. Source Gathering — 从多个来源收集"概念"
 * 2. Concept Mixing — 随机配对重组（规则引擎，保留）
 * 3. Hypothesis Generation — 将组合转化为假设（LLM 驱动，new）
 * 4. Experiment Planning — 为假设生成验证方案（规则引擎，保留）
 */
export declare class IdeaGenerator {
    private mixer;
    private hypothesisGen;
    private experimentPlanner;
    private rng;
    private temperature;
    /** 已探索过的配对 key 列表，传给 ConceptMixer 以降权 */
    private exploredPairs;
    constructor(chatJson: (userText: string, options?: {
        system?: string;
        temperature?: number;
        timeoutMs?: number;
        requestId?: string;
    }) => Promise<{
        data?: any;
        error?: string;
    }>, temperature?: number, seed?: number);
    /**
     * 完整一轮"灵感涌现"流程
     * @param strategy 生成策略，约束 ConceptMixer 配对空间
     */
    generateIdeas(sources: CreativitySource[], maxIdeas?: number, strategy?: Strategy, externalSignals?: ExternalSignal[]): Promise<CreativeIdea[]>;
    /**
     * Dream Mode — 高随机性、跨时间跨度的"梦境"模式
     */
    dreamIdeas(recentSources: CreativitySource[], historicalCombos: ConceptCombo[], failedHypotheses: Hypothesis[], maxIdeas?: number, strategy?: Strategy): Promise<CreativeIdea[]>;
    setTemperature(t: number): void;
    /** 设置已探索过的配对，用于 ConceptMixer 降权 */
    setExploredPairs(pairs: string[]): void;
    /**
     * 可行性/质量门禁 — 过滤明显不靠谱的想法
     * - 可行性评分 >= 30 才保留
     * - 想法描述至少 20 个字符（排除模板填空）
     * - novelty > 80 但 feasibility < 40 的"可疑高新颖性"需要额外检查描述长度
     */
    private feasibilityGate;
    /**
     * 温度影响来源选择权重
     */
    private applyTemperature;
}
