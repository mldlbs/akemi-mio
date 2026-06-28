import { useState } from 'react'

const HANDLER_OPTIONS = [
  { value: 'subagent', label: '子 Agent', icon: 'ri-robot-2-line', tagClass: 'wf-handler-subagent' },
  { value: 'prompt', label: 'Prompt 注入', icon: 'ri-question-mark', tagClass: 'wf-handler-prompt' },
  { value: 'tool', label: '工具调用', icon: 'ri-tools-line', tagClass: 'wf-handler-tool' },
  { value: 'api', label: 'API 调用', icon: 'ri-api-line', tagClass: 'wf-handler-api' },
  { value: 'plan', label: '生成计划', icon: 'ri-file-list-3-line', tagClass: 'wf-handler-plan' },
] as const

interface StepDef {
  id: string
  name: string
  description: string
  handler: string
  config: Record<string, string>
  dependsOn: string[]
}

interface WFDef {
  id: string
  name: string
  description: string
  steps: StepDef[]
  createdAt: number
  updatedAt: number
}

interface Props {
  initial?: WFDef | null
  onBack: () => void
  onSaved: () => void
}

let stepCounter = 0
function freshStepId(): string {
  stepCounter++
  return `s${stepCounter}`
}

const EMPTY_STEP = (): StepDef => ({
  id: freshStepId(),
  name: '',
  description: '',
  handler: 'subagent',
  config: { prompt: '' },
  dependsOn: [],
})

