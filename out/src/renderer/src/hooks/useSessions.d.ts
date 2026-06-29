import type { SessionItem, MessageItem } from '../slots/types';
export declare function useSessions(): {
    readonly sessions: SessionItem[];
    readonly sessionsLoading: boolean;
    readonly activeSessionId: string;
    readonly historyMessages: MessageItem[];
    readonly historyLoading: boolean;
    readonly handleSelectChat: (sessionId: string) => void;
};
