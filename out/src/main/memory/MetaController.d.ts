/**
 * MetaController — P3 记忆层级编排
 *
 * 职责：
 * 1. P0→P1 沉淀：每个交互结束时判断是否需要生成摘要和决策记录
 * 2. P1→P2 提纯：周期性将摘要/决策提纯为长期记忆
 * 3. 策略自适应：根据负载和命中率调整各层参数
 * 4. 后台优化：去重/沉默证据清洗/老旧决策过期
 *
 * 区别于 MetaCycle（长期自我评估，LLM 驱动的身份/特质/模式分析），
 * MetaController 是轻量策略引擎，纯本地逻辑，<10ms。
 */
import type { SummaryMemory } from '../memory/SummaryMemory';
import type { DecisionStore } from '../memory/DecisionStore';
import type { MemoryService } from '../memory/MemoryService';
export interface MetaPolicy {
    /** 每 N 轮对话触发一次摘要生成 */
    summaryFrequency: number;
    /** Token 使用超此比例（0-1）触发摘要 */
    summaryTokenThreshold: number;
    /** 决策采样率 0-1 */
    decisionLogChance: number;
    /** 提纯间隔（ms） */
    consolidationInterval: number;
    /** 至少积累多少条才触发提纯 */
    consolidationMinEntries: number;
    /** 修剪激进程度 0-1 */
    pruneAggressiveness: number;
    /** 覆盖默认衰减率 */
    decayRateOverride?: Record<string, number>;
    /** 上次策略调整时间 */
    lastAdaptation: number;
}
export declare const DEFAULT_POLICY: MetaPolicy;
interface RunStats {
    totalInteractions: number;
    summariesCreated: number;
    decisionsLogged: number;
    consolidationsRun: number;
    lastConsolidation: number;
    memoryHitRate: number;
    totalQueries: number;
    hitQueries: number;
}
export declare class MetaController {
    private policy;
    private stats;
    private summary;
    private decisions;
    private memory;
    private tickSinceLastSummary;
    constructor(policy?: Partial<MetaPolicy>);
    setDeps(deps: {
        summary: SummaryMemory;
        decisions: DecisionStore;
        memory: MemoryService;
    }): void;
    getPolicy(): Readonly<MetaPolicy>;
    getStats(): Readonly<RunStats>;
    onInteractionEnd(context: {
        userMessage: string;
        assistantReply: string;
        tokenUsed: number;
        tokenBudget: number;
        planActive: boolean;
        agentId: string;
    }): void;
    private shouldSummarize;
    private shouldLogDecision;
    private createSummary;
    private logDecision;
    backgroundOptimization(): Promise<void>;
    private consolidateSummaries;
    recordMemoryQuery(hit: boolean): void;
    private adaptPolicy;
}
export {};
