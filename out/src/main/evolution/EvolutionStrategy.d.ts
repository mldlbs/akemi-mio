export interface StrategyConfig {
    name: string;
    description: string;
    /** analysis prompt 模式 */
    promptMode: 'full' | 'balanced' | 'minimal';
    /** 分析超时基数 (ms) */
    timeoutMs: number;
    /** 是否裁剪 prompt（仅 mission） */
    trimMode: boolean;
    /** 历史摘要条目数 */
    maxHistoryEntries: number;
    /** 安全模式 */
    safetyMode: 'review' | 'auto';
    /** 退化检测连续相同次数阈值 */
    degenerationThreshold: number;
}
export interface StrategyScore {
    strategyName: string;
    score: number;
    samples: number;
    avgSuccessRate: number;
    avgExecutionMs: number;
    lastUsed: number;
    createdAt: number;
}
export interface CycleEvaluation {
    success: boolean;
    durationMs: number;
    planCreated: boolean;
    stepsPlanned: number;
    hadTimeout: boolean;
    hadRetry: boolean;
    promptTrimmed: boolean;
}
export declare class EvolutionStrategyLearner {
    private scores;
    private strategies;
    private cycleHistory;
    private scoreFilePath;
    private persistenceDirty;
    constructor(scoreFilePath?: string);
    /** 根据当前上下文选择最佳策略 */
    select(context: {
        consecutiveFailures: number;
        isFirstRun: boolean;
        isRecovering: boolean;
        hoursSinceLastRun: number;
        isDegenerate: boolean;
    }): StrategyConfig;
    private consecutiveFailuresForContext;
    /** 基于 epsilon-greedy bandit 选择策略 */
    private selectByScore;
    /** 循环结束后评分，更新策略分数 */
    evaluate(strategyName: string, evalResult: CycleEvaluation): void;
    /** 用自我评估分数微调策略分 */
    applySelfEvaluation(strategyName: string, selfEvalScore: number): void;
    /** 根据历史数据调优策略参数 */
    tuneParameters(): Array<{
        strategy: string;
        parameter: string;
        oldValue: any;
        newValue: any;
        reason: string;
    }>;
    private loadScores;
    private saveScores;
    /** 元进化：从历史中挖掘最优策略窗口 */
    learn(): {
        recommendation?: string;
        insight: string;
        adjustments?: Array<{
            strategy: string;
            parameter: string;
            oldValue: any;
            newValue: any;
            reason: string;
        }>;
        mutation?: MutationResult | null;
    };
    /** 获取策略变异器 */
    private _mutator;
    getMutator(): StrategyMutator;
    /** 获取历史记录（供外部读取） */
    getCycleHistory(): Array<{
        strategy: string;
        eval: CycleEvaluation;
    }>;
    /** 获取格式化上下文，注入 evolution prompt */
    getFormattedContext(): string;
}
export interface MutationResult {
    parent: string;
    child: string;
    childConfig: StrategyConfig;
    operation: 'mutate' | 'crossover' | 'seed';
    reason: string;
}
export declare class StrategyMutator {
    private strategies;
    private scores;
    constructor(strategies: Map<string, StrategyConfig>, scores: Map<string, StrategyScore>);
    /** 尝试一次变异操作。targetDimension 可指定目标改进维度 */
    mutate(cycleHistory: Array<{
        strategy: string;
        eval: CycleEvaluation;
    }>, targetDimension?: string): MutationResult | null;
    /** 修剪低效策略 */
    prune(): number;
    private getViableStrategies;
    private performMutation;
    private pickMutateParam;
    /** 目标维度 → 相关参数映射，70% 概率命中目标 */
    private pickTargetParam;
    private performCrossover;
    private trySeed;
}
