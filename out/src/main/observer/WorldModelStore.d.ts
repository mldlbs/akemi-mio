import type { ObserverLlmService } from './ObserverLlmService';
import type { ObserverStore } from './ObserverStore';
import type { ResearchResult, InsightOutput } from './types';
/**
 * WorldModelStore — 世界模型 / 记忆图谱（增强版）
 *
 * 升级点：
 * - 新增 uncertainties 跟踪（来自 conflict 分析中的不确定性）
 * - 新增 relations 显式实体关系图
 * - conflict 分析输出映射为 uncertainties + relations
 */
export declare class WorldModelStore {
    private llm;
    private storeRef;
    constructor(llm: ObserverLlmService, store: ObserverStore);
    update(result: ResearchResult, insight: InsightOutput): Promise<void>;
    private extractEntities;
    private updateTrends;
    private updateNarratives;
    private createNarrative;
    private extractUncertainties;
    private extractRelations;
}
