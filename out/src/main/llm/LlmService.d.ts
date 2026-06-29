import { ConversationContext, Message } from '../agent/context';
import { ChatResult, ChunkCallback } from './types';
import { ServerManager } from '../mcp/ServerManager';
export interface ToolCallInfo {
    id: string;
    name: string;
    arguments: Record<string, any>;
}
export declare class LlmService {
    private chatApiKey;
    private codeApiKey;
    private textApiKey;
    private visionKey;
    private apiModel;
    private codeModel;
    private textModel;
    private visionModel;
    private mcpManager;
    constructor(mcpManager?: ServerManager);
    setMcpManager(manager: ServerManager): void;
    setConfig(chatKey: string, codeKey?: string, chatModel?: string, codeModel?: string): void;
    /** 设置文本处理模型的专用 key（覆盖 LLM_TEXT_KEY 默认值） */
    setTextKey(key: string): void;
    classifyIntent(userText: string, requestId?: string): Promise<ChatResult>;
    chatStream(userText: string, context: ConversationContext, onChunk: ChunkCallback, requestId?: string, timeoutMs?: number): Promise<ChatResult>;
    private _countPromptTokens;
    private _doFetch;
    private _checkStatus;
    private _readErrorBody;
    /** 发送前暂存 messages 快照，供错误诊断用 */
    private lastSentMessages;
    private _dumpToolChain;
    private _readSSEStream;
    chatWithTools(messages: Message[], requestId?: string, timeoutMs?: number, onChunk?: ChunkCallback, externalSignal?: AbortSignal): Promise<{
        reply?: string;
        toolCalls?: ToolCallInfo[];
        error?: string;
    }>;
    /**
     * 流式版 chatWithTools — 边接收 SSE token 边回调 onChunk，大幅降低首音延迟。
     */
    private _chatWithToolsStream;
    private _parseToolResponse;
    /**
     * chatJson — 轻量级 LLM 调用，返回解析后的 JSON。
     * 用于不需要 tool_loop 的场景（Insight 分析、Creativity 生成等）。
     * 返回 { data: 解析后的 JSON } 或 { error: 错误信息 }。
     */
    chatJson(userText: string, options?: {
        system?: string;
        temperature?: number;
        timeoutMs?: number;
        requestId?: string;
    }): Promise<{
        data?: any;
        error?: string;
    }>;
    /**
     * chatJsonWithCode — 使用 code 模型的轻量级 LLM 调用，返回解析后的 JSON。
     * 与 chatJson() 签名/返回一致，但路由到 LLM_CODE_API_URL + this.codeModel。
     * 用于需要更强模型能力的场景（创造力生成、复杂分析等）。
     */
    chatJsonWithCode(userText: string, options?: {
        system?: string;
        temperature?: number;
        timeoutMs?: number;
        requestId?: string;
    }): Promise<{
        data?: any;
        error?: string;
    }>;
    /**
     * chatText — 使用文本处理模型（text）进行纯文本任务，不携带 tools。
     * 适用于摘要、提取、重写、分析等场景，避免占用 code 模型的限额。
     */
    chatText(userText: string, options?: {
        system?: string;
        temperature?: number;
        timeoutMs?: number;
        requestId?: string;
    }): Promise<ChatResult>;
    /**
     * chatVision — 使用视觉模型处理图片理解任务。
     * messages 中的 user message content 应使用 OpenAI 多模态格式：
     *   [{ type: 'text', text: '描述这张图片' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }]
     */
    chatVision(messages: Message[], options?: {
        system?: string;
        temperature?: number;
        timeoutMs?: number;
        requestId?: string;
    }): Promise<ChatResult>;
}
