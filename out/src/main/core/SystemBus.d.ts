import type { EventBus, EventName } from './EventBus';
export interface BridgeRule {
    event: EventName;
    command?: CommandChannel;
    query?: QueryChannel;
    mapPayload?: (payload: any) => any;
}
export type QueryChannel = 'utility-score' | 'resource-status' | 'goal-context' | 'memory-insight';
export type CommandChannel = 'guardrail.inject-feedback' | 'evolution.adjust-priority' | 'memory.consolidate-now';
export interface QueryContext {
    traceId: string;
    depth: number;
    toolCallName?: string;
    toolCallArgs?: Record<string, unknown>;
    [key: string]: unknown;
}
export interface QueryResult<T = unknown> {
    channel: QueryChannel;
    handlerName: string;
    success: boolean;
    value: T | null;
    latencyMs: number;
    error?: string;
}
export interface AggregatedResult<T = unknown> {
    channel: QueryChannel;
    results: QueryResult<T>[];
    composite: T | null;
    traceId: string;
    totalLatencyMs: number;
    timedOut: boolean;
}
export interface CommandResult<T = unknown> {
    success: boolean;
    value: T | null;
    error?: string;
    latencyMs: number;
}
export type QueryHandler<T = unknown> = (ctx: QueryContext) => Promise<T> | T;
export type CommandHandler<T = unknown, P = unknown> = (payload: P) => Promise<CommandResult<T>> | CommandResult<T>;
export interface HandlerRegistration {
    name: string;
    channel: QueryChannel | CommandChannel;
    type: 'query' | 'command';
    dependencies: string[];
    timeoutMs: number;
    getFallback: () => unknown;
}
export declare class SystemBus {
    private queryHandlers;
    private commandHandlers;
    private frozen;
    private bridgeDisposers;
    /**
     * bridgeFrom — 当 EventBus 事件触发时，自动转发到 SystemBus command/query。
     * 实现"事件→命令"闭环。
     * 每个桥接规则返回一个 disposer，调用 stopBridge() 可统一解除。
     */
    bridgeFrom(eventBus: EventBus, rules: BridgeRule[]): void;
    stopBridge(): void;
    registerQuery<T>(channel: QueryChannel, name: string, handler: QueryHandler<T>, options?: {
        dependencies?: string[];
        timeoutMs?: number;
        fallback?: T;
    }): void;
    registerCommand<T, P>(channel: CommandChannel, name: string, handler: CommandHandler<T, P>, options?: {
        dependencies?: string[];
        timeoutMs?: number;
    }): void;
    freeze(): void;
    /**
     * 向 channel 所有 handler 发起并行查询。
     * 超时 handler 自动降级为 fallback。
     * depth > MAX_BUS_DEPTH → 循环保护，直接 fallback。
     */
    query<T>(channel: QueryChannel, context?: Partial<QueryContext>): Promise<AggregatedResult<T>>;
    execute<T, P>(channel: CommandChannel, payload: P): Promise<CommandResult<T>>;
    validateDAG(): {
        valid: boolean;
        cycles: string[][];
    };
    getStats(): {
        queries: number;
        commands: number;
        frozen: boolean;
    };
    private aggregateChannel;
}
export declare const systemBus: SystemBus;
