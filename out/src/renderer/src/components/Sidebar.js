import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo } from 'react';
const CATEGORY_META = {
    chat: { label: '聊天', icon: 'ri-chat-1-line' },
    writing: { label: '写作', icon: 'ri-quill-pen-line' },
    image_gen: { label: '生图', icon: 'ri-image-ai-line' },
    evolution: { label: '进化', icon: 'ri-robot-2-line' },
    creativity: { label: '创造力', icon: 'ri-lightbulb-line' },
    dream: { label: '梦境', icon: 'ri-moon-line' },
};
const CATEGORY_ORDER = ['chat', 'writing', 'image_gen', 'evolution', 'creativity', 'dream'];
function isSameDay(a, b) {
    const da = new Date(a), db = new Date(b);
    return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}
function formatGroupLabel(timestamp) {
    const now = Date.now();
    if (isSameDay(timestamp, now))
        return '今天';
    if (isSameDay(timestamp, now - 86400000))
        return '昨天';
    return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}
/** 按 lastActivityAt 分组为日期段 */
function groupSessions(sessions) {
    const dateGroupMap = new Map();
    for (const s of sessions) {
        const label = formatGroupLabel(s.lastActivityAt);
        if (!dateGroupMap.has(label)) {
            dateGroupMap.set(label, []);
        }
        dateGroupMap.get(label).push(s);
    }
    return Array.from(dateGroupMap.entries());
}
export function Sidebar({ sessions, activeSessionId, onSelectChat }) {
    // 按 category 分组
    const grouped = useMemo(() => {
        const map = new Map();
        for (const s of sessions) {
            const cat = CATEGORY_META[s.category] ? s.category : 'chat';
            if (!map.has(cat))
                map.set(cat, []);
            map.get(cat).push(s);
        }
        return map;
    }, [sessions]);
    // 排序：按 CATEGORY_ORDER + 按 lastActivityAt 排序
    const panels = useMemo(() => {
        const cats = Array.from(grouped.keys()).sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));
        return cats.map((cat) => ({
            cat,
            meta: CATEGORY_META[cat] || { label: cat, icon: 'ri-chat-1-line' },
            groups: groupSessions(grouped.get(cat).sort((a, b) => b.lastActivityAt - a.lastActivityAt)),
        }));
    }, [grouped]);
    if (sessions.length === 0) {
        return (_jsx("aside", { className: "sidebar", children: _jsx("div", { className: "sidebar-content", children: _jsx("div", { className: "sidebar-empty", children: "\u6682\u65E0\u4F1A\u8BDD \u00B7 \u8F93\u5165\u6587\u5B57\u6216\u70B9\u51FB\u9EA6\u514B\u98CE\u5F00\u59CB" }) }) }));
    }
    return (_jsx("aside", { className: "sidebar", children: _jsx("div", { className: "sidebar-content", children: panels.map(({ cat, meta, groups }) => (_jsxs("div", { className: "sidebar-panel", children: [_jsxs("div", { className: "sidebar-panel-header", children: [_jsx("i", { className: meta.icon }), _jsx("span", { children: meta.label })] }), groups.map(([date, items]) => (_jsxs("div", { children: [_jsx("div", { className: "sidebar-date-header", children: date }), items.map((s) => (_jsxs("button", { className: `sidebar-item${s.id === activeSessionId ? ' active' : ''}`, onClick: () => onSelectChat(s.id), children: [_jsx("span", { title: s.label, children: s.label }), _jsx("span", { className: "sidebar-item-time", children: new Date(s.lastActivityAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) })] }, s.id)))] }, date)))] }, cat))) }) }));
}
