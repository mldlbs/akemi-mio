import { useState, useEffect } from 'react';
import { useIPCEvent } from './useIPCEvent';
export function usePlans() {
    const [activePlan, setActivePlan] = useState(null);
    const [planHistory, setPlanHistory] = useState([]);
    const [otparStages, setOtparStages] = useState([]);
    // Load initial data
    useEffect(() => {
        window.electronAPI.getActivePlan().then((plan) => setActivePlan(plan));
        window.electronAPI.listPlans().then((list) => {
            setPlanHistory(list.filter((p) => p.status !== 'active'));
        });
    }, []);
    // Subscribe to plan events
    useIPCEvent(window.electronAPI.onPlanCreated, (_data) => {
        window.electronAPI.getActivePlan().then((plan) => setActivePlan(plan));
        window.electronAPI.listPlans().then((list) => {
            setPlanHistory(list.filter((p) => p.status !== 'active'));
        });
    });
    useIPCEvent(window.electronAPI.onPlanStep, (data) => {
        setActivePlan((prev) => {
            if (!prev || prev.id !== data.planId)
                return prev;
            return {
                ...prev,
                steps: prev.steps.map((s, i) => (i === data.stepIndex ? { ...s, status: data.status } : s)),
            };
        });
    });
    useIPCEvent(window.electronAPI.onPlanCompleted, (data) => {
        setActivePlan((prev) => {
            if (!prev || prev.id !== data.planId)
                return prev;
            return { ...prev, status: 'completed' };
        });
        window.electronAPI.listPlans().then((list) => {
            setPlanHistory(list.filter((p) => p.status !== 'active'));
        });
    });
    // Subscribe to OTPAR stages — keep last 20
    useIPCEvent(window.electronAPI.onAgentObserve, (data) => {
        setOtparStages((prev) => [
            ...prev.slice(-19),
            {
                type: 'observe',
                requestId: data.requestId,
                step: data.step,
                durationMs: data.durationMs,
                timestamp: Date.now(),
                detail: `流程 ${data.proceduresFound} · 模式 ${data.patternsFound}`,
            },
        ]);
    });
    useIPCEvent(window.electronAPI.onAgentThink, (data) => {
        setOtparStages((prev) => [
            ...prev.slice(-19),
            {
                type: 'think',
                requestId: data.requestId,
                step: data.step,
                timestamp: Date.now(),
                detail: `${data.toolCallCount} 个工具` + (data.strategyPrompted ? ' · 策略提示' : ''),
            },
        ]);
    });
    useIPCEvent(window.electronAPI.onAgentReflect, (data) => {
        setOtparStages((prev) => [
            ...prev.slice(-19),
            {
                type: 'reflect',
                requestId: data.requestId,
                step: data.step,
                durationMs: data.durationMs,
                timestamp: Date.now(),
                detail: data.summary,
            },
        ]);
    });
    return { activePlan, planHistory, otparStages };
}
