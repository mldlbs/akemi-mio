import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { WorkflowEditor } from './WorkflowEditor';
function stageIcon(status) {
    switch (status) {
        case 'done':
            return 'ri-check-line';
        case 'in_progress':
            return 'ri-loader-4-line ri-spin';
        case 'failed':
            return 'ri-close-circle-line';
        default:
            return 'ri-circle-line';
    }
}
function stageColor(status) {
    switch (status) {
        case 'done':
            return 'wf-step-done';
        case 'in_progress':
            return 'wf-step-running';
        case 'failed':
            return 'wf-step-failed';
        default:
            return 'wf-step-pending';
    }
}
/** Handler 图标映射 */
function handlerIcon(handler) {
    switch (handler) {
        case 'subagent':
            return 'ri-robot-2-line';
        case 'prompt':
            return 'ri-question-mark';
        case 'tool':
            return 'ri-tools-line';
        case 'api':
            return 'ri-api-line';
        case 'plan':
            return 'ri-file-list-3-line';
        default:
            return 'ri-circle-line';
    }
}
/** Handler 标签 CSS class 后缀 */
function handlerClass(handler) {
    switch (handler) {
        case 'subagent':
            return 'wf-handler-subagent';
        case 'prompt':
            return 'wf-handler-prompt';
        case 'tool':
            return 'wf-handler-tool';
        case 'api':
            return 'wf-handler-api';
        case 'plan':
            return 'wf-handler-plan';
        default:
            return '';
    }
}
function handlerLabel(handler) {
    switch (handler) {
        case 'subagent':
            return 'Agent';
        case 'prompt':
            return 'Prompt';
        case 'tool':
            return 'Tool';
        case 'api':
            return 'API';
        case 'plan':
            return 'Plan';
        default:
            return handler;
    }
}
function otparIcon(type) {
    switch (type) {
        case 'observe':
            return 'ri-eye-line';
        case 'think':
            return 'ri-brain-line';
        case 'reflect':
            return 'ri-repeat-line';
        default:
            return 'ri-question-line';
    }
}
function otparLabel(type) {
    switch (type) {
        case 'observe':
            return 'Observe';
        case 'think':
            return 'Think';
        case 'reflect':
            return 'Reflect';
        default:
            return type;
    }
}
/** 按 step 分组 OTPAR 条目，每组内保持自然顺序 */
function groupOtparByStep(entries) {
    const map = new Map();
    for (const e of entries) {
        if (!map.has(e.step))
            map.set(e.step, []);
        map.get(e.step).push(e);
    }
    const ORDER = { observe: 0, think: 1, reflect: 2 };
    for (const [, list] of map) {
        list.sort((a, b) => (ORDER[a.type] ?? 9) - (ORDER[b.type] ?? 9));
    }
    return Array.from(map.entries())
        .map(([step, list]) => ({ step, entries: list }))
        .sort((a, b) => b.step - a.step);
}
const OTPAR_PHASES = [
    { type: 'observe', label: 'Observe', icon: 'ri-eye-line' },
    { type: 'think', label: 'Think', icon: 'ri-brain-line' },
    { type: 'reflect', label: 'Reflect', icon: 'ri-repeat-line' },
];
export function WorkflowSlot({ activePlan, otparStages, workflowDefs, workflowRuns, workflowActiveRuns, wfLoading, onRefreshDefs, }) {
    const [tab, setTab] = useState('dev');
    const [historyOpen, setHistoryOpen] = useState(false);
    const [view, setView] = useState('list');
    const [editDef, setEditDef] = useState(null);
    const [runError, setRunError] = useState('');
    const doneSteps = activePlan?.steps.filter((s) => s.status === 'done').length ?? 0;
    const totalSteps = activePlan?.steps.length ?? 0;
    const progress = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0;
    const tabs = [
        { id: 'dev', label: '开发', icon: 'ri-code-s-slash-line', dot: !!activePlan },
        { id: 'running', label: '运行', icon: 'ri-play-circle-line', dot: workflowActiveRuns.length > 0 },
        { id: 'myworkflows', label: '工作流', icon: 'ri-file-list-3-line', dot: workflowDefs.length > 0 },
    ];
    // 只在真正首次加载且完全无数据时显示 loading
    const showLoading = wfLoading && !activePlan && !workflowDefs.length && !workflowRuns.length && !workflowActiveRuns.length;
    // ── Editor view ──
    if (view === 'editor') {
        return (_jsx(WorkflowEditor, { initial: editDef, onBack: () => {
                setView('list');
                setEditDef(null);
            }, onSaved: () => {
                onRefreshDefs?.();
            } }));
    }
    if (showLoading) {
        return (_jsx("div", { className: "workflow-slot", children: _jsxs("div", { className: "workflow-empty", children: [_jsx("div", { className: "workflow-empty-icon", children: _jsx("i", { className: "ri-loader-4-line ri-spin" }) }), _jsx("div", { className: "workflow-empty-text", children: "\u52A0\u8F7D\u5DE5\u4F5C\u6D41\u72B6\u6001\u4E2D\u2026" })] }) }));
    }
    return (_jsxs("div", { className: "workflow-slot workflow-slot-content", children: [_jsx("div", { className: "wf-tabs", children: tabs.map((t) => (_jsxs("button", { className: `wf-tab${tab === t.id ? ' active' : ''}`, onClick: () => setTab(t.id), children: [_jsx("i", { className: t.icon }), _jsx("span", { children: t.label }), t.dot && _jsx("span", { className: "wf-tab-dot" })] }, t.id))) }), tab === 'dev' && (_jsxs(_Fragment, { children: [activePlan ? (_jsxs(_Fragment, { children: [_jsxs("section", { className: "wf-plan-card running", children: [_jsxs("div", { className: "wf-plan-header", children: [_jsx("h3", { className: "wf-plan-title", children: activePlan.title }), _jsx("span", { className: `wf-plan-badge ${activePlan.status}`, children: activePlan.status })] }), _jsxs("div", { className: "wf-progress-row", children: [_jsx("div", { className: "wf-progress-bar", children: _jsx("div", { className: "wf-progress-fill", style: { width: `${Math.max(progress, 4)}%` } }) }), _jsxs("span", { className: "wf-progress-text", children: [doneSteps, "/", totalSteps] })] }), _jsx("ul", { className: "wf-steps", children: activePlan.steps.map((step) => (_jsxs("li", { className: `wf-step ${stageColor(step.status)}`, children: [_jsx("i", { className: stageIcon(step.status) }), _jsx("span", { className: "wf-step-text", children: step.description }), step.result && _jsx("span", { className: "wf-step-result", children: step.result })] }, step.id))) })] }), workflowActiveRuns.length > 0 &&
                                workflowActiveRuns.map((run) => {
                                    const def = workflowDefs.find((d) => d.id === run.workflowDefId);
                                    const runSteps = run.steps.map((s) => {
                                        const stepDef = def?.steps.find((ds) => ds.id === s.stepId);
                                        return { ...s, name: stepDef?.name || s.stepId };
                                    });
                                    const runDone = runSteps.filter((s) => s.status === 'done').length;
                                    const runTotal = runSteps.length;
                                    const runPct = runTotal > 0 ? Math.round((runDone / runTotal) * 100) : 0;
                                    const isRunning = runSteps.some((s) => s.status === 'running');
                                    return (_jsxs("section", { className: `wf-pipeline${isRunning ? ' running' : ''}`, children: [_jsx("h4", { className: "wf-section-title", children: run.workflowName }), _jsxs("div", { className: "wf-pipeline-track", children: [_jsx("div", { className: "wf-pipeline-fill", style: { width: `${Math.max(runPct, 4)}%` } }), _jsx("div", { className: "wf-pipeline-stages", children: runSteps.map((step) => (_jsx("div", { className: "wf-pipeline-stage", children: _jsxs("div", { className: `wf-stage-dot${step.status === 'done' ? ' done' : ''}${step.status === 'running' ? ' current' : ''}`, children: [_jsx("span", { className: "wf-stage-dot-inner" }), _jsx("span", { className: "wf-stage-label", children: step.name })] }) }, step.stepId))) })] })] }, run.runId));
                                })] })) : (_jsxs("div", { className: "workflow-empty", style: { padding: '40px 0' }, children: [_jsx("div", { className: "workflow-empty-icon", children: _jsx("i", { className: "ri-code-s-slash-line" }) }), _jsx("div", { className: "workflow-empty-text", children: "\u5F53\u524D\u6CA1\u6709\u6D3B\u8DC3\u7684\u5F00\u53D1\u8BA1\u5212" }), _jsx("div", { className: "workflow-empty-sub", children: "\u5411 AI \u63CF\u8FF0\u9700\u6C42\uFF0C\u81EA\u52A8\u751F\u6210\u5F00\u53D1\u7BA1\u7EBF" })] })), otparStages.length > 0 && (_jsxs("section", { className: "wf-otpar", children: [_jsx("h4", { className: "wf-section-title", children: "OTPAR \u8BA4\u77E5\u5FAA\u73AF" }), _jsx("div", { className: "wf-otpar-groups", children: groupOtparByStep(otparStages).map((group) => {
                                    const completed = group.entries.filter((e) => e.durationMs !== undefined).length;
                                    return (_jsxs("div", { className: "wf-otpar-group", children: [_jsxs("div", { className: "wf-otpar-group-header", children: [_jsxs("span", { className: "wf-otpar-group-step", children: ["\u6B65\u9AA4 #", group.step] }), _jsxs("span", { className: "wf-otpar-group-progress", children: [completed, " / ", group.entries.length, " \u5B8C\u6210"] })] }), _jsx("div", { className: "wf-otpar-group-phases", children: OTPAR_PHASES.map((phase) => {
                                                    const entry = group.entries.find((e) => e.type === phase.type);
                                                    if (!entry) {
                                                        return (_jsxs("div", { className: "wf-otpar-phase wf-otpar-phase-pending", children: [_jsx("div", { className: "wf-otpar-phase-icon", children: _jsx("i", { className: phase.icon }) }), _jsxs("div", { className: "wf-otpar-phase-body", children: [_jsx("span", { className: "wf-otpar-phase-label", children: phase.label }), _jsx("span", { className: "wf-otpar-phase-detail", children: "\u7B49\u5F85\u4E2D" })] })] }, phase.type));
                                                    }
                                                    const isLatest = entry === otparStages[otparStages.length - 1] && entry.durationMs === undefined;
                                                    return (_jsxs("div", { className: `wf-otpar-phase wf-otpar-phase-${entry.type}${isLatest ? ' current' : ''}`, children: [_jsx("div", { className: `wf-otpar-phase-icon wf-otpar-${entry.type}`, children: _jsx("i", { className: phase.icon }) }), _jsxs("div", { className: "wf-otpar-phase-body", children: [_jsxs("div", { className: "wf-otpar-phase-head", children: [_jsx("span", { className: "wf-otpar-phase-label", children: phase.label }), entry.durationMs !== undefined && (_jsxs("span", { className: "wf-otpar-phase-time", children: [(entry.durationMs / 1000).toFixed(1), "s"] })), isLatest && _jsx("span", { className: "wf-otpar-phase-dot" })] }), _jsx("div", { className: "wf-otpar-phase-detail", children: entry.detail })] })] }, phase.type));
                                                }) })] }, group.step));
                                }) })] }))] })), tab === 'running' && (_jsxs(_Fragment, { children: [workflowActiveRuns.map((run) => {
                        const runDone = run.steps.filter((s) => s.status === 'done').length;
                        const runTotal = run.steps.length;
                        const runPct = runTotal > 0 ? Math.round((runDone / runTotal) * 100) : 0;
                        return (_jsxs("section", { className: "wf-plan-card running", children: [_jsxs("div", { className: "wf-plan-header", children: [_jsx("h3", { className: "wf-plan-title", children: run.workflowName }), _jsx("span", { className: "wf-plan-badge running", children: run.status })] }), _jsxs("div", { className: "wf-progress-row", children: [_jsx("div", { className: "wf-progress-bar", children: _jsx("div", { className: "wf-progress-fill", style: { width: `${Math.max(runPct, 4)}%` } }) }), _jsxs("span", { className: "wf-progress-text", children: [runDone, "/", runTotal] })] }), _jsx("ul", { className: "wf-steps", children: run.steps.map((s) => (_jsxs("li", { className: `wf-step ${stageColor(s.status)}`, children: [_jsx("i", { className: stageIcon(s.status) }), _jsx("span", { className: "wf-step-text", children: s.stepId }), s.error && _jsxs("span", { className: "wf-step-result", children: ["\u9519\u8BEF: ", s.error] })] }, s.stepId))) })] }, run.runId));
                    }), workflowActiveRuns.length === 0 && (_jsxs("div", { className: "workflow-empty", style: { padding: '40px 0' }, children: [_jsx("div", { className: "workflow-empty-icon", children: _jsx("i", { className: "ri-play-circle-line" }) }), _jsx("div", { className: "workflow-empty-text", children: "\u5F53\u524D\u6CA1\u6709\u6B63\u5728\u8FD0\u884C\u7684\u5DE5\u4F5C\u6D41" })] }))] })), tab === 'myworkflows' && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "wf-list-header", children: [_jsx("p", { className: "wf-hint", children: "AI \u53EF\u901A\u8FC7 create_workflow / start_workflow \u5DE5\u5177\u521B\u5EFA\u548C\u542F\u52A8\uFF0C\u4E5F\u53EF\u624B\u52A8\u7F16\u8F91" }), _jsxs("button", { className: "wf-editor-btn wf-editor-btn-add", onClick: () => {
                                    setEditDef(null);
                                    setView('editor');
                                }, children: [_jsx("i", { className: "ri-add-line" }), "\u65B0\u5EFA\u5DE5\u4F5C\u6D41"] })] }), runError && (_jsxs("div", { className: "wf-editor-error", children: [_jsx("i", { className: "ri-alert-line" }), runError] })), workflowDefs.length > 0 && (_jsx(_Fragment, { children: workflowDefs.map((def) => (_jsxs("section", { className: "wf-plan-card", children: [_jsxs("div", { className: "wf-plan-header", children: [_jsx("h3", { className: "wf-plan-title", children: def.name }), _jsxs("span", { className: "wf-plan-badge", children: [def.steps.length, " \u6B65"] })] }), _jsx("p", { className: "wf-desc", children: def.description }), _jsx("div", { className: "wf-meta-row", children: _jsx("span", { className: "wf-meta-time", children: new Date(def.updatedAt || def.createdAt).toLocaleString('zh-CN') }) }), _jsx("ul", { className: "wf-steps", children: def.steps.map((s) => (_jsxs("li", { className: "wf-step wf-step-pending", style: { opacity: 0.7 }, children: [_jsx("i", { className: "ri-circle-line" }), _jsx("span", { className: "wf-step-text", children: s.name }), _jsxs("span", { className: `wf-step-handler-tag ${handlerClass(s.handler)}`, children: [_jsx("i", { className: handlerIcon(s.handler) }), handlerLabel(s.handler)] })] }, s.id))) }), _jsxs("div", { className: "wf-summary-row", children: [_jsxs("button", { className: "wf-editor-btn wf-editor-btn-edit", onClick: () => {
                                                setEditDef(def);
                                                setView('editor');
                                            }, children: [_jsx("i", { className: "ri-edit-line" }), "\u7F16\u8F91"] }), _jsxs("button", { className: "wf-editor-btn wf-editor-btn-run", onClick: async () => {
                                                setRunError('');
                                                const result = await window.electronAPI.startWorkflow(def.id);
                                                if (result.success) {
                                                    onRefreshDefs?.();
                                                }
                                                else {
                                                    setRunError(result.error ?? '启动失败');
                                                }
                                            }, children: [_jsx("i", { className: "ri-play-circle-line" }), "\u8FD0\u884C"] })] })] }, def.id))) })), workflowRuns.filter((r) => r.status !== 'running').length > 0 && (_jsxs("section", { className: "wf-history", children: [_jsxs("button", { className: "wf-history-toggle", onClick: () => setHistoryOpen(!historyOpen), children: [_jsx("i", { className: `ri-arrow-${historyOpen ? 'down' : 'right'}-s-line` }), "\u8FD0\u884C\u5386\u53F2\uFF08", workflowRuns.filter((r) => r.status !== 'running').length, "\uFF09"] }), historyOpen && (_jsx("div", { className: "wf-history-list", children: workflowRuns
                                    .filter((r) => r.status !== 'running')
                                    .map((run) => (_jsxs("div", { className: "wf-history-item", children: [_jsxs("div", { className: "wf-history-item-head", children: [_jsx("span", { className: "wf-history-title", children: run.workflowName }), _jsx("span", { className: "wf-history-status", children: run.status })] }), _jsxs("div", { className: "wf-history-meta", children: [new Date(run.startedAt).toLocaleString('zh-CN'), " \u00B7 ", run.steps.filter((s) => s.status === 'done').length, "/", run.steps.length, " \u6B65"] })] }, run.runId))) }))] })), workflowDefs.length === 0 && workflowRuns.filter((r) => r.status !== 'running').length === 0 && (_jsxs("div", { className: "workflow-empty", style: { padding: '60px 0' }, children: [_jsx("div", { className: "workflow-empty-icon", children: _jsx("i", { className: "ri-file-list-3-line" }) }), _jsx("div", { className: "workflow-empty-text", children: "\u8FD8\u6CA1\u6709\u5DE5\u4F5C\u6D41" }), _jsx("div", { className: "workflow-empty-sub", children: "\u70B9\u51FB\u4E0A\u65B9\u300C\u65B0\u5EFA\u5DE5\u4F5C\u6D41\u300D\u521B\u5EFA\uFF0C\u6216\u8BA9 AI \u901A\u8FC7\u5DE5\u5177\u81EA\u52A8\u751F\u6210" })] }))] }))] }));
}
