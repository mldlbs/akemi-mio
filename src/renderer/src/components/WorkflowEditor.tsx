import { useState, useRef, useEffect, useCallback } from 'react'
import { WorkflowCanvas } from './WorkflowCanvas'
import { WorkflowRunPanel } from './WorkflowRunPanel'
import { useIPCEvent } from '../hooks/useIPCEvent'

const HANDLER_OPTIONS = [
  { value: 'subagent', label: '子 Agent', icon: 'ri-robot-2-line', tagClass: 'wf-handler-subagent' },
  { value: 'prompt', label: 'Prompt 注入', icon: 'ri-question-mark', tagClass: 'wf-handler-prompt' },
  { value: 'tool', label: '工具调用', icon: 'ri-tools-line', tagClass: 'wf-handler-tool' },
  { value: 'api', label: 'API 调用', icon: 'ri-api-line', tagClass: 'wf-handler-api' },
  { value: 'plan', label: '生成计划', icon: 'ri-file-list-3-line', tagClass: 'wf-handler-plan' },
  { value: 'condition', label: '条件分支', icon: 'ri-git-branch-line', tagClass: 'wf-handler-condition' },
  { value: 'foreach', label: '循环', icon: 'ri-loop-left-line', tagClass: 'wf-handler-foreach' },
  { value: 'transform', label: '数据变换', icon: 'ri-exchange-2-line', tagClass: 'wf-handler-transform' },
  { value: 'gate', label: '审批门', icon: 'ri-lock-2-line', tagClass: 'wf-handler-gate' },
  { value: 'aggregate', label: '结果聚合', icon: 'ri-folder-5-line', tagClass: 'wf-handler-aggregate' },
  { value: 'subflow', label: '子工作流', icon: 'ri-organization-chart', tagClass: 'wf-handler-subflow' },
  { value: 'wait', label: '等待', icon: 'ri-timer-line', tagClass: 'wf-handler-wait' },
  { value: 'script', label: '脚本', icon: 'ri-terminal-box-line', tagClass: 'wf-handler-script' },
  { value: 'event', label: '事件', icon: 'ri-notification-3-line', tagClass: 'wf-handler-event' },
] as const

export interface StepDef {
  id: string
  name: string
  description: string
  handler: string
  config: {
    prompt?: string
    tool?: string
    apiUrl?: string
    apiMethod?: string
    planPrompt?: string
    allowedTools?: string[]
    maxTurns?: number
    llmTimeoutMs?: number
    outputFile?: string
    retryCount?: number
    retryDelayMs?: number
    outputSchema?: string
  }
  dependsOn: string[]
  runOn?: 'success' | 'failure'
}

interface WFDef {
  id: string
  name: string
  description: string
  steps: StepDef[]
  createdAt: number
  updatedAt: number
  enabled?: boolean
  inputSchema?: string
  outputDir?: string
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
  config: {
    allowedTools: [
      'read_file',
      'write_file',
      'edit_file',
      'grep',
      'list_files',
      'move_file',
      'copy_file',
      'delete_file',
      'file_info',
      'search_files',
      'append_file',
      'read_multiple_files',
    ],
  },
  dependsOn: [],
})

const TOOL_GROUPS: { label: string; tools: string[] }[] = [
  {
    label: '文件操作',
    tools: [
      'read_file',
      'write_file',
      'edit_file',
      'grep',
      'list_files',
      'move_file',
      'copy_file',
      'delete_file',
      'file_info',
      'search_files',
      'append_file',
      'read_multiple_files',
    ],
  },
  {
    label: '代码/分析',
    tools: ['analyze_codebase', 'run_command', 'create_dev_plan', 'update_plan_progress', 'list_plans', 'complete_plan', 'abandon_plan'],
  },
  {
    label: '凭据/记忆',
    tools: ['get_credential', 'set_credential', 'list_credentials', 'remember_fact', 'remember_procedure', 'list_procedures'],
  },
  {
    label: '工作流',
    tools: [
      'analyze_task',
      'list_workflows',
      'create_workflow',
      'start_workflow',
      'get_workflow_status',
      'update_workflow',
      'delete_workflow',
      'enable_workflow',
      'disable_workflow',
      'cancel_workflow_run',
      'list_workflow_runs',
    ],
  },
  {
    label: 'Agent/技能',
    tools: ['spawn_skill_agent', 'spawn_agent', 'list_agents', 'interrupt_agent', 'list_skills', 'enable_skill', 'disable_skill'],
  },
  {
    label: '内容生成',
    tools: ['writing_system', 'generate_image', 'generate_card', 'social_pipeline', 'query_trends', 'search_github_trends'],
  },
  {
    label: '系统信息',
    tools: ['get_system_health', 'get_token_status', 'get_identity', 'run_self_review'],
  },
  {
    label: 'SSH/远端',
    tools: ['centos_exec', 'centos_read_file', 'centos_write_file', 'centos_grep', 'centos_search_files'],
  },
  {
    label: '本地模型',
    tools: ['run_local_model', 'create_goal', 'list_goals', 'update_goal'],
  },
  {
    label: '创意/洞察',
    tools: [
      'trigger_creativity',
      'trigger_dream_cycle',
      'list_ideas',
      'trigger_insight_analysis',
      'list_insights',
      'get_evolution_status',
      'trigger_evolution',
      'set_evolution_safety_mode',
      'get_persona_state',
    ],
  },
  {
    label: '观察/策略',
    tools: ['trigger_collect', 'trigger_ferment', 'trigger_deep_research', 'list_strategies', 'create_strategy'],
  },
]

