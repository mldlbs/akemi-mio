/**
 * MetaLearner — 跨周期变异效果学习引擎（元进化核心）。
 *
 * 职责：
 * 1. 记录每次变异操作及其后续分数变化
 * 2. 学习哪些参数变更在哪些上下文中有效
 * 3. 自适应选择变异策略（而非随机碰运气）
 * 4. 周期性输出元学习报告
 *
 * 这是 EvolutionSelfEvaluator + StrategyMutator 之上的元学习层，
 * 使系统能够"学习如何进化"而非"继续随机变异"。
 */
interface ParamEffectiveness {
    paramName: string;
    attempts: number;
    improvements: number;
    avgDelta: number;
    /** 是否达到可信样本阈值 */
    reliable: boolean;
}
export interface MetaLearningResult {
    recommendation: string | null;
    insight: string;
    details: {
        activeMutations: number;
        trackedOps: number;
        bestParam: string;
        worstParam: string;
        bestEffectiveness: number;
        worstEffectiveness: number;
    };
}
export declare class MetaLearner {
    private mutations;
    private readonly maxTracked;
    private cycleCount;
    /** 记录一次变异操作 */
    recordMutation(params: {
        parentStrategy: string;
        childStrategy: string;
        paramName: string;
        oldValue: unknown;
        newValue: unknown;
        operation: 'mutate' | 'crossover' | 'seed';
    }): string;
    /** 记录子策略的 outcome 分数 */
    recordOutcome(mutationId: string, parentScore: number, childScore: number, childSamples: number): void;
    /** 获取各参数维度的有效性统计 */
    getParamEffectiveness(): ParamEffectiveness[];
    /** 根据历史效果推荐变异参数 */
    recommendMutationParam(context?: {
        strategyName: string;
        currentScore: number;
    }): {
        paramName: string | null;
        insight: string;
    };
    /** 判断当前是否应当抑制变异（效果太差或数据不足时停止浪费） */
    shouldSuppressMutation(): boolean;
    /** 每 N 个周期输出一次元学习总结 */
    getMetaSummary(): MetaLearningResult | null;
    /** 每周期增长 */
    incrementCycle(): void;
    getCycleCount(): number;
    /** 诊断快照 */
    getDiagnostics(): Record<string, unknown>;
}
export {};
