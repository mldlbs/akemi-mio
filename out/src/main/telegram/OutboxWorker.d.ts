/**
 * OutboxWorker — 从 telegram_outbox 拉取 pending 消息并投递到 Telegram 代理服务器。
 * 由 TaskRunner 定时触发，自带重试和退避机制。
 */
export declare class OutboxWorker {
    private baseUrl;
    private cleanupCounter;
    constructor(baseUrl: string);
    /** 单次 tick：扫描 pending 消息并发投递。每 60 次 tick 清理一次过期消息 */
    tick(): Promise<{
        success: boolean;
        summary?: string;
    }>;
    private deliver;
    private fetch;
}
