/**
 * SystemStabilityScore — Agent OS 系统稳定性评分。
 *
 * 六因子乘法模型：
 *   score = memoryHealth × taskFlowEfficiency × schedulerBalance × evolutionRiskControl × errorRateInverse × guardrailHealth
 *
 * score ∈ [0, 100]，起始值 100，健康阈值 >= 70，临界阈值 < 40。
 */
export interface StabilityFactors {
    memoryHealth: number;
    taskFlowEfficiency: number;
    schedulerBalance: number;
    evolutionRiskControl: number;
    errorRateInverse: number;
    guardrailHealth: number;
}
export type StabilityStatus = 'healthy' | 'degraded' | 'critical';
export declare class SystemStabilityScore {
    private score;
    private history;
    private readonly maxHistory;
    /** 计算稳定性分数并平滑更新 */
    compute(factors: StabilityFactors): number;
    getScore(): number;
    /** 比较最近10个点 vs 前10个点的均值 */
    getTrend(): 'improving' | 'declining' | 'stable';
    getHistory(): {
        score: number;
        timestamp: number;
    }[];
    getStatus(): StabilityStatus;
    isHealthy(): boolean;
    isCritical(): boolean;
    /** 根据当前稳定性给出操作建议 */
    /** 根据当前稳定性分数返回推荐预算调节参数 */
    autoTuneConfig(): {
        reduceBy?: number;
        restoreBy?: number;
        action: 'restore' | 'reduce' | 'none';
    };
    getRecommendations(): string[];
}
