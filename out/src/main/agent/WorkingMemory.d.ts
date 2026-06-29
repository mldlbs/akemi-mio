/**
 * WorkingMemory — 认知工作记忆
 *
 * 封装当前轮次的 LLM 上下文 + 中间推理产物 + 注意力焦点。
 * 所有 LLM context 构建统一经过这里，消除 messages.push 注入 hack。
 *
 * P0 层级，每个 ChatExecutor/TaskExecutor 持有独立实例。
 */
import { ConversationContext, Message } from './context';
export interface ScratchEntry {
    type: 'observe' | 'think' | 'reflect' | 'system_hint' | 'error_hint';
    content: string;
    timestamp: number;
}
export declare class Scratchpad {
    private entries;
    /** 添加一条推理/观察记录到 scratchpad */
    add(type: ScratchEntry['type'], content: string): void;
    /** 获取所有未消费的条目并清空 */
    flush(): ScratchEntry[];
    /** 提取上次 flush 后的新条目 */
    flushNew(lastCount: number): ScratchEntry[];
    /** 将 scratchpad 条目渲染为 messages 注入对话 */
    injectInto(messages: Message[], asType?: 'system' | 'user'): number;
    /** 查看当前条目数（不消费） */
    get size(): number;
    clear(): void;
}
export interface AttentionEntity {
    name: string;
    type: 'user_preference' | 'file' | 'project' | 'concept' | 'task';
    relevance: number;
    lastMentioned: number;
}
export declare class AttentionSet {
    private entities;
    private decayRate;
    /** 关注一个实体 */
    add(name: string, type: AttentionEntity['type'], relevance?: number): void;
    /** 从文本中提取并关注实体 */
    extractFrom(text: string): void;
    /** 获取当前注意力实体列表（按相关度排序） */
    getActive(threshold?: number): AttentionEntity[];
    /** 格式化注意力上下文，注入 system prompt 用 */
    getFormattedContext(limit?: number): string;
    /** 交互结束时衰减或移除旧实体 */
    tick(): void;
}
export declare class WorkingMemory {
    context: ConversationContext;
    readonly scratchpad: Scratchpad;
    attention: AttentionSet;
    private mode;
    private tickCount;
    constructor(mode: 'chat' | 'task' | 'evolution', memoryContext?: string, maxTokens?: number, extraModules?: string[], customSystemPrompt?: string, reflectionContext?: string, identityContext?: string);
    /** 添加用户消息并记录注意力 */
    addUser(text: string): void;
    /** 添加助手回复 */
    addAssistant(text: string, toolCalls?: Array<{
        name: string;
        arguments?: Record<string, unknown>;
    }>): void;
    /** 添加工具结果 */
    addToolResult(toolCallId: string, content: string): void;
    /** 在 LLM 调用前，将 scratchpad 注入消息数组 */
    injectScratchpad(messages: Message[]): number;
    /** 交互结束回调 */
    tick(userText?: string): void;
    /** 刷新记忆上下文（保留对话历史，只重建 system prompt）
     *  @param clearHistory - 设为 true 时同时清除历史（workflow 激活等场景需要全刷新）
     */
    refreshMemory(memoryContext?: string, reflectionContext?: string, extraModules?: string[], identityContext?: string, clearHistory?: boolean): void;
    /** 获取消息列表 */
    getMessages(): Message[];
    /** 裁剪 token */
    trimToTokenBudget(maxTokens?: number): void;
    /** 清空但不失上下文 */
    clear(keepShortTerm?: boolean): void;
    /** 当前累积的对话轮次 */
    get interactionCount(): number;
}
