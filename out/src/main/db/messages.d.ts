export interface StoredMessage {
    id: string;
    source: 'electron' | 'telegram';
    role: 'user' | 'assistant';
    content: string;
    category: string;
    sessionId?: string;
    telegramChatId?: number | null;
    telegramUserId?: number | null;
    telegramFrom?: string | null;
    telegramMessageId?: number | null;
    createdAt: number;
}
export interface SessionItem {
    id: string;
    source: 'electron' | 'telegram';
    category: string;
    label: string;
    messageCount: number;
    lastActivityAt: number;
    createdAt: number;
}
export declare function createMessageId(): string;
declare function createSessionId(): string;
export declare function insertMessage(msg: StoredMessage): void;
export declare function getRecentMessages(limit?: number): StoredMessage[];
export declare function getSessions(): SessionItem[];
export declare function getMessagesBySession(sessionId: string): StoredMessage[];
/** 获取最后一条消息的 session_id（用于自动分组） */
export declare function getLastSessionId(): string | null;
/** 获取最后一条消息的时间戳 */
export declare function getLastMessageTime(): number | null;
export { createSessionId };
