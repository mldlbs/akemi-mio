import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect, useCallback } from 'react';
const SETTINGS_FIELDS = [
    { key: 'llm_key', label: 'LLM API Key', type: 'password', placeholder: 'sk-...' },
    { key: 'llm_api_url', label: 'API URL', type: 'text', placeholder: 'https://api.openai.com/v1' },
    { key: 'llm_chat_model', label: '聊天模型', type: 'text', placeholder: 'gpt-4o' },
];
export function SettingsModal({ open, onClose }) {
    const [values, setValues] = useState({});
    const [ttsMode, setTtsMode] = useState('cloud');
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState(null);
    useEffect(() => {
        if (!open)
            return;
        setMessage(null);
        Promise.all(SETTINGS_FIELDS.map(async (f) => {
            const v = await window.electronAPI.getCredential(f.key);
            return [f.key, v ?? ''];
        })).then((entries) => {
            setValues(Object.fromEntries(entries));
        });
        window.electronAPI.getCredential('tts_mode').then((v) => {
            if (v === 'local' || v === 'cloud')
                setTtsMode(v);
        });
    }, [open]);
    const handleSave = async (e) => {
        e.preventDefault();
        setSaving(true);
        setMessage(null);
        try {
            for (const [key, val] of Object.entries(values)) {
                await window.electronAPI.setCredential(key, val);
            }
            await window.electronAPI.setCredential('tts_mode', ttsMode);
            setMessage({ type: 'ok', text: '已保存' });
        }
        catch (err) {
            setMessage({ type: 'error', text: String(err) });
        }
        finally {
            setSaving(false);
        }
    };
    if (!open)
        return null;
    const handleKeyDown = useCallback((e) => {
        if (e.key === 'Escape')
            onClose();
    }, [onClose]);
    return (_jsx("div", { className: "settings-overlay", onClick: onClose, onKeyDown: handleKeyDown, children: _jsxs("div", { className: "settings-panel", onClick: (e) => e.stopPropagation(), children: [_jsxs("div", { className: "settings-header", children: [_jsx("span", { className: "settings-title", children: "\u8BBE\u7F6E" }), _jsx("button", { className: "settings-close", onClick: onClose, children: _jsx("i", { className: "ri-close-line" }) })] }), _jsxs("form", { className: "settings-body", onSubmit: handleSave, children: [SETTINGS_FIELDS.map((f) => (_jsxs("label", { className: "settings-field", children: [_jsx("span", { className: "settings-label", children: f.label }), _jsx("input", { className: "settings-input", type: f.type, value: values[f.key] ?? '', onChange: (e) => setValues((v) => ({ ...v, [f.key]: e.target.value })), placeholder: f.placeholder })] }, f.key))), _jsxs("div", { className: "settings-field", children: [_jsx("span", { className: "settings-label", children: "TTS \u6A21\u5F0F" }), _jsxs("div", { className: "settings-toggle", children: [_jsx("button", { type: "button", className: `settings-toggle-btn${ttsMode === 'cloud' ? ' active' : ''}`, onClick: () => setTtsMode('cloud'), children: "\u4E91\u7AEF" }), _jsx("button", { type: "button", className: `settings-toggle-btn${ttsMode === 'local' ? ' active' : ''}`, onClick: () => setTtsMode('local'), children: "\u672C\u5730" })] })] }), message && _jsx("div", { className: `settings-message settings-${message.type}`, children: message.text }), _jsx("div", { className: "settings-actions", children: _jsx("button", { type: "submit", className: "settings-save", disabled: saving, children: saving ? '保存中…' : '保存' }) })] })] }) }));
}
