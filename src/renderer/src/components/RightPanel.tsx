import { useState, useEffect, useCallback, useRef } from 'react'
import { useSlots } from '../slots/SlotContext'
import { useDesktopToolbarStore, type DesktopTask } from '../store/desktopToolbarStore'
import { BookmarkPanel } from './BookmarkPanel'

type RightTab = 'tools' | 'evolution' | 'monitor' | 'memory' | 'bookmarks'

// =============================================================================
// 类型定义
// =============================================================================

interface EvoDashData {
  stage: string
  progress: number
  summary: string
  errorCount: number
  fixedCount: number
  queueSize: number
  lastRunAt: number | null
  schedulerState: string
  safetyMode: string
  consecutiveFailures: number
  visible: boolean
  updatedAt: number
}

interface MonitoringData {
  evoLocked: boolean
  evolution?: { stage: string; progress: number; summary: string }
  plan?: { hasActivePlan: boolean; title: string; progress: number; steps: string; current: string }
  resources?: { cpu: number; memory: number; gpu?: number }
  recentChanges?: Array<{ type: string; filePath: string; timestamp: number; summary: string }>
}

interface BehaviorState {
  activityState: string
  appCategory: string
  mode: string
  idleTimeMs: number
  focused: boolean
  fullscreen: boolean
  confidence: number
}

interface MemoryCardData {
  id: string
  content: string
  type: string
  confidence: number
  tier: string
  topics: string[]
  behaviorScore: number
  isPinned: boolean
  createdAt: number
  updatedAt: number
}

interface MemoryContextPayload {
  cards: MemoryCardData[]
  updatedAt: number
  hasData: boolean
  displayType: string
  error?: string
}

// =============================================================================
// 常量
// =============================================================================

const STAGE_LABELS: Record<string, string> = {
  idle: '待机',
  collecting: '采集中',
  analyzing: '分析中',
  fixing: '修复中',
  verifying: '验证中',
  cooldown: '冷却',
  error: '异常',
}

const STAGE_COLORS: Record<string, string> = {
  idle: 'var(--text-muted)',
  collecting: 'oklch(0.76 0.12 80)',
  analyzing: 'oklch(0.76 0.12 80)',
  fixing: 'var(--accent)',
  verifying: 'var(--accent-soft)',
  cooldown: '#f59e0b',
  error: 'var(--accent-red)',
}

const TIER_LABELS: Record<string, string> = { permanent: '永久', semi: '半永久', ephemeral: '临时' }
const TIER_COLORS: Record<string, string> = { permanent: '#f59e0b', semi: 'oklch(0.7 0.11 75)', ephemeral: 'oklch(0.62 0.015 75)' }

const ACTIVITY_LABELS: Record<string, string> = {
  active: '活跃中',
  idle: '闲置',
  focused: '专注中',
  multitasking: '多任务',
  away: '离开',
}

const MODE_LABELS: Record<string, string> = {
  working: '工作',
  coding: '编程',
  reading: '阅读',
  leisure: '休闲',
  sleeping: '睡眠',
}

interface ToolButton {
  id: string
  label: string
  icon: string
  tool: string
  defaultArgs: Record<string, string>
  inputPrompt: string
  inputField: string
}

const TOOL_BUTTONS: ToolButton[] = [
  {
    id: 'quick_note',
    label: '快速笔记',
    icon: 'ri-sticky-note-line',
    tool: 'desktop_quick_note',
    defaultArgs: {},
    inputPrompt: '输入笔记内容',
    inputField: 'content',
  },
  {
    id: 'todo_add',
    label: '待办添加',
    icon: 'ri-task-line',
    tool: 'desktop_todo_add',
    defaultArgs: { priority: 'normal' },
    inputPrompt: '输入待办事项',
    inputField: 'title',
  },
  {
    id: 'app_launch',
    label: '应用启动',
    icon: 'ri-apps-2-line',
    tool: 'desktop_app_launch',
    defaultArgs: {},
    inputPrompt: '输入应用名（如 vscode, chrome）',
    inputField: 'appName',
  },
  {
    id: 'search_web',
    label: '联网搜索',
    icon: 'ri-search-line',
    tool: 'desktop_search_web',
    defaultArgs: {},
    inputPrompt: '输入搜索关键词',
    inputField: 'query',
  },
  {
    id: 'translate',
    label: '翻译',
    icon: 'ri-translate-2',
    tool: 'desktop_translate',
    defaultArgs: { target: 'zh' },
    inputPrompt: '输入要翻译的文本',
    inputField: 'text',
  },
]

