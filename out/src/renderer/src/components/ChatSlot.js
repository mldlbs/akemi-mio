import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useCallback, useState } from 'react';
function CopyButton({ text }) {
    const [copied, setCopied] = useState(false);
    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        }
        catch {
            /* ignore */
        }
    }, [text]);
    return (_jsx("button", { className: `msg-copy-btn${copied ? ' copied' : ''}`, onClick: handleCopy, title: "\u590D\u5236", children: _jsx("i", { className: `ri-${copied ? 'check-line' : 'file-copy-line'}` }) }));
}
const AGENT_LABELS = {
    idle: null,
    thinking: '思考中…',
    tool_executing: '执行工具…',
    replying: null,
};
export function ChatSlot({ messages, pendingText, displayText, transcribed, toolStatus, agentState, toolRunning, toolCompleted, historyLoading, }) {
    const bottomRef = useRef(null);
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, displayText, toolRunning, toolCompleted]);
    const hasPending = !!pendingText;
    const agentLabel = AGENT_LABELS[agentState];
    const hasTools = toolRunning.length > 0 || toolCompleted.length > 0;
    const showEmpty = messages.length === 0 && !hasPending && !transcribed && !hasTools && !agentLabel && !historyLoading;
    // 加载中状态
    if (historyLoading) {
        return (_jsx("div", { className: "chat-slot", children: _jsxs("div", { className: "chat-empty", children: [_jsx("div", { className: "chat-empty-icon", children: _jsx("i", { className: "ri-loader-4-line ri-spin" }) }), _jsx("div", { className: "chat-empty-text", children: "\u52A0\u8F7D\u4E2D\u2026" })] }) }));
    }
    if (showEmpty) {
        return (_jsx("div", { className: "chat-slot", children: _jsxs("div", { className: "chat-empty", children: [_jsx("div", { className: "chat-empty-icon", children: _jsx("i", { className: "ri-chat-1-line" }) }), _jsx("div", { className: "chat-empty-text", children: "\u5F00\u59CB\u4E00\u6BB5\u65B0\u5BF9\u8BDD" })] }) }));
    }
    return (_jsxs("div", { className: "chat-slot", children: [agentLabel && (_jsxs("div", { className: "agent-indicator", children: [_jsx("span", { className: "agent-indicator-dot" }), _jsx("span", { className: "agent-indicator-text", children: agentLabel })] })), transcribed && (_jsxs("div", { className: "msg msg-row user", children: [_jsx("div", { className: "msg-label", children: "\u4F60" }), _jsx("div", { className: "msg-bubble", children: transcribed }), _jsx("div", { className: "msg-actions", children: _jsx(CopyButton, { text: transcribed }) })] })), messages.map((m) => (_jsxs("div", { className: `msg msg-row ${m.role}`, children: [_jsx("div", { className: "msg-label", children: m.role === 'user' ? '你' : '秋山澪' }), _jsx("div", { className: "msg-bubble", children: m.content }), _jsxs("div", { className: "msg-actions", children: [_jsx(CopyButton, { text: m.content }), _jsx("span", { className: "msg-time", children: new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) })] })] }, m.id))), toolRunning.length > 0 && (_jsx("div", { className: "tool-inline-group", children: toolRunning.map((t) => (_jsxs("div", { className: "tool-inline tool-inline-running", children: [_jsx("i", { className: "ri-loader-4-line ri-spin" }), _jsx("span", { className: "tool-inline-name", children: t.tool }), t.args && _jsx("span", { className: "tool-inline-args", children: JSON.stringify(t.args).slice(0, 80) })] }, t.id))) })), toolCompleted.length > 0 && (_jsx("div", { className: "tool-inline-group", children: toolCompleted.map((t) => (_jsxs("div", { className: `tool-inline ${t.error ? 'tool-inline-failed' : 'tool-inline-done'}`, children: [_jsx("i", { className: `ri-${t.error ? 'close-circle-line' : 'check-line'}` }), _jsx("span", { className: "tool-inline-name", children: t.tool }), t.latencyMs !== undefined && _jsxs("span", { className: "tool-inline-meta", children: [(t.latencyMs / 1000).toFixed(1), "s"] }), t.error && _jsx("span", { className: "tool-inline-error", children: t.error })] }, t.id))) })), hasPending && (_jsxs("div", { className: "msg msg-row assistant", children: [_jsx("div", { className: "msg-label", children: "\u79CB\u5C71\u6FAA" }), _jsxs("div", { className: "msg-bubble", children: [displayText || pendingText, _jsx("span", { className: "msg-cursor" })] })] })), _jsx("div", { ref: bottomRef })] }));
}
