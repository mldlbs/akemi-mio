import { log } from '../logger/Logger';
import { DEFAULT_EVOLUTION_PARAMS } from './types';
const LEARNING_RATE = 0.05;
const MIN_W = 0.05;
const MAX_W = 0.5;
/**
 * SelfEvolutionEngine — 参数自进化（增强版）
 *
 * 升级点：
 * - 新增用户显式评分 → feedback signal 转换
 * - 新增趋势延迟命中跟踪
 * - 新增 latency 惩罚信号
 */
export class SelfEvolutionEngine {
    constructor(store) {
        this.store = store;
    }
    getCurrentParams() {
        return this.store.readEvolutionParams() ?? { ...DEFAULT_EVOLUTION_PARAMS };
    }
    async applyFeedback(signal) {
        this.store.saveFeedback(signal);
        const params = this.getCurrentParams();
        this.applyGradient(params, { dimension: signal.dimension, value: signal.value });
        params.version++;
        params.updatedAt = new Date().toISOString();
        this.store.saveEvolutionParams(params);
        log('INFO', 'self_evo_applied', { dimension: signal.dimension, value: signal.value, version: params.version });
        return params;
    }
    async batchUpdate(signals) {
        if (signals.length === 0)
            return this.getCurrentParams();
        const params = this.getCurrentParams();
        const dims = ['usefulness', 'novelty', 'correctness'];
        for (const dim of dims) {
            const filtered = signals.filter((s) => s.dimension === dim);
            if (filtered.length === 0)
                continue;
            const avg = filtered.reduce((s, f) => s + f.value, 0) / filtered.length;
            this.applyGradient(params, { dimension: dim, value: avg });
        }
        this.normalizeWeights(params);
        params.version++;
        params.updatedAt = new Date().toISOString();
        this.store.saveEvolutionParams(params);
        log('INFO', 'self_evo_batch', { signalCount: signals.length, version: params.version, weights: params.weights });
        return params;
    }
    async applyImplicitFeedback(opts) {
        const signals = [];
        const ts = new Date().toISOString();
        if (opts.insightSaved)
            signals.push({ source: 'system', dimension: 'usefulness', value: 0.1, topicId: 'implicit', timestamp: ts });
        if (opts.dagFailed)
            signals.push({ source: 'system', dimension: 'correctness', value: -0.2, topicId: 'implicit', timestamp: ts });
        if (opts.topicRepeated)
            signals.push({ source: 'system', dimension: 'novelty', value: -0.3, topicId: 'implicit', timestamp: ts });
        if (opts.latencyMs && opts.latencyMs > 4 * 3600 * 1000) {
            signals.push({
                source: 'system',
                dimension: 'novelty',
                value: -0.1,
                topicId: 'implicit',
                timestamp: ts,
                latencyMs: opts.latencyMs,
            });
        }
        if (signals.length > 0)
            await this.batchUpdate(signals);
    }
    /**
     * 将用户显式评分 (1-5) 转换为 feedback signal
     */
    convertUserRating(rating) {
        const valueMap = { 1: -0.5, 2: -0.2, 3: 0, 4: 0.15, 5: 0.3 };
        return {
            source: 'user',
            dimension: 'usefulness',
            value: valueMap[rating],
            topicId: 'user_feedback',
            timestamp: new Date().toISOString(),
        };
    }
    // ── private ──────────────────────────────────────────────
    applyGradient(params, grad) {
        const delta = grad.value * LEARNING_RATE;
        switch (grad.dimension) {
            case 'usefulness':
                params.weights.alpha = this.clamp(params.weights.alpha + delta);
                break;
            case 'novelty':
                params.weights.beta = this.clamp(params.weights.beta + delta);
                break;
            case 'correctness':
                params.weights.epsilon = this.clamp(params.weights.epsilon + delta);
                if (grad.value < 0)
                    params.thresholds.writingGate = parseFloat(Math.min(0.95, params.thresholds.writingGate + 0.03).toFixed(2));
                break;
        }
    }
    normalizeWeights(params) {
        const w = params.weights;
        const sum = w.alpha + w.beta + w.gamma + w.delta + w.epsilon;
        if (sum > 0) {
            w.alpha = parseFloat((w.alpha / sum).toFixed(4));
            w.beta = parseFloat((w.beta / sum).toFixed(4));
            w.gamma = parseFloat((w.gamma / sum).toFixed(4));
            w.delta = parseFloat((w.delta / sum).toFixed(4));
            w.epsilon = parseFloat((w.epsilon / sum).toFixed(4));
        }
    }
    clamp(v) {
        return parseFloat(Math.min(MAX_W, Math.max(MIN_W, v)).toFixed(4));
    }
}