export function WorkflowEditor({ initial, onBack, onSaved }: Props) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [steps, setSteps] = useState<StepDef[]>(initial?.steps.length ? initial.steps : [EMPTY_STEP()])
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [editingStepId, setEditingStepId] = useState<string | null>(steps[0]?.id ?? null)

  function updateStep(id: string, patch: Partial<StepDef>) {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  function removeStep(id: string) {
    setSteps((prev) => {
      const next = prev.filter((s) => s.id !== id)
      return next.map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => d !== id) }))
    })
    if (editingStepId === id) setEditingStepId(null)
  }

  function addStep() {
    const s = EMPTY_STEP()
    setSteps((prev) => [...prev, s])
    setEditingStepId(s.id)
  }

  function moveStep(index: number, dir: -1 | 1) {
    const to = index + dir
    if (to < 0 || to >= steps.length) return
    setSteps((prev) => {
      const arr = [...prev]
      ;[arr[index], arr[to]] = [arr[to], arr[index]]
      return arr
    })
  }

  function availableDeps(currentId: string): StepDef[] {
    return steps.filter((s) => s.id !== currentId)
  }

  function handlerConfigFields(handler: string): { key: string; label: string; placeholder: string }[] {
    switch (handler) {
      case 'subagent':
      case 'prompt':
        return [{ key: 'prompt', label: 'Prompt', placeholder: '输入 prompt 内容…' }]
      case 'tool':
        return [{ key: 'tool', label: '工具名', placeholder: '如 analyze_task' }]
      case 'api':
        return [
          { key: 'apiUrl', label: 'API URL', placeholder: 'https://…' },
          { key: 'apiMethod', label: 'HTTP 方法', placeholder: 'GET' },
        ]
      case 'plan':
        return [{ key: 'planPrompt', label: '计划 Prompt', placeholder: '描述需要的计划…' }]
      default:
        return []
    }
  }

  async function handleSave() {
    if (!name.trim()) {
      setError('请输入工作流名称')
      return
    }
    const validSteps = steps.filter((s) => s.name.trim())
    if (validSteps.length === 0) {
      setError('至少需要有一个步骤')
      return
    }
    setError('')
    setSaving(true)
    const now = Date.now()
    const def: any = {
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
    }
    const result = await window.electronAPI.saveWorkflowDefinition(def)
    setSaving(false)
    if (result.success) {
      onSaved()
      onBack()
    } else {
      setError('保存失败')
    }
  }

  async function handleRun() {
    if (!initial) {
      setError('请先保存再运行')
      return
    }
    setRunning(true)
    setError('')
    const result = await window.electronAPI.startWorkflow(initial.id)
    setRunning(false)
    if (result.success) {
      onSaved()
      onBack()
    } else {
      setError(result.error ?? '启动失败')
    }
  }

  const editingStep = steps.find((s) => s.id === editingStepId)

  return (
    <div className="wf-editor">
      {/* Header */}
      <div className="wf-editor-header">
        <button className="wf-editor-back" onClick={onBack}>
          <i className="ri-arrow-left-line" />
        </button>
        <h2 className="wf-editor-title">{initial ? '编辑工作流' : '新建工作流'}</h2>
        <div className="wf-editor-actions">
          {initial && (
            <button className="wf-editor-btn wf-editor-btn-run" disabled={running} onClick={handleRun}>
              <i className={`ri-play-circle-line${running ? ' ri-spin' : ''}`} />
              {running ? '启动中…' : '运行'}
            </button>
          )}
          <button className="wf-editor-btn wf-editor-btn-save" disabled={saving} onClick={handleSave}>
            <i className="ri-save-line" />
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>

      {error && (
        <div className="wf-editor-error">
          <i className="ri-alert-line" />
          {error}
        </div>
      )}

      <div className="wf-editor-body">
        {/* Left: meta + step list */}
        <div className="wf-editor-steps-panel">
          {/* Meta fields */}
          <div className="wf-editor-field">
            <label>工作流名称</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：代码审查管线" />
          </div>
          <div className="wf-editor-field">
            <label>描述</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="描述这个工作流的用途…" rows={2} />
          </div>

          {/* Dependency flow visualization */}
          {steps.filter((s) => s.name.trim()).length >= 2 && (
            <div className="wf-editor-dag">
              <label>步骤依赖关系</label>
              <div className="wf-editor-dag-graph">
                {steps
                  .filter((s) => s.name.trim())
                  .map((s, i) => {
                    const deps = s.dependsOn.map((d) => steps.find((st) => st.id === d)).filter(Boolean)
                    return (
                      <div
                        key={s.id}
                        className={`wf-dag-node${editingStepId === s.id ? ' active' : ''}`}
                        onClick={() => setEditingStepId(s.id)}
                      >
                        <span className="wf-dag-node-index">{i + 1}</span>
                        <span className="wf-dag-node-name">{s.name}</span>
                        {deps.length > 0 && <span className="wf-dag-node-deps">← {deps.map((d: any) => d.name).join(', ')}</span>}
                        <span className={`wf-step-handler-tag ${HANDLER_OPTIONS.find((h) => h.value === s.handler)?.tagClass ?? ''}`}>
                          <i className={HANDLER_OPTIONS.find((h) => h.value === s.handler)?.icon ?? 'ri-circle-line'} />
                          {HANDLER_OPTIONS.find((h) => h.value === s.handler)?.label ?? s.handler}
                        </span>
                      </div>
                    )
                  })}
              </div>
            </div>
          )}

          {/* Step list */}
          <div className="wf-editor-step-list-header">
            <label>步骤（{steps.length}）</label>
            <button className="wf-editor-btn wf-editor-btn-add" onClick={addStep}>
              <i className="ri-add-line" />
              添加步骤
            </button>
          </div>

          <div className="wf-editor-step-list">
            {steps.length === 0 && (
              <div className="wf-editor-step-empty">
                <i className="ri-file-list-3-line" />
                <span>点击「添加步骤」开始构建工作流</span>
              </div>
            )}
            {steps.map((step, i) => (
              <div
                key={step.id}
                className={`wf-editor-step-card${editingStepId === step.id ? ' editing' : ''}`}
                onClick={() => setEditingStepId(step.id)}
              >
                <div className="wf-editor-step-card-order" onClick={(e) => e.stopPropagation()}>
                  <button className="wf-editor-step-move" disabled={i === 0} onClick={() => moveStep(i, -1)} title="上移">
                    <i className="ri-arrow-up-s-line" />
                  </button>
                  <span>{i + 1}</span>
                  <button className="wf-editor-step-move" disabled={i === steps.length - 1} onClick={() => moveStep(i, 1)} title="下移">
                    <i className="ri-arrow-down-s-line" />
                  </button>
                </div>
                <div className="wf-editor-step-card-body">
                  <div className="wf-editor-step-card-name">
                    {step.name || <span className="wf-editor-step-placeholder">未命名步骤</span>}
                  </div>
                  <div className="wf-editor-step-card-meta">
                    <span
                      className={`wf-editor-step-handler-badge ${HANDLER_OPTIONS.find((h) => h.value === step.handler)?.tagClass ?? ''}`}
                    >
                      <i className={HANDLER_OPTIONS.find((h) => h.value === step.handler)?.icon ?? 'ri-question-line'} />
                      {HANDLER_OPTIONS.find((h) => h.value === step.handler)?.label ?? step.handler}
                    </span>
                    {step.dependsOn.length > 0 && (
                      <span className="wf-editor-step-dep-tag">
                        <i className="ri-link" />
                        {step.dependsOn.length} 个依赖
                      </span>
                    )}
                  </div>
                </div>
                <button
                  className="wf-editor-step-remove"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeStep(step.id)
                  }}
                  title="删除步骤"
                >
                  <i className="ri-close-line" />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Right: editing panel */}
        <div className="wf-editor-config-panel">
          {editingStep ? (
            <>
              <h3 className="wf-editor-config-title">步骤配置</h3>
              <div className="wf-editor-field">
                <label>步骤名称</label>
                <input
                  value={editingStep.name}
                  onChange={(e) => updateStep(editingStep.id, { name: e.target.value })}
                  placeholder="如：代码编写"
                />
              </div>
              <div className="wf-editor-field">
                <label>步骤描述</label>
                <textarea
                  value={editingStep.description}
                  onChange={(e) => updateStep(editingStep.id, { description: e.target.value })}
                  placeholder="描述这个步骤要做的事…"
                  rows={2}
                />
              </div>
              <div className="wf-editor-field">
                <label>执行方式</label>
                <div className="wf-editor-handler-grid">
                  {HANDLER_OPTIONS.map((h) => (
                    <button
                      key={h.value}
                      className={`wf-editor-handler-opt${editingStep.handler === h.value ? ' active' : ''}`}
                      onClick={() => updateStep(editingStep.id, { handler: h.value, config: {} })}
                    >
                      <i className={h.icon} />
                      <span>{h.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              {handlerConfigFields(editingStep.handler).map((field) => (
                <div key={field.key} className="wf-editor-field">
                  <label>{field.label}</label>
                  <textarea
                    value={editingStep.config[field.key] ?? ''}
                    onChange={(e) =>
                      updateStep(editingStep.id, {
                        config: { ...editingStep.config, [field.key]: e.target.value },
                      })
                    }
                    placeholder={field.placeholder}
                    rows={field.key === 'prompt' || field.key === 'planPrompt' ? 6 : 2}
                  />
                </div>
              ))}
              <div className="wf-editor-field">
                <label>前置依赖</label>
                <div className="wf-editor-dep-checkboxes">
                  {availableDeps(editingStep.id).length === 0 && <span className="wf-editor-dep-empty">没有其他步骤可依赖</span>}
                  {availableDeps(editingStep.id).map((dep) => {
                    const checked = editingStep.dependsOn.includes(dep.id)
                    return (
                      <label key={dep.id} className="wf-editor-dep-checkbox">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            if (checked) {
                              updateStep(editingStep.id, {
                                dependsOn: editingStep.dependsOn.filter((d) => d !== dep.id),
                              })
                            } else {
                              updateStep(editingStep.id, {
                                dependsOn: [...editingStep.dependsOn, dep.id],
                              })
                            }
                          }}
                        />
                        <span>{dep.name || dep.id}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            </>
          ) : (
            <div className="wf-editor-config-empty">
              <i className="ri-edit-box-line" />
              <span>从左侧选择一个步骤进行配置</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
