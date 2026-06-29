import type { Message } from './context';
export interface IntegrityIssue {
    type: 'ORPHANED_TOOL_CALL' | 'MISSING_TOOL_RESPONSE' | 'EMPTY_TOOL_CALL_ID' | 'INTERLEAVED_USER_MESSAGE';
    index: number;
    description: string;
}
/**
 * 校验消息链中 tool_call 结构的完整性。
 * 在发往 LLM API 前调用，阻止已知会触发 400 的脏状态。
 *
 * 检查项：
 * 1. 每个 assistant(tool_calls) 后必须至少有一条 tool 消息响应
 * 2. 每个 tool_call 必须有非空 id
 * 3. user 消息不得插入在 assistant(tool_calls) 和其 tool 响应之间
 */
export declare function validateToolCallChain(messages: Message[]): {
    valid: boolean;
    issues: IntegrityIssue[];
};
/**
 * 从检查点数据重建消息上下文，回滚到最近的健康状态。
 * 检查点不保存完整 messages[]，因此通过 shortTermMemory 重构：
 * 1. 保留 system prompt
 * 2. 注入 shortTermMemory 中的 user/assistant 对
 * 3. 重新添加当前 user 消息
 */
export declare function rollbackToLastKnownGood(messages: Message[], shortTermMemory: Array<{
    user: string;
    assistant: string;
}>, lastUserMessage?: string): void;
