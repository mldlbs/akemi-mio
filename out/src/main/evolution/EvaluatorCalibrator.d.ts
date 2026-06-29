/**
 * EvaluatorCalibrator — 评估器维度权重自校准。
 *
 * 职责：
 * 1. 比较每次自评估的维度分与实际 outcome
 * 2. 自动调整四个维度的加权权重
 * 3. 使评分系统随经验积累越来越可信
 *
 * 校准原理：
 * - 对每个维度，跟踪其预测值（dimension score / 100）与实际（outcome 0/1）的偏差
 * - 高偏差维度降权，低偏差维度加权
 * - 权重总保持和为 1
 */
declare const DIMENSION_KEYS: readonly ["planQuality", "analysisDiversity", "strategyCompliance", "substantiveLength"];
export type DimensionKey = (typeof DIMENSION_KEYS)[number];
export declare class EvaluatorCalibrator {
    private samples;
    private weights;
    private readonly maxSamples;
    private readonly minSamplesToCalibrate;
    /** 记录一次有 outcome 的评估样本 */
    recordSample(dimensionScores: Record<DimensionKey, number>, overallScore: number, outcome: boolean): void;
    /** 获取当前维度权重快照 */
    getWeights(): Record<DimensionKey, number>;
    /** 获取原始默认权重 */
    getDefaultWeights(): Record<DimensionKey, number>;
    /** 执行校准，返回校准前后的权重对比 */
    calibrate(): {
        before: Record<DimensionKey, number>;
        after: Record<DimensionKey, number>;
        delta: Record<DimensionKey, number>;
        sampleSize: number;
        reliability: number;
    };
    /** 获取校准统计 */
    getCalibrationStats(): {
        sampleCount: number;
        weights: Record<DimensionKey, number>;
        dimensionMAE: Record<string, number>;
        reliability: number;
    };
    /** 应用校准后的权重计算组合分 */
    computeCompositeScore(dimensionScores: Record<DimensionKey, number>): number;
    /** 重置为默认权重 */
    reset(): void;
    private computeDimensionStats;
    getDiagnostics(): Record<string, unknown>;
}
export {};
