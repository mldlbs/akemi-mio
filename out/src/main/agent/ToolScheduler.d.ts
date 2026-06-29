import type { ToolCallInfo } from '../llm/LlmService';
import { ServerManager } from '../mcp/ServerManager';
/** 单个工具执行结果 */
export interface ToolResult {
    id: string;
    name: string;
    success: boolean;
    content: string;
    error?: string;
    latencyMs: number;
}
/** 调度器配置 */
export interface ToolSchedulerConfig {
    /** 最大并发工具数 */
    maxConcurrency: number;
    /** 单工具超时（毫秒） */
    toolTimeoutMs: number;
    /** 失败重试次数 */
    maxRetries: number;
    /** 重试退避基数（毫秒） */
    retryBaseMs: number;
}
/**
 * ToolScheduler — 并发工具调度器
 *
 * 职责：
 * - 并行执行 LLM 一次发起的多个工具调用
 * - 单工具超时/重试
 * - 信号量限流
 * - 返回统一 ToolResult[]，按原顺序排列
 */
export declare class ToolScheduler {
    private mcpManager;
    private config;
    constructor(mcpManager: ServerManager, config?: Partial<ToolSchedulerConfig>);
    /**
     * 并发执行一批工具调用
     * 按传入顺序返回结果，失败工具会重试（最多 maxRetries 次）
     */
    executeAll(toolCalls: ToolCallInfo[], abortSignal?: AbortSignal): Promise<ToolResult[]>;
    private executeSingle;
    private callWithTimeout;
}