// =============================================================================
// RightPanel 组件
// =============================================================================

export function RightPanel() {
  const { uiState, toggleRightPanel } = useSlots()
  const [tab, setTab] = useState<RightTab>('evolution')

  // ── IPC 数据 ──
  const [evoData, setEvoData] = useState<EvoDashData | null>(null)
  const [monData, setMonData] = useState<MonitoringData | null>(null)
  const [behavData, setBehavData] = useState<BehaviorState | null>(null)
  const [memData, setMemData] = useState<MemoryContextPayload | null>(null)
  const [planStatus, setPlanStatus] = useState<{ title: string; pct: number; step: string } | null>(null)
  const [evoLocked, setEvoLocked] = useState(false)

  // ── 工具状态 ──
  const { tasks, feedback, expanded, addTask, updateTask, showFeedback, toggleExpanded } = useDesktopToolbarStore()
  const [activeInput, setActiveInput] = useState<string | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [executingTool, setExecutingTool] = useState<string | null>(null)

  // ── 批更新 ──
  const pendingRef = useRef<{ evo?: EvoDashData; mon?: MonitoringData; mem?: MemoryContextPayload }>({})
  const rafRef = useRef<number | null>(null)

  const flushBatch = useCallback(() => {
    const p = pendingRef.current
    if (p.evo !== undefined) {
      setEvoData(p.evo)
      p.evo = undefined
    }
    if (p.mon !== undefined) {
      setMonData(p.mon)
      setEvoLocked(p.mon.evoLocked)
      p.mon = undefined
    }
    if (p.mem !== undefined) {
      setMemData(p.mem)
      p.mem = undefined
    }
    rafRef.current = null
  }, [])

  const scheduleBatch = useCallback(() => {
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(flushBatch)
  }, [flushBatch])

  // ── IPC 订阅 ──
  useEffect(() => {
    const unsub1 = (window as any).electronAPI?.onEvolutionDashboard?.((data: EvoDashData) => {
      pendingRef.current.evo = data
      scheduleBatch()
    })
    const unsub2 = (window as any).electronAPI?.onMonitoringMetrics?.((data: MonitoringData) => {
      pendingRef.current.mon = data
      scheduleBatch()
    })
    const unsub3 = (window as any).electronAPI?.onMemoryContextData?.((data: MemoryContextPayload) => {
      pendingRef.current.mem = data
      scheduleBatch()
    })
    const unsub4 = (window as any).electronAPI?.onBehaviorState?.((data: BehaviorState) => {
      pendingRef.current
      setBehavData(data)
    })
    return () => {
      unsub1?.()
      unsub2?.()
      unsub3?.()
      unsub4?.()
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [scheduleBatch])

  // ── 轮询计划状态 ──
  useEffect(() => {
    const poll = async () => {
      try {
        const r = await (window as any).electronAPI?.getEvolutionPlanStatus?.()
        if (r?.hasActivePlan) setPlanStatus({ title: r.planTitle, pct: r.percentComplete, step: r.currentStep })
        else setPlanStatus(null)
      } catch {}
    }
    poll()
    const iv = setInterval(poll, 5000)
    return () => clearInterval(iv)
  }, [])

  // ── 工具执行 ──
  const invokeTool = useCallback(
    async (btn: ToolButton, args: Record<string, string>) => {
      const taskId = `dt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      const task: DesktopTask = {
        id: taskId,
        title: args[btn.inputField] || btn.label,
        tool: btn.tool,
        status: 'running',
        createdAt: Date.now(),
      }
      addTask(task)
      setExecutingTool(btn.id)
      try {
        const result = await (window as any).electronAPI.invokeDesktopTool(btn.tool, args)
        const success = !result?.error && result?.success !== false
        updateTask(taskId, { status: success ? 'success' : 'error', result: result?.result || '', error: result?.error })
        showFeedback({
          tool: btn.id,
          label: btn.label,
          success,
          message: result?.result || result?.error || (success ? '完成' : '失败'),
          timestamp: Date.now(),
        })
      } catch (err: any) {
        updateTask(taskId, { status: 'error', error: String(err) })
        showFeedback({ tool: btn.id, label: btn.label, success: false, message: `错误: ${err.message}`, timestamp: Date.now() })
      } finally {
        setExecutingTool(null)
      }
    },
    [addTask, updateTask, showFeedback],
  )

  const handleToolClick = useCallback(
    (btn: ToolButton) => {
      if (btn.inputPrompt) {
        if (activeInput === btn.id) {
          if (inputValue.trim()) invokeTool(btn, { ...btn.defaultArgs, [btn.inputField]: inputValue.trim() })
          setInputValue('')
          setActiveInput(null)
        } else {
          setActiveInput(btn.id)
          setInputValue('')
        }
      } else invokeTool(btn, btn.defaultArgs)
    },
    [activeInput, inputValue, invokeTool],
  )

  const handleInputSubmit = useCallback(
    (btn: ToolButton) => {
      if (inputValue.trim()) invokeTool(btn, { ...btn.defaultArgs, [btn.inputField]: inputValue.trim() })
      setInputValue('')
      setActiveInput(null)
    },
    [inputValue, invokeTool],
  )

  const handleLockToggle = useCallback(async (locked: boolean) => {
    try {
      const r = await (window as any).electronAPI.setEvoLock(locked)
      if (r.success) setEvoLocked(r.locked)
    } catch {}
  }, [])

  if (!uiState.rightPanelOpen) return null

  const stage = evoData?.stage || 'idle'
  const stageColor = STAGE_COLORS[stage] || 'var(--text-muted)'
  const stageLabel = STAGE_LABELS[stage] || stage
  const evolutionProgress = stage === 'analyzing' || stage === 'fixing' ? 40 : Math.max(0, Math.min(100, evoData?.progress ?? 0))
  const pendingCount = tasks.filter((t) => t.status === 'pending' || t.status === 'running').length

  return (
    <aside className="right-panel">
      <div className="right-panel-header">
        <div className="right-panel-heading">
          <span className="right-panel-title">工作台</span>
          <span className="right-panel-context">
            {tab === 'evolution' ? '进化' : tab === 'monitor' ? '监控' : tab === 'tools' ? '工具' : tab === 'memory' ? '记忆' : '书签'}
          </span>
        </div>
        <div className="right-panel-tabs">
          <button
            className={`right-panel-tab${tab === 'evolution' ? ' active' : ''}`}
            onClick={() => setTab('evolution')}
            title="进化"
            aria-label="进化"
            aria-pressed={tab === 'evolution'}
          >
            <i className="ri-robot-2-line" />
            <span className="right-panel-tab-index">01</span>
            <span className="right-panel-tab-name">进化</span>
          </button>
          <button
            className={`right-panel-tab${tab === 'monitor' ? ' active' : ''}`}
            onClick={() => setTab('monitor')}
            title="监控"
            aria-label="监控"
            aria-pressed={tab === 'monitor'}
          >
            <i className="ri-dashboard-3-line" />
            <span className="right-panel-tab-index">02</span>
            <span className="right-panel-tab-name">监控</span>
          </button>
          <button
            className={`right-panel-tab${tab === 'tools' ? ' active' : ''}`}
            onClick={() => setTab('tools')}
            title="工具"
            aria-label="工具"
            aria-pressed={tab === 'tools'}
          >
            <i className="ri-tools-line" />
            <span className="right-panel-tab-index">03</span>
            <span className="right-panel-tab-name">工具</span>
          </button>
          <button
            className={`right-panel-tab${tab === 'memory' ? ' active' : ''}`}
            onClick={() => setTab('memory')}
            title="记忆"
            aria-label="记忆"
            aria-pressed={tab === 'memory'}
          >
            <i className="ri-brain-line" />
            <span className="right-panel-tab-index">04</span>
            <span className="right-panel-tab-name">记忆</span>
          </button>
          <button
            className={`right-panel-tab${tab === 'bookmarks' ? ' active' : ''}`}
            onClick={() => setTab('bookmarks')}
            title="语音书签"
            aria-label="语音书签"
            aria-pressed={tab === 'bookmarks'}
          >
            <i className="ri-bookmark-3-line" />
            <span className="right-panel-tab-index">05</span>
            <span className="right-panel-tab-name">书签</span>
          </button>
        </div>
        <button className="right-panel-close" onClick={toggleRightPanel} title="收起右侧面板" aria-label="收起工作台">
          <i className="ri-close-line" />
          <span className="right-panel-close-fallback" aria-hidden="true">
            ×
          </span>
        </button>
      </div>

      <div className="right-panel-body">
        {/* ════════════════════════════════════ 进化 Tab ════════════════════════════════════ */}
        {tab === 'evolution' && (
          <div className="right-panel-section">
            {/* 阶段与模式 */}
            <div className="rp-evo-stage">
              <span className="rp-evo-badge" style={{ '--rp-stage': stageColor } as any}>
                {stageLabel}
              </span>
              <span className="rp-evo-mode">{evoData?.safetyMode === 'review' ? '审查模式' : '自动'}</span>
            </div>

            {/* 进度条 */}
            <div className="rp-evo-progress">
              <div className="rp-evo-track">
                <div
                  className="rp-evo-fill"
                  style={{
                    width: `${evolutionProgress}%`,
                    background: stageColor,
                  }}
                />
              </div>
            </div>

            <div className="rp-evo-metrics" aria-label="进化概况">
              <div className="rp-evo-metric">
                <span>进度</span>
                <strong>{Math.round(evolutionProgress)}%</strong>
              </div>
              <div className="rp-evo-metric">
                <span>模式</span>
                <strong>{evoData?.safetyMode === 'review' ? '审查' : '自动'}</strong>
              </div>
              <div className="rp-evo-metric">
                <span>队列</span>
                <strong>{evoData?.queueSize ?? 0}</strong>
              </div>
              <div className="rp-evo-metric">
                <span>上次运行</span>
                <strong>{evoData?.lastRunAt ? formatTimeAgo(evoData.lastRunAt) : '暂无'}</strong>
              </div>
            </div>

            {/* 计划进度 */}
            {planStatus && (
              <div className="rp-evo-plan">
                <div className="rp-evo-plan-header">
                  <span className="rp-evo-plan-title">{planStatus.title}</span>
                  <span className="rp-evo-plan-pct">{planStatus.pct}%</span>
                </div>
                <div className="rp-evo-track">
                  <div className="rp-evo-fill" style={{ width: `${planStatus.pct}%`, background: 'var(--accent)' }} />
                </div>
                {planStatus.step && <span className="rp-evo-current">{planStatus.step}</span>}
              </div>
            )}

            {/* 摘要 */}
            {evoData?.summary && <p className="rp-evo-summary">{evoData.summary}</p>}

            {/* 统计 */}
            <div className="rp-evo-stats">
              {(evoData?.fixedCount ?? 0) > 0 && (
                <span className="rp-stat good">
                  <i className="ri-check-line" /> {evoData!.fixedCount} 修复
                </span>
              )}
              {(evoData?.errorCount ?? 0) > 0 && (
                <span className="rp-stat bad">
                  <i className="ri-error-warning-line" /> {evoData!.errorCount} 错误
                </span>
              )}
              {(evoData?.queueSize ?? 0) > 0 && (
                <span className="rp-stat queue">
                  <i className="ri-stack-line" /> {evoData!.queueSize} 待
                </span>
              )}
              {(evoData?.consecutiveFailures ?? 0) > 0 && (
                <span className="rp-stat bad">
                  <i className="ri-close-circle-line" /> 连续 {evoData!.consecutiveFailures} 次失败
                </span>
              )}
            </div>

            {/* 底部时间 + 触发按钮 */}
            <div className="rp-evo-footer">
              {evoData?.lastRunAt && (
                <span className="rp-evo-time">
                  <i className="ri-time-line" /> {formatTimeAgo(evoData.lastRunAt)}
                </span>
              )}
              <button
                className="rp-evo-trigger"
                onClick={async () => {
                  try {
                    await (window as any).electronAPI?.evolutionTrigger?.()
                  } catch {}
                }}
                title="触发进化"
              >
                <i className="ri-flashlight-line" /> 触发
              </button>
            </div>
          </div>
        )}

        {/* ════════════════════════════════════ 监控 Tab ════════════════════════════════════ */}
        {tab === 'monitor' && (
          <div className="right-panel-section">
            {/* 行为状态 */}
            {behavData && (
              <div className="rp-mon-block">
                <div className="rp-mon-header">
                  <i className="ri-user-smile-line" />
                  <span>行为状态</span>
                </div>
                <div className="rp-mon-grid">
                  <div className="rp-mon-item">
                    <span className="rp-mon-label">状态</span>
                    <span className="rp-mon-value">{ACTIVITY_LABELS[behavData.activityState] || behavData.activityState}</span>
                  </div>
                  <div className="rp-mon-item">
                    <span className="rp-mon-label">模式</span>
                    <span className="rp-mon-value">{MODE_LABELS[behavData.mode] || behavData.mode}</span>
                  </div>
                  <div className="rp-mon-item">
                    <span className="rp-mon-label">应用</span>
                    <span className="rp-mon-value rp-mon-trunc">{behavData.appCategory || '—'}</span>
                  </div>
                  <div className="rp-mon-item">
                    <span className="rp-mon-label">置信</span>
                    <span className="rp-mon-value">{Math.round(behavData.confidence * 100)}%</span>
                  </div>
                  <div className="rp-mon-item">
                    <span className="rp-mon-label">闲置</span>
                    <span className="rp-mon-value">
                      {behavData.idleTimeMs > 60000
                        ? `${Math.floor(behavData.idleTimeMs / 60000)}m`
                        : `${Math.round(behavData.idleTimeMs / 1000)}s`}
                    </span>
                  </div>
                  <div className="rp-mon-item">
                    <span className="rp-mon-label">焦点</span>
                    <span className="rp-mon-value">{behavData.focused ? '聚焦' : '后台'}</span>
                  </div>
                </div>
              </div>
            )}

            {/* 进化引擎 */}
            {monData?.evolution && monData.evolution.stage !== 'idle' && (
              <div className="rp-mon-block">
                <div className="rp-mon-header">
                  <i className="ri-robot-2-line" />
                  <span>进化引擎</span>
                </div>
                <div className="rp-mon-status-row">
                  <span className="rp-mon-label">阶段</span>
                  <span className="rp-mon-value">{STAGE_LABELS[monData.evolution.stage] || monData.evolution.stage}</span>
                </div>
                <div className="rp-mon-bar-row">
                  <div className="rp-mon-bar">
                    <div
                      className="rp-mon-fill"
                      style={{
                        width: `${monData.evolution.progress}%`,
                        background: STAGE_COLORS[monData.evolution.stage] || 'var(--accent)',
                      }}
                    />
                  </div>
                  <span className="rp-mon-pct">{monData.evolution.progress}%</span>
                </div>
              </div>
            )}

            {/* 活动计划 */}
            {planStatus && (
              <div className="rp-mon-block">
                <div className="rp-mon-header">
                  <i className="ri-file-list-3-line" />
                  <span>活动计划</span>
                </div>
                <div className="rp-mon-status-row">
                  <span className="rp-mon-label">{planStatus.title}</span>
                  <span className="rp-mon-value">{planStatus.pct}%</span>
                </div>
                <div className="rp-mon-bar-row">
                  <div className="rp-mon-bar">
                    <div className="rp-mon-fill plan" style={{ width: `${planStatus.pct}%` }} />
                  </div>
                </div>
                {planStatus.step && <span className="rp-mon-current">{planStatus.step}</span>}
              </div>
            )}

            {/* 系统资源 */}
            {monData?.resources && (
              <div className="rp-mon-block">
                <div className="rp-mon-header">
                  <i className="ri-funds-line" />
                  <span>系统资源</span>
                </div>
                {monData.resources.cpu !== undefined && (
                  <div className="rp-mon-bar-row">
                    <span className="rp-mon-label">CPU</span>
                    <div className="rp-mon-bar">
                      <div className="rp-mon-fill" style={{ width: `${monData.resources.cpu}%` }} />
                    </div>
                    <span className="rp-mon-pct">{monData.resources.cpu}%</span>
                  </div>
                )}
                {monData.resources.memory !== undefined && (
                  <div className="rp-mon-bar-row">
                    <span className="rp-mon-label">内存</span>
                    <div className="rp-mon-bar">
                      <div className="rp-mon-fill mem" style={{ width: `${monData.resources.memory}%` }} />
                    </div>
                    <span className="rp-mon-pct">{monData.resources.memory}%</span>
                  </div>
                )}
              </div>
            )}

            {/* 锁定 */}
            <div className="rp-mon-lock-row">
              <button className={`rp-mon-lock-btn${evoLocked ? ' locked' : ''}`} onClick={() => handleLockToggle(!evoLocked)}>
                <i className={`ri-lock-${evoLocked ? '' : 'un'}lock-line`} />
                <span>{evoLocked ? '已锁定进化' : '未锁定'}</span>
              </button>
            </div>

            {/* 最近变更 */}
            {monData?.recentChanges && monData.recentChanges.length > 0 && (
              <div className="rp-mon-block">
                <div className="rp-mon-header">
                  <i className="ri-file-edit-line" />
                  <span>最近变更</span>
                </div>
                {monData.recentChanges.slice(0, 5).map((c, i) => (
                  <div key={i} className="rp-change-item">
                    <span className={`rp-change-type ${c.type}`}>{c.type === 'new' ? '+' : c.type === 'deleted' ? '-' : '~'}</span>
                    <span className="rp-change-file">{c.filePath.split('/').pop() || c.filePath}</span>
                  </div>
                ))}
              </div>
            )}

            {!behavData && !monData && !planStatus && <p className="rp-empty">暂无监控数据</p>}
          </div>
        )}

        {/* ════════════════════════════════════ 工具 Tab ════════════════════════════════════ */}
        {tab === 'tools' && (
          <div className="right-panel-section">
            <div className="rp-tools">
              {TOOL_BUTTONS.map((btn) => {
                const isActive = activeInput === btn.id
                const isExec = executingTool === btn.id
                return (
                  <div key={btn.id} className="rp-tool-item">
                    <button
                      className={`rp-tool-btn${isActive ? ' active' : ''}${isExec ? ' executing' : ''}`}
                      onClick={() => handleToolClick(btn)}
                      title={btn.label}
                      disabled={isExec}
                    >
                      <i className={`${btn.icon}${isExec ? ' ri-spin' : ''}`} />
                      <span className="rp-tool-label">{btn.label}</span>
                    </button>
                    {isActive && (
                      <div className="rp-tool-input">
                        <input
                          type="text"
                          className="rp-input"
                          placeholder={btn.inputPrompt}
                          value={inputValue}
                          onChange={(e) => setInputValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleInputSubmit(btn)
                            else if (e.key === 'Escape') {
                              setActiveInput(null)
                              setInputValue('')
                            }
                          }}
                          onBlur={() => setTimeout(() => setActiveInput(null), 150)}
                          autoFocus
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* 反馈 */}
            {feedback && (
              <div className={`rp-feedback${feedback.success ? ' success' : ' error'}`}>
                <i className={`ri-${feedback.success ? 'check' : 'error-warning'}-line`} />
                <span>{feedback.message}</span>
              </div>
            )}

            {/* 任务队列 */}
            {pendingCount > 0 && (
              <div className="rp-tasks">
                <button className="rp-tasks-header" onClick={toggleExpanded}>
                  <span>任务队列 ({tasks.length})</span>
                  <i className={`ri-arrow-${expanded ? 'down' : 'up'}-s-line`} />
                </button>
                {expanded &&
                  tasks.slice(0, 5).map((t) => (
                    <div key={t.id} className={`rp-task-item ${t.status}`}>
                      <i
                        className={
                          t.status === 'running'
                            ? 'ri-loader-4-line ri-spin'
                            : t.status === 'success'
                              ? 'ri-check-line'
                              : 'ri-close-circle-line'
                        }
                      />
                      <span className="rp-task-title">{t.title}</span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}

        {/* ════════════════════════════════════ 记忆 Tab ════════════════════════════════════ */}
        {tab === 'bookmarks' && (
          <div className="right-panel-section right-panel-section--full">
            <BookmarkPanel />
          </div>
        )}

        {/* ════════════════════════════════════ 记忆 Tab ════════════════════════════════════ */}
        {tab === 'memory' && (
          <div className="right-panel-section">
            {memData && memData.cards.length > 0 ? (
              <div className="rp-mem-list">
                {memData.cards.slice(0, 10).map((card) => (
                  <div key={card.id} className="rp-mem-card">
                    <div className="rp-mem-card-top">
                      <span className="rp-mem-type">{card.type || '未知'}</span>
                      <span className="rp-mem-tier" style={{ color: TIER_COLORS[card.tier] || '#888' }}>
                        {TIER_LABELS[card.tier] || card.tier || '—'}
                      </span>
                      {card.isPinned && <i className="ri-pushpin-2-fill rp-mem-pinned" />}
                      <span className="rp-mem-conf">{Math.round((card.confidence || 0) * 100)}%</span>
                    </div>
                    <div className="rp-mem-content" title={card.content}>
                      {(card.content || '').length > 100 ? (card.content || '').slice(0, 97) + '...' : card.content || ''}
                    </div>
                    {card.topics && card.topics.length > 0 && (
                      <div className="rp-mem-topics">
                        {card.topics.slice(0, 3).map((t, i) => (
                          <span key={i} className="rp-mem-topic">
                            #{t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="rp-mem-empty">
                <i className="ri-brain-line rp-mem-empty-icon" />
                <p>{memData?.hasData === false ? '暂无记忆数据' : '等待数据推送…'}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}