type FieldDef = {
  key: string
  type: 'text' | 'textarea' | 'number' | 'multi-select' | 'radio'
  label: string
  placeholder?: string
  rows?: number
  options?: { value: string; label: string }[]
}

const HANDLER_CONFIG_FIELDS: Record<string, FieldDef[]> = {
  subagent: [
    { key: 'prompt', type: 'textarea', label: 'Prompt', placeholder: '输入 prompt 内容…', rows: 12 },
    { key: 'allowedTools', type: 'multi-select', label: '可见工具（留空为全部）' },
    { key: 'maxTurns', type: 'number', label: '最大工具轮次', placeholder: '默认 15' },
    { key: 'llmTimeoutMs', type: 'number', label: 'LLM 超时(ms)', placeholder: '默认 120000' },
    { key: 'outputFile', type: 'text', label: '输出文件路径', placeholder: '如 output/result.txt' },
    {
      key: 'runOn',
      type: 'radio',
      label: '执行条件',
      options: [
        { value: 'success', label: '依赖成功时执行' },
        { value: 'failure', label: '依赖失败时执行' },
      ],
    },
  ],
  prompt: [
    { key: 'prompt', type: 'textarea', label: 'Prompt', placeholder: '输入 prompt 内容…', rows: 12 },
    { key: 'outputFile', type: 'text', label: '输出文件路径', placeholder: '如 output/result.txt' },
    {
      key: 'runOn',
      type: 'radio',
      label: '执行条件',
      options: [
        { value: 'success', label: '依赖成功时执行' },
        { value: 'failure', label: '依赖失败时执行' },
      ],
    },
  ],
  tool: [
    { key: 'tool', type: 'text', label: '工具名', placeholder: '如 analyze_task' },
    { key: 'outputFile', type: 'text', label: '输出文件路径', placeholder: '如 output/result.txt' },
    {
      key: 'runOn',
      type: 'radio',
      label: '执行条件',
      options: [
        { value: 'success', label: '依赖成功时执行' },
        { value: 'failure', label: '依赖失败时执行' },
      ],
    },
  ],
  api: [
    { key: 'apiUrl', type: 'text', label: 'API URL', placeholder: 'https://…' },
    { key: 'apiMethod', type: 'text', label: 'HTTP 方法', placeholder: 'GET' },
    { key: 'outputFile', type: 'text', label: '输出文件路径', placeholder: '如 output/result.txt' },
    {
      key: 'runOn',
      type: 'radio',
      label: '执行条件',
      options: [
        { value: 'success', label: '依赖成功时执行' },
        { value: 'failure', label: '依赖失败时执行' },
      ],
    },
  ],
  plan: [
    { key: 'planPrompt', type: 'textarea', label: '计划 Prompt', placeholder: '描述需要的计划…', rows: 12 },
    { key: 'outputFile', type: 'text', label: '输出文件路径', placeholder: '如 output/result.txt' },
    {
      key: 'runOn',
      type: 'radio',
      label: '执行条件',
      options: [
        { value: 'success', label: '依赖成功时执行' },
        { value: 'failure', label: '依赖失败时执行' },
      ],
    },
  ],
  condition: [
    { key: 'condition_source', type: 'text', label: '条件来源（模板引用）', placeholder: '如 {{steps.s1.result.score}}' },
    { key: 'condition_cases', type: 'array-editor', label: '条件分支' },
    { key: 'condition_defaultGoto', type: 'text', label: '默认跳转步骤', placeholder: '如 s_fallback' },
  ],
  foreach: [
    { key: 'foreach_items', type: 'text', label: '循环数组（模板引用）', placeholder: '如 {{steps.s2.result.platforms}}' },
    { key: 'foreach_workflowId', type: 'text', label: '子工作流 ID（引用已有）', placeholder: '如 adapt-to-platform' },
    { key: 'foreach_concurrency', type: 'number', label: '并发数', placeholder: '默认 3' },
  ],
  transform: [
    { key: 'transform_input', type: 'text', label: '输入来源（模板引用）', placeholder: '如 {{steps.s1.result}}' },
    { key: 'transform_mapping', type: 'kv-editor', label: '输出映射' },
  ],
  gate: [
    { key: 'gate_message', type: 'textarea', label: '审批提示信息', placeholder: '请输入审核提示…', rows: 4 },
    { key: 'gate_preview', type: 'textarea', label: '预览内容（模板引用）', placeholder: '如 {{steps.s4.result}}', rows: 6 },
  ],
  aggregate: [
    { key: 'aggregate_sources', type: 'multi-select-steps', label: '聚合来源步骤' },
    {
      key: 'aggregate_strategy',
      type: 'radio',
      label: '聚合策略',
      options: [
        { value: 'merge', label: '合并对象' },
        { value: 'concat', label: '拼接数组' },
        { value: 'pick-first', label: '取第一个' },
        { value: 'custom', label: '自定义' },
      ],
    },
    { key: 'aggregate_expression', type: 'text', label: '自定义表达式（聚合策略选 custom 时）', placeholder: '如 {{steps.s1.result}}' },
  ],
  subflow: [{ key: 'subflow_workflowId', type: 'text', label: '子工作流 ID', placeholder: '如 my-sub-workflow' }],
  wait: [{ key: 'wait_durationMs', type: 'number', label: '等待时长(ms)', placeholder: '如 5000' }],
  script: [{ key: 'script_code', type: 'textarea', label: 'JavaScript 代码', placeholder: 'return ctx.steps.s1.result', rows: 10 }],
  event: [
    { key: 'event_eventName', type: 'text', label: '事件名称', placeholder: '如 my.custom.event' },
    { key: 'event_payload', type: 'text', label: '事件载荷（模板引用）', placeholder: '可选' },
  ],
}

