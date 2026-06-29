import { LlmService } from '../llm/LlmService';
import { EngineeringMemory } from '../memory/EngineeringMemory';
import type { DecisionStore } from '../memory/DecisionStore';
import type { ResourceBudget } from '../core/ResourceBudget';
export interface ReflectionResult {
    summary: string;
    patterns: string[];
    improvements: string[];
    confidence: number;
}
/**
 * Lightweight reflect loop — runs after each agent interaction.
 * Non-blocking: fire-and-forget, stores findings in EngineeringMemory.
 */
export declare class ReflectLoop {
    private llmService;
    private engineering;
    private decisionStore;
    private resourceBudget;
    private recentReflections;
    private consecutiveReflectionFailures;
    setDeps(llmService: LlmService, engineering: EngineeringMemory): void;
    setDecisionStore(store: DecisionStore): void;
    setResourceBudget(budget: ResourceBudget): void;
    /** 触发一次反射（异步，fire-and-forget） */
    trigger(context: {
        requestId: string;
        userMessage: string;
        toolCalls?: Array<{
            name: string;
            error?: string;
        }>;
        planActive?: boolean;
        replyLength: number;
        durationMs: number;
    }): void;
    private runReflection;
    /** 格式化反思上下文，注入 system prompt */
    getFormattedContext(): string;
}
