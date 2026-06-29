import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
const HANDLER_OPTIONS = [
    { value: 'subagent', label: '子 Agent', icon: 'ri-robot-2-line', tagClass: 'wf-handler-subagent' },
    { value: 'prompt', label: 'Prompt 注入', icon: 'ri-question-mark', tagClass: 'wf-handler-prompt' },
    { value: 'tool', label: '工具调用', icon: 'ri-tools-line', tagClass: 'wf-handler-tool' },
    { value: 'api', label: 'API 调用', icon: 'ri-api-line', tagClass: 'wf-handler-api' },
    { value: 'plan', label: '生成计划', icon: 'ri-file-list-3-line', tagClass: 'wf-handler-plan' },
];
let stepCounter = 0;
function freshStepId() {
    stepCounter++;
    return `s${stepCounter}`;
}
const EMPTY_STEP = () => ({
    id: freshStepId(),
    name: '',
    description: '',
    handler: 'subagent',
    config: { prompt: '' },
    dependsOn: [],
});
export function WorkflowEditor({ initial, onBack, onSaved }) {
    const [name, setName] = useState(initial?.name ?? '');
    const [description, setDescription] = useState(initial?.description ?? '');
    const [steps, setSteps] = useState(initial?.steps.length ? initial.steps : [EMPTY_STEP()]);
    const [saving, setSaving] = useState(false);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState('');
    const [editingStepId, setEditingStepId] = useState(steps[0]?.id ?? null);
    function updateStep(id, patch) {
        setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    }
    function removeStep(id) {
        setSteps((prev) => {
            const next = prev.filter((s) => s.id !== id);
            return next.map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => d !== id) }));
        });
        if (editingStepId === id)
            setEditingStepId(null);
    }
    function addStep() {
        const s = EMPTY_STEP();
        setSteps((prev) => [...prev, s]);
        setEditingStepId(s.id);
    }
    function moveStep(index, dir) {
        const to = index + dir;
        if (to < 0 || to >= steps.length)
            return;
        setSteps((prev) => {
            const arr = [...prev];
            [arr[index], arr[to]] = [arr[to], arr[index]];
            return arr;
        });
    }
    function availableDeps(currentId) {
        return steps.filter((s) => s.id !== currentId);
    }
    function handlerConfigFields(handler) {
        switch (handler) {
            case 'subagent':
            case 'prompt':
                return [{ key: 'prompt', label: 'Prompt', placeholder: '输入 prompt 内容…' }];
            case 'tool':
                return [{ key: 'tool', label: '工具名', placeholder: '如 analyze_task' }];
            case 'api':
                return [
                    { key: 'apiUrl', label: 'API URL', placeholder: 'https://…' },
                    { key: 'apiMethod', label: 'HTTP 方法', placeholder: 'GET' },
                ];
            case 'plan':
                return [{ key: 'planPrompt', label: '计划 Prompt', placeholder: '描述需要的计划…' }];
            default:
                return [];
        }
    }
    async function handleSave() {
        if (!name.trim()) {
            setError('请输入工作流名称');
            return;
        }
        const validSteps = steps.filter((s) => s.name.trim());
        if (validSteps.length === 0) {
            setError('至少需要有一个步骤');
            return;
        }
        setError('');
        setSaving(true);
        const now = Date.now();
        const def = {
            id: initial?.id ?? `wf_${now}`,
            name: name.trim(),
            description: description.trim(),
            steps: validSteps.map((s) => ({
                id: s.id,
                name: s.name.trim(),
                description: s.description.trim(),
                handler: s.handler,
                config: s.config,
                dependsOn: s.dependsOn,
            })),
            createdAt: initial?.createdAt ?? now,
            updatedAt: now,
        };
        const result = await window.electronAPI.saveWorkflowDefinition(def);
        setSaving(false);
        if (result.success) {
            onSaved();
            onBack();
        }
        else {
            setError('保存失败');
        }
    }
    async function handleRun() {
        if (!initial) {
            setError('请先保存再运行');
            return;
        }
        setRunning(true);
        setError('');
        const result = await window.electronAPI.startWorkflow(initial.id);
        setRunning(false);
        if (result.success) {
            onSaved();
            onBack();
        }
        else {
            setError(result.error ?? '启动失败');
        }
    }
    const editingStep = steps.find((s) => s.id === editingStepId);
    return (_jsxs("div", { className: "wf-editor", children: [_jsxs("div", { className: "wf-editor-header", children: [_jsx("button", { className: "wf-editor-back", onClick: onBack, children: _jsx("i", { className: "ri-arrow-left-line" }) }), _jsx("h2", { className: "wf-editor-title", children: initial ? '编辑工作流' : '新建工作流' }), _jsxs("div", { className: "wf-editor-actions", children: [initial && (_jsxs("button", { className: "wf-editor-btn wf-editor-btn-run", disabled: running, onClick: handleRun, children: [_jsx("i", { className: `ri-play-circle-line${running ? ' ri-spin' : ''}` }), running ? '启动中…' : '运行'] })), _jsxs("button", { className: "wf-editor-btn wf-editor-btn-save", disabled: saving, onClick: handleSave, children: [_jsx("i", { className: "ri-save-line" }), saving ? '保存中…' : '保存'] })] })] }), error && (_jsxs("div", { className: "wf-editor-error", children: [_jsx("i", { className: "ri-alert-line" }), error] })), _jsxs("div", { className: "wf-editor-body", children: [_jsxs("div", { className: "wf-editor-steps-panel", children: [_jsxs("div", { className: "wf-editor-field", children: [_jsx("label", { children: "\u5DE5\u4F5C\u6D41\u540D\u79F0" }), _jsx("input", { value: name, onChange: (e) => setName(e.target.value), placeholder: "\u5982\uFF1A\u4EE3\u7801\u5BA1\u67E5\u7BA1\u7EBF" })] }), _jsxs("div", { className: "wf-editor-field", children: [_jsx("label", { children: "\u63CF\u8FF0" }), _jsx("textarea", { value: description, onChange: (e) => setDescription(e.target.value), placeholder: "\u63CF\u8FF0\u8FD9\u4E2A\u5DE5\u4F5C\u6D41\u7684\u7528\u9014\u2026", rows: 2 })] }), steps.filter((s) => s.name.trim()).length >= 2 && (_jsxs("div", { className: "wf-editor-dag", children: [_jsx("label", { children: "\u6B65\u9AA4\u4F9D\u8D56\u5173\u7CFB" }), _jsx("div", { className: "wf-editor-dag-graph", children: steps
                                            .filter((s) => s.name.trim())
                                            .map((s, i) => {
                                            const deps = s.dependsOn.map((d) => steps.find((st) => st.id === d)).filter(Boolean);
                                            return (_jsxs("div", { className: `wf-dag-node${editingStepId === s.id ? ' active' : ''}`, onClick: () => setEditingStepId(s.id), children: [_jsx("span", { className: "wf-dag-node-index", children: i + 1 }), _jsx("span", { className: "wf-dag-node-name", children: s.name }), deps.length > 0 && _jsxs("span", { className: "wf-dag-node-deps", children: ["\u2190 ", deps.map((d) => d.name).join(', ')] }), _jsxs("span", { className: `wf-step-handler-tag ${HANDLER_OPTIONS.find((h) => h.value === s.handler)?.tagClass ?? ''}`, children: [_jsx("i", { className: HANDLER_OPTIONS.find((h) => h.value === s.handler)?.icon ?? 'ri-circle-line' }), HANDLER_OPTIONS.find((h) => h.value === s.handler)?.label ?? s.handler] })] }, s.id));
                                        }) })] })), _jsxs("div", { className: "wf-editor-step-list-header", children: [_jsxs("label", { children: ["\u6B65\u9AA4\uFF08", steps.length, "\uFF09"] }), _jsxs("button", { className: "wf-editor-btn wf-editor-btn-add", onClick: addStep, children: [_jsx("i", { className: "ri-add-line" }), "\u6DFB\u52A0\u6B65\u9AA4"] })] }), _jsxs("div", { className: "wf-editor-step-list", children: [steps.length === 0 && (_jsxs("div", { className: "wf-editor-step-empty", children: [_jsx("i", { className: "ri-file-list-3-line" }), _jsx("span", { children: "\u70B9\u51FB\u300C\u6DFB\u52A0\u6B65\u9AA4\u300D\u5F00\u59CB\u6784\u5EFA\u5DE5\u4F5C\u6D41" })] })), steps.map((step, i) => (_jsxs("div", { className: `wf-editor-step-card${editingStepId === step.id ? ' editing' : ''}`, onClick: () => setEditingStepId(step.id), children: [_jsxs("div", { className: "wf-editor-step-card-order", onClick: (e) => e.stopPropagation(), children: [_jsx("button", { className: "wf-editor-step-move", disabled: i === 0, onClick: () => moveStep(i, -1), title: "\u4E0A\u79FB", children: _jsx("i", { className: "ri-arrow-up-s-line" }) }), _jsx("span", { children: i + 1 }), _jsx("button", { className: "wf-editor-step-move", disabled: i === steps.length - 1, onClick: () => moveStep(i, 1), title: "\u4E0B\u79FB", children: _jsx("i", { className: "ri-arrow-down-s-line" }) })] }), _jsxs("div", { className: "wf-editor-step-card-body", children: [_jsx("div", { className: "wf-editor-step-card-name", children: step.name || _jsx("span", { className: "wf-editor-step-placeholder", children: "\u672A\u547D\u540D\u6B65\u9AA4" }) }), _jsxs("div", { className: "wf-editor-step-card-meta", children: [_jsxs("span", { className: `wf-editor-step-handler-badge ${HANDLER_OPTIONS.find((h) => h.value === step.handler)?.tagClass ?? ''}`, children: [_jsx("i", { className: HANDLER_OPTIONS.find((h) => h.value === step.handler)?.icon ?? 'ri-question-line' }), HANDLER_OPTIONS.find((h) => h.value === step.handler)?.label ?? step.handler] }), step.dependsOn.length > 0 && (_jsxs("span", { className: "wf-editor-step-dep-tag", children: [_jsx("i", { className: "ri-link" }), step.dependsOn.length, " \u4E2A\u4F9D\u8D56"] }))] })] }), _jsx("button", { className: "wf-editor-step-remove", onClick: (e) => {
                                                    e.stopPropagation();
                                                    removeStep(step.id);
                                                }, title: "\u5220\u9664\u6B65\u9AA4", children: _jsx("i", { className: "ri-close-line" }) })] }, step.id)))] })] }), _jsx("div", { className: "wf-editor-config-panel", children: editingStep ? (_jsxs(_Fragment, { children: [_jsx("h3", { className: "wf-editor-config-title", children: "\u6B65\u9AA4\u914D\u7F6E" }), _jsxs("div", { className: "wf-editor-field", children: [_jsx("label", { children: "\u6B65\u9AA4\u540D\u79F0" }), _jsx("input", { value: editingStep.name, onChange: (e) => updateStep(editingStep.id, { name: e.target.value }), placeholder: "\u5982\uFF1A\u4EE3\u7801\u7F16\u5199" })] }), _jsxs("div", { className: "wf-editor-field", children: [_jsx("label", { children: "\u6B65\u9AA4\u63CF\u8FF0" }), _jsx("textarea", { value: editingStep.description, onChange: (e) => updateStep(editingStep.id, { description: e.target.value }), placeholder: "\u63CF\u8FF0\u8FD9\u4E2A\u6B65\u9AA4\u8981\u505A\u7684\u4E8B\u2026", rows: 2 })] }), _jsxs("div", { className: "wf-editor-field", children: [_jsx("label", { children: "\u6267\u884C\u65B9\u5F0F" }), _jsx("div", { className: "wf-editor-handler-grid", children: HANDLER_OPTIONS.map((h) => (_jsxs("button", { className: `wf-editor-handler-opt${editingStep.handler === h.value ? ' active' : ''}`, onClick: () => updateStep(editingStep.id, { handler: h.value, config: {} }), children: [_jsx("i", { className: h.icon }), _jsx("span", { children: h.label })] }, h.value))) })] }), handlerConfigFields(editingStep.handler).map((field) => (_jsxs("div", { className: "wf-editor-field", children: [_jsx("label", { children: field.label }), _jsx("textarea", { value: editingStep.config[field.key] ?? '', onChange: (e) => updateStep(editingStep.id, {
                                                config: { ...editingStep.config, [field.key]: e.target.value },
                                            }), placeholder: field.placeholder, rows: field.key === 'prompt' || field.key === 'planPrompt' ? 6 : 2 })] }, field.key))), _jsxs("div", { className: "wf-editor-field", children: [_jsx("label", { children: "\u524D\u7F6E\u4F9D\u8D56" }), _jsxs("div", { className: "wf-editor-dep-checkboxes", children: [availableDeps(editingStep.id).length === 0 && _jsx("span", { className: "wf-editor-dep-empty", children: "\u6CA1\u6709\u5176\u4ED6\u6B65\u9AA4\u53EF\u4F9D\u8D56" }), availableDeps(editingStep.id).map((dep) => {
                                                    const checked = editingStep.dependsOn.includes(dep.id);
                                                    return (_jsxs("label", { className: "wf-editor-dep-checkbox", children: [_jsx("input", { type: "checkbox", checked: checked, onChange: () => {
                                                                    if (checked) {
                                                                        updateStep(editingStep.id, {
                                                                            dependsOn: editingStep.dependsOn.filter((d) => d !== dep.id),
                                                                        });
                                                                    }
                                                                    else {
                                                                        updateStep(editingStep.id, {
                                                                            dependsOn: [...editingStep.dependsOn, dep.id],
                                                                        });
                                                                    }
                                                                } }), _jsx("span", { children: dep.name || dep.id })] }, dep.id));
                                                })] })] })] })) : (_jsxs("div", { className: "wf-editor-config-empty", children: [_jsx("i", { className: "ri-edit-box-line" }), _jsx("span", { children: "\u4ECE\u5DE6\u4FA7\u9009\u62E9\u4E00\u4E2A\u6B65\u9AA4\u8FDB\u884C\u914D\u7F6E" })] })) })] })] }));
}
