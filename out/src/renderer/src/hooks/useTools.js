import { useState } from 'react';
import { useIPCEvent } from './useIPCEvent';
export function useTools() {
    const [toolRunning, setToolRunning] = useState([]);
    const [toolCompleted, setToolCompleted] = useState([]);
    // tool:status 'start' 标志新一轮对话开始，清空旧 tool 列表
    useIPCEvent(window.electronAPI.onToolStatus, (status) => {
        if (status.type === 'start') {
            setToolRunning([]);
            setToolCompleted([]);
        }
    });
    useIPCEvent(window.electronAPI.onToolInvoked, (data) => {
        setToolRunning((prev) => [...prev, { id: data.id, tool: data.tool, args: data.args }]);
    });
    useIPCEvent(window.electronAPI.onToolCompleted, (data) => {
        setToolRunning((prev) => prev.filter((t) => t.id !== data.id));
        setToolCompleted((prev) => [...prev, { id: data.id, tool: data.tool, latencyMs: data.latencyMs, result: data.result }]);
    });
    useIPCEvent(window.electronAPI.onToolFailed, (data) => {
        setToolRunning((prev) => prev.filter((t) => t.id !== data.id));
        setToolCompleted((prev) => [...prev, { id: data.id, tool: data.tool, latencyMs: data.latencyMs, error: data.error }]);
    });
    return { toolRunning, toolCompleted };
}
