import { useState, useEffect, useCallback, useRef } from 'react';
import { useIPCEvent } from './useIPCEvent';
const EMPTY = [];
export function useSessions() {
    const [sessions, setSessions] = useState([]);
    const [sessionsLoading, setSessionsLoading] = useState(true);
    const [activeSessionId, setActiveSessionId] = useState('');
    const [historyMessages, setHistoryMessages] = useState([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    const skipDbLoadRef = useRef(false);
    useEffect(() => {
        window.electronAPI
            .getSessions()
            .then((s) => {
            setSessions(s);
            if (s.length > 0) {
                setActiveSessionId((prev) => prev || s[0].id);
            }
        })
            .catch(() => { })
            .finally(() => setSessionsLoading(false));
    }, []);
    // DB 加载只用于 mount/handleSelectChat，onMessageNew 触发的切换跳过
    useEffect(() => {
        if (!activeSessionId)
            return;
        if (skipDbLoadRef.current) {
            skipDbLoadRef.current = false;
            return;
        }
        setHistoryLoading(true);
        window.electronAPI
            .getMessagesBySession(activeSessionId)
            .then((msgs) => setHistoryMessages(msgs))
            .catch(() => setHistoryMessages([]))
            .finally(() => setHistoryLoading(false));
    }, [activeSessionId]);
    useIPCEvent(window.electronAPI.onMessageNew, (msg) => {
        if (!msg.sessionId)
            return;
        if (msg.sessionId !== activeSessionId) {
            skipDbLoadRef.current = true;
            setActiveSessionId(msg.sessionId);
        }
        setHistoryMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
        window.electronAPI
            .getSessions()
            .then((s) => setSessions(s))
            .catch(() => { });
    });
    const handleSelectChat = useCallback((sessionId) => {
        setActiveSessionId(sessionId);
        setHistoryMessages([]);
    }, []);
    return { sessions, sessionsLoading, activeSessionId, historyMessages, historyLoading, handleSelectChat };
}
