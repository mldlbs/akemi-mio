/**
 * ExecutionGovernor — tool batch 执行后的强制决策门。
 *
 * 每次工具执行完毕，必须经过 Governor 做出明确决策才能继续：
 *   - continue: 正常推进
 *   - stop:     终止执行链，不再调用 LLM
 *   - shift:    注入策略切换消息，LLM 下轮必须重新规划
 *
 * 与 Guardrail 的核心区别：Guardrail 是阈值计数，达标才干预；
 * Governor 每轮都做模式识别，输出的是执行决策，不是建议。
 */
import type { ToolCallInfo } from '../llm/LlmService';
import type { ToolResult } from './ToolScheduler';
import type { RunContext } from './runstate';
export type GovernorAction = 'continue' | 'stop' | 'shift';
export interface GovernorDecision {
    action: GovernorAction;
    reason: string;
    /** 当 action 为 stop 或 shift 时注入 messages 的消息内容 */
    message?: string;
}
export declare class ExecutionGovernor {
    /**
     * 上一轮的失败工具：{ toolName → argKey }
     * argKey 是关键参数的 stringified 摘要，用于判断是否重复相同操作。
     */
    private lastFailedTools;
    /** 连续有失败工具的轮数 */
    private cascadeCount;
    /**
     * 清理 governor 状态（新 session / 重置时调用）
     */
    reset(): void;
    /**
     * 每轮批执行后的强制决策门。
     * 需要在 toolResults 已推入 messages、runReflect 执行完毕、Guardrail.apply 执行完毕后调用。
     */
    evaluate(toolResults: ToolResult[], toolCalls: ToolCallInfo[], ctx: RunContext): GovernorDecision;
    /** 工具的失败签名：工具名 + 关键参数，用于判断是否重复相同操作 */
    private failureKey;
    /** 清空内部状态（stop / shift 后立即调用） */
    private resetState;
}
