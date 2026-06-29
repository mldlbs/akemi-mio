import { useState, useEffect, useCallback } from 'react';
import { useIPCEvent } from './useIPCEvent';
export function useWorkflowDefinitions() {
    const [definitions, setDefinitions] = useState([]);
    const [runs, setRuns] = useState([]);
    const [loading, setLoading] = useState(true);
    const refresh = useCallback(() => {
        Promise.all([window.electronAPI.listWorkflowDefinitions(), window.electronAPI.listWorkflowRuns(20)]).then(([defs, runList]) => {
            setDefinitions(defs);
            setRuns(runList);
            setLoading(false);
        });
    }, []);
    useEffect(() => {
        refresh();
    }, [refresh]);
    // 工作流新运行创建 → 全量刷新
    useIPCEvent(window.electronAPI.onWorkflowRunCreated, () => {
        window.electronAPI.listWorkflowRuns(20).then(setRuns);
    });
    // 运行状态变更 → 原地更新
    useIPCEvent(window.electronAPI.onWorkflowRunUpdated, (data) => {
        setRuns((prev) => prev.map((r) => (r.runId === data.runId ? { ...r, status: data.status } : r)));
    });
    // 步骤状态变更 → 原地更新
    useIPCEvent(window.electronAPI.onWorkflowRunStep, (data) => {
        setRuns((prev) => prev.map((r) => r.runId === data.runId
            ? {
                ...r,
                steps: r.steps.map((s) => (s.stepId === data.stepId ? { ...s, status: data.status } : s)),
            }
            : r));
    });
    const activeRuns = runs.filter((r) => r.status === 'running');
    return { definitions, runs, activeRuns, loading, refresh };
}
