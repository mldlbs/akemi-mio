import type { ObserverLlmService } from './ObserverLlmService';
import type { ObserverStore } from './ObserverStore';
import type { TrendReport, TopicSelection, EvolutionWeights } from './types';
/**
 * TensionFieldEngine — 选题张力场（多因子版）
 *
 * 升级点：
 * - tension = contradiction + uncertainty + impact + velocity 四因子显式计算
 */
export declare class TensionFieldEngine {
    private llm;
    private store;
    constructor(llm: ObserverLlmService, store: ObserverStore);
    selectTopic(trends: TrendReport, weights?: EvolutionWeights): Promise<TopicSelection>;
    private buildCandidates;
    private pickCandidate;
    private rateNovelty;
    private calcMultiTension;
    private rateContradiction;
    private calcDiversity;
    private calcMemoryGap;
    private suggestFromObservations;
}
