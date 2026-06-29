import type { ObserverLlmService } from './ObserverLlmService';
import type { ObserverStore } from './ObserverStore';
import type { TopicCandidate, ResearchResult } from './types';
/**
 * DeepResearchEngine — 三阶段深度研究（带分层 fallback）
 *
 * 升级点：
 * - 每阶段失败后自动降级（reduce_depth）
 * - Level 0: 完整三阶段
 * - Level 1: expansion + conflict（跳过 structural）
 * - Level 2: 仅 expansion
 * - Level 3: LLM 直接生成 summary
 */
export declare class DeepResearchEngine {
    private llm;
    private store;
    constructor(llm: ObserverLlmService, store: ObserverStore);
    research(topic: TopicCandidate, relatedObs: string[]): Promise<ResearchResult>;
    private generateFallbackSummary;
    private runPhase;
    private buildPhasePrompt;
    private assemble;
    private tryParseJson;
}
