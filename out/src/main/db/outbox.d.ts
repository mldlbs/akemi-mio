export type OutboxCategory = 'dialogue' | 'evolution' | 'insight' | 'creativity' | 'plan' | 'budget' | 'recovery' | 'stability' | 'system';
export interface OutboxRow {
    id?: number;
    chatId: string;
    bot?: 'chat' | 'push' | 'gen' | 'write';
    msgType: 'send' | 'edit' | 'reply' | 'action' | 'photo' | 'media_group';
    category?: OutboxCategory;
    message: string;
    targetMessageId?: number;
    hash?: string;
    status?: 'pending' | 'sent' | 'failed';
    retryCount?: number;
    lastError?: string;
    createdAt?: number;
    updatedAt?: number;
}
/** 写入一条 pending 消息到 outbox。自动去重：相同 hash 的 pending/sent 消息不会重复写入 */
export declare function insertOutbox(row: OutboxRow): number;
/** 拉取待发送消息（最多 limit 条） */
export declare function getPendingOutbox(limit?: number): OutboxRow[];
/** 标记为已发送 */
export declare function markOutboxSent(id: number): void;
/** 标记失败：retryCount < 3 翻回 pending；>= 3 删除，返回 true 表示已放弃 */
export declare function markOutboxFailed(id: number, error: string): boolean;
/** 幂等检查：相同 hash 的 pending/sent 消息是否已存在 */
export declare function outboxExists(hash: string): boolean;
/** 清理过期 sent 消息（保留 24h）和放弃的 failed 消息（retry_count >= 3） */
export declare function cleanupOutbox(): number;
