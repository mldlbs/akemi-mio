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
import { log } from '../logger/Logger';
const DIMENSION_KEYS = ['planQuality', 'analysisDiversity', 'strategyCompliance', 'substantiveLength'];
const DEFAULT_WEIGHTS = {
    planQuality: 0.3,
    analysisDiversity: 0.25,
    strategyCompliance: 0.25,
    substantiveLength: 0.2,
};
export class EvaluatorCalibrator {
    constructor() {
        this.samples = [];
        this.weights = { ...DEFAULT_WEIGHTS };
        this.maxSamples = 100;
        this.minSamplesToCalibrate = 5;
    }
    /** 记录一次有 outcome 的评估样本 */
    recordSample(dimensionScores, overallScore, outcome) {
        this.samples.push({ dimensionScores, overallScore, outcome, timestamp: Date.now() });
        if (this.samples.length > this.maxSamples) {
            this.samples = this.samples.slice(-this.maxSamples);
        }
    }
    /** 获取当前维度权重快照 */
    getWeights() {
        return { ...this.weights };
    }
    /** 获取原始默认权重 */
    getDefaultWeights() {
        return { ...DEFAULT_WEIGHTS };
    }
    /** 执行校准，返回校准前后的权重对比 */
    calibrate() {
        const before = { ...this.weights };
        const stats = this.computeDimensionStats();
        const sampleSize = this.samples.length;
        if (sampleSize < this.minSamplesToCalibrate) {
            return {
                before,
                after: before,
                delta: Object.fromEntries(DIMENSION_KEYS.map((k) => [k, 0])),
                sampleSize,
                reliability: 0,
            };
        }
        // 计算各维度权重的调整量
        const rawAdjustments = {};
        let totalPosAdjustment = 0;
        for (const key of DIMENSION_KEYS) {
            const s = stats.get(key);
            if (!s || s.samples < 2) {
                rawAdjustments[key] = 0;
                continue;
            }
            // mae = 0-1, 理想是 0.3 以下
            // 调整幅度: (0.3 - mae) * 0.5, 最大 ±0.05
            const adjustment = Math.max(-0.05, Math.min(0.05, (0.3 - s.mae) * 0.5));
            rawAdjustments[key] = adjustment;
            if (adjustment > 0)
                totalPosAdjustment += adjustment;
        }
        // 负调整部分补给正调整的维度
        let totalNeg = 0;
        for (const key of DIMENSION_KEYS) {
            if (rawAdjustments[key] < 0)
                totalNeg += Math.abs(rawAdjustments[key]);
        }
        for (const key of DIMENSION_KEYS) {
            this.weights[key] = Math.max(0.05, Math.min(0.5, this.weights[key] + rawAdjustments[key]));
            if (rawAdjustments[key] > 0 && totalPosAdjustment > 0 && totalNeg > 0) {
                const share = rawAdjustments[key] / totalPosAdjustment;
                this.weights[key] = Math.max(0.05, Math.min(0.5, this.weights[key] - totalNeg * share));
            }
        }
        // 归一化权重
        const totalWeight = DIMENSION_KEYS.reduce((s, k) => s + this.weights[k], 0);
        for (const key of DIMENSION_KEYS) {
            this.weights[key] = Math.round((this.weights[key] / totalWeight) * 100) / 100;
        }
        const after = { ...this.weights };
        const delta = Object.fromEntries(DIMENSION_KEYS.map((k) => [k, Math.round((after[k] - before[k]) * 100)]));
        log('INFO', 'evaluator_calibrated', {
            before: formatWeights(before),
            after: formatWeights(after),
            sampleSize,
            reliability: Math.min(1, sampleSize / 20),
        });
        return { before, after, delta, sampleSize, reliability: Math.min(1, sampleSize / 20) };
    }
    /** 获取校准统计 */
    getCalibrationStats() {
        const stats = this.computeDimensionStats();
        const dimensionMAE = {};
        for (const [key, s] of stats) {
            dimensionMAE[key] = Math.round(s.mae * 1000) / 1000;
        }
        return {
            sampleCount: this.samples.length,
            weights: this.getWeights(),
            dimensionMAE,
            reliability: Math.min(1, this.samples.length / 20),
        };
    }
    /** 应用校准后的权重计算组合分 */
    computeCompositeScore(dimensionScores) {
        return Math.round(DIMENSION_KEYS.reduce((s, k) => s + dimensionScores[k] * this.weights[k], 0));
    }
    /** 重置为默认权重 */
    reset() {
        this.weights = { ...DEFAULT_WEIGHTS };
        this.samples = [];
    }
    // ==================== 内部 ====================
    computeDimensionStats() {
        const raw = new Map();
        for (const key of DIMENSION_KEYS) {
            raw.set(key, { errors: [], outcomes: [] });
        }
        for (const s of this.samples) {
            for (const key of DIMENSION_KEYS) {
                const entry = raw.get(key);
                const predicted = s.dimensionScores[key] / 100;
                const actual = s.outcome ? 1 : 0;
                entry.errors.push(Math.abs(predicted - actual));
                entry.outcomes.push(s.outcome);
            }
        }
        const result = new Map();
        for (const key of DIMENSION_KEYS) {
            const entry = raw.get(key);
            const mae = entry.errors.length > 0 ? entry.errors.reduce((a, b) => a + b, 0) / entry.errors.length : 0;
            const positiveOutcomes = entry.outcomes.filter(Boolean).length;
            const positiveCorrelation = entry.outcomes.length > 0 ? positiveOutcomes / entry.outcomes.length : 0;
            result.set(key, { mae, samples: entry.errors.length, positiveCorrelation });
        }
        return result;
    }
    getDiagnostics() {
        return {
            samples: this.samples.length,
            weights: this.getWeights(),
            dimensionStats: Array.from(this.computeDimensionStats().entries()).map(([k, v]) => ({
                dimension: k,
                mae: Math.round(v.mae * 1000) / 1000,
                samples: v.samples,
                posCorr: Math.round(v.positiveCorrelation * 100) / 100,
            })),
        };
    }
}
function formatWeights(w) {
    return Object.entries(w)
        .map(([k, v]) => `${k}=${v.toFixed(2)}`)
        .join(', ');
}
