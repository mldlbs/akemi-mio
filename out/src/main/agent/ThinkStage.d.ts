/**
 * ThinkStage — OTPAR Think 阶段
 *
 * 当 LLM 提出大量工具调用且无文本回复时，
 * 注入策略提示要求 LLM 先说明整体策略再执行。
 * 纯 prompt 注入，无额外 LLM 调用。
 */
import type { ToolCallInfo } from '../llm/LlmService';
import type { Message } from './context';
import type { RunContext } from './runstate';
export interface ThinkStageConfig {
    toolCallThreshold: number;
    minReplyLength: number;
    maxPerSession: number;
}
export interface ThinkResult {
    injected: boolean;
}
export declare function runThink(toolCalls: ToolCallInfo[], reply: string | undefined | null, messages: Message[], ctx: RunContext, config?: Partial<ThinkStageConfig>): ThinkResult;
