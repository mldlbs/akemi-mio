import type { IdentityModule } from '../identity';
import type { EngineeringMemory } from '../memory/EngineeringMemory';
import type { ProceduralMemory } from '../agent/ProceduralMemory';
import type { LlmService } from '../llm/LlmService';
export interface MetaReview {
    id: string;
    periodStart: number;
    periodEnd: number;
    summary: string;
    patterns: string[];
    improvements: string[];
    traitDeltas: Record<string, number>;
    createdAt: number;
}
export declare class MetaCycle {
    private identity;
    private engineeringMemory;
    private proceduralMemory;
    private llmService;
    private lastReview;
    private periodStart;
    initialize(deps: {
        identity: IdentityModule;
        engineeringMemory: EngineeringMemory;
        proceduralMemory: ProceduralMemory;
        llmService: LlmService;
    }): void;
    /** 收集快照数据 */
    collectSnapshot(): {
        traits: string;
        metrics: string;
        failurePatterns: string;
        procedures: string;
    };
    /** 调用 LLM 生成评估报告 */
    generateReview(context: {
        traits: string;
        metrics: string;
        failurePatterns: string;
        procedures: string;
    }): Promise<{
        summary: string;
        patterns: string[];
        improvements: string[];
        traitAdjustments: Record<string, number>;
        confidence: number;
    } | null>;
    /** 应用评估结果 */
    applyReview(review: {
        summary: string;
        patterns: string[];
        improvements: string[];
        traitAdjustments: Record<string, number>;
        confidence: number;
    }): void;
    /** 完整运行一次评估循环 */
    run(): Promise<void>;
    /** 格式化上下文注入 */
    getFormattedContext(): string;
    private loadLatestReview;
}