const SHARED_FIELDS: FieldDef[] = [
  { key: 'retryCount', type: 'number', label: '重试次数', placeholder: '默认 0（不重试）' },
  { key: 'retryDelayMs', type: 'number', label: '重试间隔(ms)', placeholder: '默认 5000' },
  { key: 'outputSchema', type: 'text', label: '输出 Schema（JSON）', placeholder: '{"type":"object","properties":{…}}' },
]

const HANDLER_KEYS: Record<string, Set<string>> = {}
for (const [handler, fields] of Object.entries(HANDLER_CONFIG_FIELDS)) {
  HANDLER_KEYS[handler] = new Set(fields.map((f) => f.key))
}
// 对于使用前缀 key 的 handler，做映射
const HANDLER_PREFIX_KEYS: Record<string, string[]> = {
  condition: ['condition_source', 'condition_cases', 'condition_defaultGoto'],
  foreach: ['foreach_items', 'foreach_workflowId', 'foreach_concurrency'],
  transform: ['transform_input', 'transform_mapping'],
  gate: ['gate_message', 'gate_preview'],
  aggregate: ['aggregate_sources', 'aggregate_strategy', 'aggregate_expression'],
  subflow: ['subflow_workflowId'],
  wait: ['wait_durationMs'],
  script: ['script_code'],
  event: ['event_eventName', 'event_payload'],
}

