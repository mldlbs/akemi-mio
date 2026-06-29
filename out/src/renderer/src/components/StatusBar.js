import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
const PERSONA_LABELS = {
    core: '日常',
    hybrid: '混合',
    writer: '写作',
};
const AGENT_STATUS_TEXT = {
    idle: null,
    thinking: '思考中',
    tool_executing: '执行工具',
    replying: '回复中',
};
export function StatusBar({ conversationActive, ttsPlaying, error, sessionHealth, personaLevel, agentState }) {
    const status = ttsPlaying
        ? '回复中'
        : agentState && AGENT_STATUS_TEXT[agentState]
            ? AGENT_STATUS_TEXT[agentState]
            : conversationActive
                ? '正在聆听'
                : '待命';
    const sub = ttsPlaying ? '· 播放回复' : conversationActive && !agentState ? '· 等待语音输入' : '';
    let healthDisplay = null;
    let healthClass = '';
    if (sessionHealth) {
        const parts = sessionHealth.split(':');
        if (parts.length === 3) {
            const score = parseInt(parts[0], 10);
            const level = parts[1];
            healthDisplay = `${score} ${level}`;
            healthClass = score >= 70 ? 'health-ok' : score >= 50 ? 'health-warn' : 'health-bad';
        }
    }
    return (_jsxs("div", { className: "status-bar", children: [_jsx("div", { className: `status-dot${conversationActive ? ' active' : ''}` }), _jsx("span", { className: "status-label", children: status }), sub && _jsx("span", { className: "status-sub", children: sub }), personaLevel && personaLevel !== 'core' && (_jsx("span", { className: `persona-badge persona-${personaLevel}`, children: PERSONA_LABELS[personaLevel] || personaLevel })), healthDisplay && _jsx("span", { className: `status-health ${healthClass}`, children: healthDisplay }), error && _jsx("span", { className: "status-error", children: error })] }));
}
