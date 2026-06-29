import type { ObserverStore } from './ObserverStore';
import type { EvolutionParams, FeedbackSignal } from './types';
/**
 * SelfEvolutionEngine — 参数自进化（增强版）
 *
 * 升级点：
 * - 新增用户显式评分 → feedback signal 转换
 * - 新增趋势延迟命中跟踪
 * - 新增 latency 惩罚信号
 */
export declare class SelfEvolutionEngine {
    private store;
    constructor(store: ObserverStore);
    getCurrentParams(): EvolutionParams;
    applyFeedback(signal: FeedbackSignal): Promise<EvolutionParams>;
    batchUpdate(signals: FeedbackSignal[]): Promise<EvolutionParams>;
    applyImplicitFeedback(opts: {
        insightSaved: boolean;
        dagFailed: boolean;
        topicRepeated: boolean;
        latencyMs?: number;
    }): Promise<void>;
    /**
     * 将用户显式评分 (1-5) 转换为 feedback signal
     */
    convertUserRating(rating: 1 | 2 | 3 | 4 | 5): FeedbackSignal;
    private applyGradient;
    private normalizeWeights;
    private clamp;
}
