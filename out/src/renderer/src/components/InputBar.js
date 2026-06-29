import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useCallback, useRef } from 'react';
export function InputBar({ onSend, voiceSlot, agentState }) {
    const [value, setValue] = useState('');
    const textareaRef = useRef(null);
    const autoResize = useCallback(() => {
        const el = textareaRef.current;
        if (!el)
            return;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }, []);
    const isBusy = agentState === 'thinking' || agentState === 'tool_executing' || agentState === 'replying';
    const handleStop = useCallback(async () => {
        try {
            await window.electronAPI.stopConversation();
        }
        catch {
            /* ignore */
        }
    }, []);
    const handleSend = useCallback(() => {
        const t = value.trim();
        if (!t)
            return;
        onSend(t);
        setValue('');
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
        }
    }, [value, onSend]);
    const handleKeyDown = useCallback((e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    }, [handleSend]);
    return (_jsx("div", { className: "inputbar", children: _jsxs("div", { className: "inputbar-row", children: [voiceSlot, _jsx("textarea", { ref: textareaRef, className: "inputbar-field", value: value, onChange: (e) => {
                        setValue(e.target.value);
                        autoResize();
                    }, onKeyDown: handleKeyDown, placeholder: "\u8F93\u5165\u6D88\u606F\u2026", rows: 1 }), isBusy ? (_jsx("button", { className: "inputbar-stop", onClick: handleStop, title: "\u505C\u6B62\u56DE\u590D", children: _jsx("i", { className: "ri-stop-fill" }) })) : (_jsx("button", { className: "inputbar-send", disabled: !value.trim(), onClick: handleSend, title: "\u53D1\u9001", children: _jsx("i", { className: "ri-send-plane-2-fill" }) }))] }) }));
}
