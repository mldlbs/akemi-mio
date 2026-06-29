export interface ToolCall {
    id: string;
    type: string;
    function: {
        name: string;
        arguments: string;
    };
    result?: string;
}
export interface Message {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_call_id?: string;
    tool_calls?: ToolCall[];
}
export declare function buildSystemPrompt(memoryContext?: string, extraModules?: string[], reflectionContext?: string, identityContext?: string): string;
export declare function getBasePromptTokens(): number;
export declare function estimateTokens(text: string | null | undefined): number;
/** 完整估算一条消息的 token 数（含 content + tool_calls + tool_call_id） */
export declare function estimateMessageTokens(msg: Message): number;
export declare class ConversationContext {
    private _context;
    private systemPrompt;
    private maxTokens;
    private shortTermMemory;
    constructor(memoryContext?: string, maxTokens?: number, extraModules?: string[], customSystemPrompt?: string, reflectionContext?: string, identityContext?: string);
    get context(): Message[];
    addUser(text: string): void;
    addAssistant(text: string, toolCalls?: ToolCall[]): void;
    addToolCall(call: ToolCall): void;
    saveToShortTermMemory(keep?: number): void;
    getShortTermMemoryContext(): string;
    trimToTokenBudget(maxTokens?: number): void;
    /**
     * 只重建 system prompt（index 0），保留对话历史。
     * 由 WorkingMemory.refreshMemory() 调用，取代 new ConversationContext() 销毁历史。
     */
    rebuildSystemPrompt(memoryContext?: string, extraModules?: string[], reflectionContext?: string, identityContext?: string): void;
    clear(keepShortTerm?: boolean): void;
    /**
     * 向上下文注入一条辅助消息（用于会话纠偏）。
     * 插入在最后一个 user 消息之后。
     */
    addSystemMessage(content: string): void;
    getShortTermMemoryPairs(): Array<{
        user: string;
        assistant: string;
    }>;
    /**
     * 移除孤立的 assistant(tool_calls) 消息，确保每对 assistant(tool_calls) → tool 完整。
     * 支持两种孤儿检测：
     * 1. 完全孤儿：assistant 有 tool_calls，后面完全没有 tool 消息
     * 2. 部分孤儿：assistant 有 N 个 tool_calls，但只收到 M < N 条对应的 tool 消息
     */
    trimOrphanedToolCalls(): void;
    getMessages(): Message[];
}
/** 从任意消息数组中移除孤立的 assistant(tool_calls) 消息 */
export declare function trimOrphanedToolCallsFrom(messages: Message[]): void;
