/**
 * EventAuditor — EventBus 事件审计模块
 *
 * 订阅 agent 生命周期事件（tool.invoked/completed/failed, error, input.received, response.generated），
 * 批量写入 agent_events 表。纯本地逻辑，批量缓冲区防热路径加锁。
 *
 * 与 plugin/AuditTrail 的区别：
 * - plugin/AuditTrail 面向 plugin tool_call 权限审计
 * - EventAuditor 面向 agent 生命周期事件（EventBus 驱动）
 */
import { EventBus } from '../core/EventBus';
export type AuditEventType = 'tool_invoked' | 'tool_completed' | 'tool_failed' | 'error' | 'input_received' | 'response_generated';
export interface AuditRecord {
    id: string;
    timestamp: number;
    eventType: AuditEventType;
    agentId: string;
    source: string;
    detail: string;
    durationMs?: number;
    createdAt: number;
}
export interface AuditQuery {
    eventTypes?: AuditEventType[];
    agentId?: string;
    since?: number;
    until?: number;
    limit?: number;
    offset?: number;
}
export interface EventAuditorConfig {
    retentionHours?: number;
    flushIntervalMs?: number;
    maxBufferSize?: number;
}
export declare class EventAuditor {
    private config;
    private eventBus;
    private buffer;
    private unsubscribers;
    private flushTimer;
    private retentionTimer;
    private toolInvokedCache;
    private started;
    constructor(config?: EventAuditorConfig, bus?: EventBus);
    get retentionHours(): number;
    /** 开始订阅 EventBus 事件 */
    start(): void;
    /** 停止订阅，刷出缓冲区 */
    stop(): void;
    private onToolInvoked;
    private onToolCompleted;
    private onToolFailed;
    private onError;
    private onInputReceived;
    private onResponseGenerated;
    private truncateArgs;
    private push;
    /** 刷出缓冲区到 DB */
    flush(): void;
    private storeBatch;
    query(q?: AuditQuery): AuditRecord[];
    /** 统计摘要 */
    getStats(): {
        total: number;
        byType: Record<string, number>;
        oldest: number;
        newest: number;
    };
    /** 清理过期数据 */
    enforceRetention(): void;
}
