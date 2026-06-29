/**
 * TaskExecutor — Evolution Runtime 独立执行器
 *
 * 专用于 SelfEvolutionService.runSelfTask 的后台执行循环。
 * - 30 轮 toolLoop 上限
 * - 每次 LLM 调用前检查/消耗 evolution budget (max 50)
 * - AbortSignal 支持暂停/取消（Pause/Resume 模式）
 * - 无 TTS、无 forceContinue、无 subAgent 监控
 */
import type { LlmService } from '../llm/LlmService';
import { Message } from './context';
import { Guardrail } from './Guardrail';
import { ToolScheduler } from './ToolScheduler';
import type { PlanManagerLike } from '../evolution/types';
import { ResourceBudget } from '../core/ResourceBudget';
import { RunContext } from './runstate';
export interface SavedTaskState {
    messages: Message[];
    step: number;
    consecutiveTimeouts: number;
}
export declare class TaskExecutor {
    private llmService;
    private toolScheduler;
    private guardrail;
    private planManager;
    private resourceBudget;
    /** Pause/resume state */
    private _pauseRequested;
    private _resumeState;
    /** OTPAR */
    private proceduralMemory;
    private failureAnalyzer;
    private thinkStageCount;
    private executionGovernor;
    constructor(llmService: LlmService, toolScheduler: ToolScheduler, guardrail: Guardrail, planManager: PlanManagerLike, resourceBudget: ResourceBudget);
    /** Request graceful pause — current LLM call is aborted, state is saved for resume */
    pause(): void;
    /** Consume saved state (returns null if none) */
    consumeSavedState(): SavedTaskState | null;
    /** Whether saved state exists (for pause detection) */
    hasSavedState(): boolean;
    run(messages: Message[], ctx: RunContext, abortSignal?: AbortSignal): Promise<string>;
}
