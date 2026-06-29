/**
 * ReflectStage — OTPAR Reflect 阶段（同步、行内）
 *
 * 在工具执行结果推入 messages[] 后、Guardrail 之前运行。
 * 与 ReflectLoop（fire-and-forget setTimeout）互补：
 * - ReflectStage: 同步，同一 toolLoop 轮次可见
 * - ReflectLoop: 异步，跨对话持久化到 EngineeringMemory
 *
 * 纯本地逻辑，无额外 LLM 调用。
 */
import type { ToolResult } from './ToolScheduler';
import type { ToolCallInfo } from '../llm/LlmService';
import type { Message } from './context';
import type { RunContext } from './runstate';
export interface ReflectResult {
    injected: boolean;
    summary: string;
}
export declare function runReflect(toolResults: ToolResult[], toolCalls: ToolCallInfo[], messages: Message[], ctx: RunContext): ReflectResult;
