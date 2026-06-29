import { useState, useEffect, useCallback, useRef } from 'react';
import { playTTS, playTTSBuffer, onTTSStart, onTTSError } from '../components/audioShared';
import { useIPCEvent } from './useIPCEvent';
import { useTimerControl } from './useTimer';
export function useAIOutput(activeSessionId, voiceActive, onError) {
    const [pendingText, setPendingText] = useState('');
    const [displayText, setDisplayText] = useState('');
    const [transcribed, setTranscribed] = useState('');
    const [toolStatus, setToolStatus] = useState(null);
    const [agentState, setAgentState] = useState('idle');
    const fadeTimer = useTimerControl();
    const revealTimer = useTimerControl();
    const textRef = useRef('');
    // 切换会话时立即清空所有 streaming 状态
    const sessionRef = useRef(activeSessionId);
    useEffect(() => {
        if (sessionRef.current !== activeSessionId) {
            sessionRef.current = activeSessionId;
            setPendingText('');
            setDisplayText('');
            setTranscribed('');
            setToolStatus(null);
            setAgentState('idle');
            revealTimer.clear();
            fadeTimer.clear();
        }
    }, [activeSessionId, revealTimer, fadeTimer]);
    useEffect(() => {
        textRef.current = pendingText;
    }, [pendingText]);
    // TTS display reveal (mount-only)
    useEffect(() => {
        const onStart = (duration) => {
            const t = textRef.current;
            if (!t)
                return;
            revealTimer.clear();
            setDisplayText('');
            const totalMs = duration * 1000;
            const intervalMs = Math.max(20, totalMs / t.length);
            let i = 0;
            revealTimer.setInterval(() => {
                i++;
                setDisplayText(t.slice(0, i));
                if (i >= t.length)
                    revealTimer.clear();
            }, intervalMs);
        };
        const onErr = (err) => {
            onError?.(err);
        };
        onTTSStart(onStart);
        onTTSError(onErr);
        return () => {
            revealTimer.clear();
            fadeTimer.clear();
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    useIPCEvent(window.electronAPI.onAIChunk, (chunk) => {
        setPendingText((prev) => prev + chunk);
        setAgentState((s) => (s === 'thinking' || s === 'idle' ? 'replying' : s));
        fadeTimer.clear();
    });
    useIPCEvent(window.electronAPI.onTTSAudio, (filePath) => {
        playTTS(filePath);
    });
    useIPCEvent(window.electronAPI.onTTSBuffer, (buf) => {
        playTTSBuffer(buf);
    });
    // 带 sessionId 的 message:new = 最终完整消息；无 sessionId 的（中间 tool 输出）不清除 streaming 状态
    useIPCEvent(window.electronAPI.onMessageNew, (msg) => {
        if (msg.sessionId && msg.role === 'assistant') {
            setPendingText('');
            setDisplayText('');
            setTranscribed('');
            setAgentState('idle');
            revealTimer.clear();
        }
    });
    useIPCEvent(window.electronAPI.onToolStatus, (status) => {
        if (status.type === 'start') {
            setToolStatus(status);
            setAgentState('tool_executing');
        }
        else {
            setToolStatus(null);
            setAgentState((s) => (s === 'tool_executing' ? 'replying' : s));
        }
    });
    const handleResult = useCallback(async (t) => {
        if (!t)
            return;
        setTranscribed(t);
        setAgentState('thinking');
        onError?.(undefined);
        setPendingText('');
        setDisplayText('');
        setToolStatus(null);
        revealTimer.clear();
        try {
            await window.electronAPI.chat(t, undefined, activeSessionId || undefined, !voiceActive);
        }
        catch (err) {
            onError?.(String(err));
        }
        fadeTimer.set(() => {
            setPendingText('');
            setDisplayText('');
            setTranscribed('');
            setAgentState('idle');
        }, 10000);
    }, [activeSessionId, voiceActive, onError]); // eslint-disable-line react-hooks/exhaustive-deps
    return { pendingText, displayText, transcribed, toolStatus, agentState, handleResult };
}
