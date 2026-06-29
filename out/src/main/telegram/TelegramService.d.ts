import { AgentService } from '../agent/AgentService';
/** 延迟编辑调度：将频繁的 progress 更新 debounce 后直接 HTTP 编辑（不走 outbox，保证实时性） */
export declare class DebouncedEditor {
    private baseUrl;
    private timer;
    private pendingChatId;
    private pendingText;
    private pendingTargetMsgId;
    private pendingBot;
    /** 在 TelegramService 初始化后设置真实的 baseUrl */
    setBaseUrl(url: string): void;
    schedule(chatId: number, targetMessageId: number, text: string, bot?: string): void;
    private flush;
    cancel(): void;
    flushNow(): void;
}
export declare class TelegramService {
    private agentService;
    private baseUrl;
    private pollTimer;
    private isRunning;
    private retryQueue;
    private activeSessions;
    private pushChatId;
    private pushSessions;
    constructor(agentService: AgentService);
    initialize(): Promise<void>;
    private reconnectTimer;
    private reconnectAttempts;
    private scheduleReconnect;
    private startPolling;
    private staleCleanupCounter;
    private poll;
    private handleMessage;
    private subscribePushEvents;
    private handlePushInput;
    private handlePushResponse;
    private refreshPushMessage;
    private cleanupPushSession;
    /** 清理 10 分钟前的孤儿 push session（防泄漏） */
    private cleanupStalePushSessions;
    private enqueueReply;
    private enqueueEdit;
    private enqueueAction;
    /** sendMessage 需要同步拿到 messageId，因此直接 HTTP 调用 */
    private sendMessageSync;
    private refreshProgressMessage;
    private handleGenBotMessage;
    private sendGenReply;
    private handleToolPhoto;
    stop(): void;
    private cleanupSession;
    private cleanupSessionByKey;
}
