/**
 * ObserveStage — OTPAR Observe 阶段
 *
 * 在 LLM 返回 toolCalls 后、Guardrail 之前运行。
 * 查询 ProceduralMemory 和 FailureAnalyzer 获取与当前工具相关的上下文。
 * 纯本地逻辑，无额外 LLM 调用，<50ms。
 */
import type { ToolCallInfo } from '../llm/LlmService';
import type { Message } from './context';
import type { RunContext } from './runstate';
import type { ProceduralMemory } from './ProceduralMemory';
import type { FailureAnalyzer } from './FailureAnalyzer';
export interface ObserveResult {
    injected: boolean;
    proceduresFound: number;
    patternsFound: number;
}
export declare function runObserve(toolCalls: ToolCallInfo[], messages: Message[], ctx: RunContext, deps: {
    proceduralMemory: ProceduralMemory | null;
    failureAnalyzer: FailureAnalyzer | null;
}): ObserveResult;