export function WorkflowEditor({ initial, onBack, onSaved }: Props) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [inputSchema, setInputSchema] = useState(initial?.inputSchema ?? '')
  const [outputDir, setOutputDir] = useState(initial?.outputDir ?? '')
  const [steps, setSteps] = useState<StepDef[]>(initial?.steps.length ? initial.steps : [EMPTY_STEP()])
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [editingStepId, setEditingStepId] = useState<string | null>(steps[0]?.id ?? null)

  const [showMeta, setShowMeta] = useState(false)

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; stepId: string | null } | null>(null)
  const copiedStep = useRef<StepDef | null>(null)
  const editorRef = useRef<HTMLDivElement>(null)

  const [expandedFields, setExpandedFields] = useState<Record<string, boolean>>({})
  const [, forceRender] = useState(0)

  // ── 运行面板 ──
  const [activeRuns, setActiveRuns] = useState<any[]>([])
  const [pipelineLogs, setPipelineLogs] = useState<Record<string, string[]>>({})
  const [showRunPanel, setShowRunPanel] = useState(false)
  const hasActiveRuns = activeRuns.some((r) => r.status === 'running')

  useIPCEvent(window.electronAPI.onWorkflowRunCreated, (data: any) => {
    setActiveRuns((prev) => {
      if (prev.some((r) => r.runId === data.runId)) return prev
      return [...prev, { ...data, status: 'running' }]
    })
    setShowRunPanel(true)
  })

  useIPCEvent(window.electronAPI.onWorkflowRunUpdated, (data: any) => {
    setActiveRuns((prev) => prev.map((r) => (r.runId === data.runId ? { ...r, status: data.status } : r)))
  })

  useIPCEvent(window.electronAPI.onWorkflowRunStep, (data: any) => {
    setActiveRuns((prev) =>
      prev.map((r) =>
        r.runId === data.runId
          ? {
              ...r,
              steps: r.steps.map((s) =>
                s.stepId === data.stepId
                  ? { ...s, status: data.status, error: data.error ?? s.error, agentResult: data.agentResult ?? s.agentResult }
                  : s,
              ),
            }
          : r,
      ),
    )
    if (!data.agentResult) return
    setPipelineLogs((prev) => {
      const lines = prev[data.runId] ?? []
      if (lines[lines.length - 1] === data.agentResult) return prev
      return { ...prev, [data.runId]: [...lines, data.agentResult].slice(-100) }
    })
  })

  function updateStep(id: string, patch: Partial<StepDef>) {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  function updateStepConfig(id: string, config: Record<string, any>) {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, config: { ...s.config, ...config } } : s)))
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

  function duplicateStep(id: string) {
    const source = steps.find((s) => s.id === id)
    if (!source) return
    const idx = steps.findIndex((s) => s.id === id)
    const copy: StepDef = {
      ...JSON.parse(JSON.stringify(source)),
      id: freshStepId(),
      name: source.name ? `${source.name} (复制)` : '',
    }
    setSteps((prev) => {
      const arr = [...prev]
      arr.splice(idx + 1, 0, copy)
      return arr
    })
    setEditingStepId(copy.id)
  }

  function availableDeps(currentId: string): StepDef[] {
    return steps.filter((s) => s.id !== currentId)
  }

  function closeContextMenu() {
    setContextMenu(null)
  }

  function contextMenuDuplicate() {
    if (!contextMenu) return
    duplicateStep(contextMenu.stepId)
    closeContextMenu()
  }

  function contextMenuCopy() {
    if (!contextMenu) return
    const s = steps.find((st) => st.id === contextMenu.stepId)
    if (s) copiedStep.current = JSON.parse(JSON.stringify(s))
    closeContextMenu()
  }

  function contextMenuPaste() {
    if (!contextMenu || !copiedStep.current) return
    const idx = steps.findIndex((s) => s.id === contextMenu.stepId)
    const copy: StepDef = { ...JSON.parse(JSON.stringify(copiedStep.current)), id: freshStepId() }
    setSteps((prev) => {
      const arr = [...prev]
      arr.splice(idx + 1, 0, copy)
      return arr
    })
    setEditingStepId(copy.id)
    closeContextMenu()
  }

  function contextMenuMoveTop() {
    if (!contextMenu) return
    const idx = steps.findIndex((s) => s.id === contextMenu.stepId)
    if (idx <= 0) {
      closeContextMenu()
      return
    }
    setSteps((prev) => {
      const arr = [...prev]
      const [moved] = arr.splice(idx, 1)
      arr.unshift(moved)
      return arr
    })
    closeContextMenu()
  }

  function contextMenuMoveBottom() {
    if (!contextMenu) return
    const idx = steps.findIndex((s) => s.id === contextMenu.stepId)
    if (idx === -1 || idx === steps.length - 1) {
      closeContextMenu()
      return
    }
    setSteps((prev) => {
      const arr = [...prev]
      const [moved] = arr.splice(idx, 1)
      arr.push(moved)
      return arr
    })
    closeContextMenu()
  }

  function contextMenuDelete() {
    if (!contextMenu) return
    removeStep(contextMenu.stepId)
    closeContextMenu()
  }

  const handleSave = useCallback(async () => {
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
      inputSchema: inputSchema.trim() || undefined,
      outputDir: outputDir.trim() || undefined,
      steps: validSteps.map((s) => {
        const clean: any = {
          id: s.id,
          name: s.name.trim(),
          description: s.description.trim(),
          handler: s.handler,
          config: { ...s.config },
          dependsOn: s.dependsOn,
        }
        if (s.runOn) clean.runOn = s.runOn
        return clean
      }),
      createdAt: initial?.createdAt ?? now,
      updatedAt: now,
    }
    const result = await window.electronAPI.saveWorkflowDefinition(def)
    setSaving(false)
    if (result.success) {
      onSaved()
    } else {
      setError('保存失败')
    }
  }, [name, description, inputSchema, outputDir, steps, initial, onSaved, onBack])

  const handleRun = useCallback(async () => {
    if (!initial) {
      setError('请先保存再运行')
      return
    }
    setRunning(true)
    setError('')
    const result = await window.electronAPI.startWorkflow(initial.id)
    setRunning(false)
    if (result.success) {
      // 立即创建初始记录，无需等 IPC 事件
      setActiveRuns((prev) => {
        if (prev.some((r) => r.runId === result.runId)) return prev
        return [
          ...prev,
          {
            runId: result.runId,
            workflowDefId: initial.id,
            workflowName: name,
            status: 'running',
            steps: steps.map((s) => ({
              stepId: s.id,
              name: s.name,
              status: 'pending',
            })),
            startedAt: Date.now(),
          },
        ]
      })
      setShowRunPanel(true)
    } else {
      setError(result.error ?? '启动失败')
    }
  }, [initial, name, steps])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        handleSave()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'd' && editingStepId) {
        e.preventDefault()
        duplicateStep(editingStepId)
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && editingStepId) {
        const tag = document.activeElement?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        e.preventDefault()
        removeStep(editingStepId)
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleSave, editingStepId])

  useEffect(() => {
    if (!contextMenu) return
    const close = () => closeContextMenu()
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [contextMenu])

  const editingStep = steps.find((s) => s.id === editingStepId)

  function renderConfigField(step: StepDef, field: FieldDef) {
    // 处理带前缀的 key：gate_message → config.gate.message
    const [handlerPrefix, ...fieldParts] = field.key.split('_')
    const isPrefixed = !!HANDLER_PREFIX_KEYS[handlerPrefix]
    const configPath = isPrefixed ? [handlerPrefix, ...fieldParts] : [field.key]

    function getNestedConfig(obj: any, path: string[]): any {
      let val = obj.config || {}
      for (const k of path) {
        if (val === undefined || val === null) return undefined
        val = val[k]
      }
      return val ?? ''
    }

    function setNestedConfig(stepId: string, path: string[], value: any) {
      const current = steps.find((s) => s.id === stepId)?.config || {}
      const newConfig = { ...current }
      let target = newConfig
      for (let i = 0; i < path.length - 1; i++) {
        if (!target[path[i]] || typeof target[path[i]] !== 'object') target[path[i]] = {}
        target = target[path[i]]
      }
      target[path[path.length - 1]] = value
      updateStepConfig(step.id, newConfig)
    }

    const fieldValue = getNestedConfig(step, configPath)
    switch (field.type) {
      case 'textarea': {
        const val = fieldValue ?? ''
        const isExpanded = expandedFields[field.key] ?? false
        const showToggle = typeof val === 'string' && val.length > 200
        return (
          <div key={field.key} className="wf-editor-field wf-editor-prompt-field">
            <div className="wf-editor-prompt-header">
              <label>{field.label}</label>
              {showToggle && (
                <button
                  className="wf-editor-prompt-toggle"
                  onClick={() => setExpandedFields((p) => ({ ...p, [field.key]: !isExpanded }))}
                  type="button"
                >
                  <i className={`ri-${isExpanded ? 'contract' : 'expand'}-up-down-line`} />
                  {isExpanded ? '收起' : '展开全部'}
                </button>
              )}
            </div>
            <textarea
              className="wf-editor-prompt-textarea"
              value={val}
              onChange={(e) => {
                if (isPrefixed) setNestedConfig(step.id, configPath, e.target.value)
                else updateStepConfig(step.id, { [field.key]: e.target.value })
              }}
              placeholder={field.placeholder}
              rows={isExpanded ? 24 : (field.rows ?? 4)}
            />
          </div>
        )
      }
      case 'number': {
        const val = fieldValue
        return (
          <div key={field.key} className="wf-editor-field">
            <label>{field.label}</label>
            <input
              className="wf-editor-number-input"
              type="number"
              value={val ?? ''}
              onChange={(e) => {
                const v = e.target.value
                if (isPrefixed) setNestedConfig(step.id, configPath, v ? Number(v) : undefined)
                else updateStepConfig(step.id, { [field.key]: v ? Number(v) : undefined })
              }}
              placeholder={field.placeholder}
            />
          </div>
        )
      }
      case 'text': {
        const val = fieldValue ?? ''
        return (
          <div key={field.key} className="wf-editor-field">
            <label>{field.label}</label>
            <input
              type="text"
              value={val}
              onChange={(e) => {
                if (isPrefixed) setNestedConfig(step.id, configPath, e.target.value)
                else updateStepConfig(step.id, { [field.key]: e.target.value })
              }}
              placeholder={field.placeholder}
            />
          </div>
        )
      }
      case 'multi-select': {
        const selected = (step.config.allowedTools ?? []) as string[]
        const allTools = TOOL_GROUPS.flatMap((g) => g.tools)
        return (
          <div key={field.key} className="wf-editor-field">
            <label>{field.label}</label>
            <div className="wf-editor-multi-select">
              {TOOL_GROUPS.map((group) => {
                const groupSelected = group.tools.every((t) => selected.includes(t))
                const groupPartial = group.tools.some((t) => selected.includes(t)) && !groupSelected
                return (
                  <div key={group.label} className="wf-editor-multi-group">
                    <label className="wf-editor-multi-group-label">
                      <input
                        type="checkbox"
                        checked={groupSelected}
                        indeterminate={groupPartial}
                        onChange={() => {
                          const next = groupSelected
                            ? selected.filter((t) => !group.tools.includes(t))
                            : [...new Set([...selected, ...group.tools])]
                          updateStepConfig(step.id, { allowedTools: next.length > 0 ? next : undefined })
                        }}
                      />
                      <strong>{group.label}</strong>
                      <span className="wf-editor-multi-group-count">{group.tools.length}</span>
                    </label>
                    <div className="wf-editor-multi-group-items">
                      {group.tools.map((tool) => (
                        <label key={tool} className="wf-editor-multi-select-item">
                          <input
                            type="checkbox"
                            checked={selected.includes(tool)}
                            onChange={() => {
                              const next = selected.includes(tool) ? selected.filter((t) => t !== tool) : [...selected, tool]
                              updateStepConfig(step.id, { allowedTools: next.length > 0 ? next : undefined })
                            }}
                          />
                          <span>{tool}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      }
      case 'radio': {
        const val = isPrefixed ? (getNestedConfig(step, configPath) ?? 'merge') : (step.runOn ?? 'success')
        const onChange = isPrefixed
          ? (v: string) => setNestedConfig(step.id, configPath, v)
          : (v: string) => updateStep(step.id, { runOn: v as 'success' | 'failure' })
        return (
          <div key={field.key} className="wf-editor-field">
            <label>{field.label}</label>
            <div className="wf-editor-radio-group">
              {(field.options ?? []).map((opt) => (
                <label key={opt.value} className={`wf-editor-radio-label${val === opt.value ? ' active' : ''}`}>
                  <input type="radio" name={`${field.key}_${step.id}`} checked={val === opt.value} onChange={() => onChange(opt.value)} />
                  <span>{opt.label}</span>
                </label>
              ))}
            </div>
          </div>
        )
      }
      case 'array-editor': {
        const items = Array.isArray(fieldValue) ? fieldValue : []
        const [newIf, setNewIf] = useState('')
        const [newGoto, setNewGoto] = useState('')
        return (
          <div key={field.key} className="wf-editor-field">
            <label>{field.label}</label>
            <div className="wf-editor-kv-editor">
              {items.map((item: any, idx: number) => (
                <div key={idx} className="wf-editor-kv-row">
                  <input className="wf-editor-kv-input" value={item.if || ''} readOnly placeholder="条件" />
                  <span className="wf-editor-kv-arrow">→</span>
                  <input className="wf-editor-kv-input" value={item.goto || ''} readOnly placeholder="目标步骤" />
                  <button
                    className="wf-editor-kv-del"
                    onClick={() => {
                      const next = items.filter((_: any, i: number) => i !== idx)
                      setNestedConfig(step.id, configPath, next.length ? next : undefined)
                      forceRender()
                    }}
                  >
                    <i className="ri-close-line" />
                  </button>
                </div>
              ))}
              <div className="wf-editor-kv-new">
                <input className="wf-editor-kv-input" value={newIf} onChange={(e) => setNewIf(e.target.value)} placeholder="条件如 >= 7" />
                <span className="wf-editor-kv-arrow">→</span>
                <input
                  className="wf-editor-kv-input"
                  value={newGoto}
                  onChange={(e) => setNewGoto(e.target.value)}
                  placeholder="目标步骤 ID"
                />
                <button
                  className="wf-editor-kv-add"
                  onClick={() => {
                    if (!newIf.trim() || !newGoto.trim()) return
                    setNestedConfig(step.id, configPath, [...items, { if: newIf.trim(), goto: newGoto.trim() }])
                    setNewIf('')
                    setNewGoto('')
                    forceRender()
                  }}
                >
                  <i className="ri-add-line" />
                </button>
              </div>
            </div>
          </div>
        )
      }
      case 'kv-editor': {
        const mapping = fieldValue && typeof fieldValue === 'object' ? fieldValue : {}
        const [newKey, setNewKey] = useState('')
        const [newVal, setNewVal] = useState('')
        return (
          <div key={field.key} className="wf-editor-field">
            <label>{field.label}</label>
            <div className="wf-editor-kv-editor">
              {Object.entries(mapping).map(([k, v]: [string, any]) => (
                <div key={k} className="wf-editor-kv-row">
                  <input className="wf-editor-kv-input" value={k} readOnly />
                  <span className="wf-editor-kv-arrow">:</span>
                  <input className="wf-editor-kv-input wf-editor-kv-input-wide" value={String(v || '')} readOnly />
                  <button
                    className="wf-editor-kv-del"
                    onClick={() => {
                      const next = { ...mapping }
                      delete next[k]
                      setNestedConfig(step.id, configPath, Object.keys(next).length ? next : undefined)
                      forceRender()
                    }}
                  >
                    <i className="ri-close-line" />
                  </button>
                </div>
              ))}
              <div className="wf-editor-kv-new">
                <input className="wf-editor-kv-input" value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="字段名" />
                <span className="wf-editor-kv-arrow">:</span>
                <input
                  className="wf-editor-kv-input wf-editor-kv-input-wide"
                  value={newVal}
                  onChange={(e) => setNewVal(e.target.value)}
                  placeholder="模板表达式"
                />
                <button
                  className="wf-editor-kv-add"
                  onClick={() => {
                    if (!newKey.trim() || !newVal.trim()) return
                    setNestedConfig(step.id, configPath, { ...mapping, [newKey.trim()]: newVal.trim() })
                    setNewKey('')
                    setNewVal('')
                    forceRender()
                  }}
                >
                  <i className="ri-add-line" />
                </button>
              </div>
            </div>
          </div>
        )
      }
      case 'multi-select-steps': {
        const selected: string[] = Array.isArray(fieldValue) ? fieldValue : step.dependsOn.filter((d) => d !== step.id)
        const sourceCandidates = steps.filter((s: StepDef) => s.id !== step.id)
        return (
          <div key={field.key} className="wf-editor-field">
            <label>{field.label}</label>
            <div className="wf-editor-multi-select" style={{ maxHeight: 200, overflowY: 'auto' }}>
              {sourceCandidates.map((s: StepDef) => (
                <label key={s.id} className="wf-editor-multi-select-item">
                  <input
                    type="checkbox"
                    checked={selected.includes(s.id)}
                    onChange={() => {
                      const next = selected.includes(s.id) ? selected.filter((id: string) => id !== s.id) : [...selected, s.id]
                      setNestedConfig(step.id, configPath, next.length ? next : undefined)
                    }}
                  />
                  <span>{s.name || s.id}</span>
                </label>
              ))}
            </div>
          </div>
        )
      }
      default:
        return null
    }
  }

  return (
    <div className="wf-editor" ref={editorRef}>
      <div className="wf-editor-header">
        <button className="wf-editor-back" onClick={onBack}>
          <i className="ri-arrow-left-line" />
        </button>
        <h2 className="wf-editor-title">{initial ? '编辑工作流' : '新建工作流'}</h2>
        <div className="wf-editor-actions">
          <button className={`wf-editor-btn-gear${showMeta ? ' active' : ''}`} onClick={() => setShowMeta(!showMeta)} title="工作流设置">
            <i className="ri-settings-3-line" />
          </button>
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

      {/* 可折叠元信息面板 */}
      <div className={`wf-editor-meta-section wf-editor-meta-${showMeta ? 'expanded' : 'collapsed'}`}>
        <div className="wf-editor-field">
          <label>工作流名称</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：代码审查管线" />
        </div>
        <div className="wf-editor-field">
          <label>描述</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="描述这个工作流的用途…" rows={2} />
        </div>
        <div className="wf-editor-field">
          <label>输入参数描述 (inputSchema)</label>
          <textarea
            value={inputSchema}
            onChange={(e) => setInputSchema(e.target.value)}
            placeholder="格式: 主题: string, 目标平台: string"
            rows={2}
          />
        </div>
        <div className="wf-editor-field">
          <label>成果输出目录 (outputDir)</label>
          <input value={outputDir} onChange={(e) => setOutputDir(e.target.value)} placeholder="如 ~/Desktop/输出目录" />
        </div>
      </div>

      <div className="wf-editor-body">
        <WorkflowCanvas
          steps={steps}
          editingStepId={editingStepId}
          onSelectStep={setEditingStepId}
          onAddStep={addStep}
          onDeleteStep={removeStep}
          onDuplicateStep={duplicateStep}
          onContextMenu={(x, y, stepId) => setContextMenu({ x, y, stepId })}
        />
        {showRunPanel ? (
          <WorkflowRunPanel
            runs={activeRuns.filter((r) => r.status === 'running' || r.pendingGate)}
            pipelineLogs={pipelineLogs}
            onCancel={async (runId) => {
              await window.electronAPI.stopWorkflowRun(runId)
            }}
            onClose={() => setShowRunPanel(false)}
            onApproveGate={(runId, stepId, decision, modifiedInput) => {
              window.electronAPI.approveGate(runId, stepId, decision, modifiedInput)
            }}
          />
        ) : (
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
                        onClick={() => {
                          if (editingStep.handler === h.value) return
                          updateStep(editingStep.id, { handler: h.value })
                        }}
                      >
                        <i className={h.icon} />
                        <span>{h.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
                {HANDLER_CONFIG_FIELDS[editingStep.handler]?.map((field) => renderConfigField(editingStep, field))}
                {SHARED_FIELDS.map((field) => renderConfigField(editingStep, field))}
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
                <span>从画布选择一个步骤进行配置</span>
              </div>
            )}
          </div>
        )}
      </div>

      {contextMenu && (
        <div className="wf-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          {contextMenu.stepId ? (
            <>
              <button className="wf-context-menu-item" onClick={contextMenuCopy}>
                <i className="ri-file-copy-line" /> 复制步骤
              </button>
              <button
                className={`wf-context-menu-item${!copiedStep.current ? ' wf-context-menu-disabled' : ''}`}
                onClick={contextMenuPaste}
                disabled={!copiedStep.current}
              >
                <i className="ri-clipboard-line" /> 粘贴步骤
              </button>
              <button className="wf-context-menu-item" onClick={contextMenuDuplicate}>
                <i className="ri-file-copy-2-line" /> 复制并粘贴
              </button>
              <div className="wf-context-menu-divider" />
              <button className="wf-context-menu-item" onClick={contextMenuMoveTop}>
                <i className="ri-arrow-up-double-line" /> 移到顶部
              </button>
              <button className="wf-context-menu-item" onClick={contextMenuMoveBottom}>
                <i className="ri-arrow-down-double-line" /> 移到底部
              </button>
              <div className="wf-context-menu-divider" />
              <button className="wf-context-menu-item wf-context-menu-danger" onClick={contextMenuDelete}>
                <i className="ri-delete-bin-line" /> 删除步骤
              </button>
            </>
          ) : (
            <>
              <button
                className="wf-context-menu-item"
                onClick={() => {
                  addStep()
                  closeContextMenu()
                }}
              >
                <i className="ri-add-line" /> 添加步骤
              </button>
              <button
                className={`wf-context-menu-item${!copiedStep.current ? ' wf-context-menu-disabled' : ''}`}
                onClick={contextMenuPaste}
                disabled={!copiedStep.current}
              >
                <i className="ri-clipboard-line" /> 粘贴步骤
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
