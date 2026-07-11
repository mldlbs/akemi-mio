import { useState, useEffect, useCallback, useRef } from 'react'
import { useDesktopToolbarStore, type DesktopTask } from '../store/desktopToolbarStore'
import { useActivityOpacity } from '../hooks/useActivityOpacity'

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
  recentChanges?: Array<{ type: string; filePath: string }>
}

// =============================================================================
// 工具按钮配置
// =============================================================================

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
    inputPrompt: '输入应用名（如 vscode, chrome, wechat）',
    inputField: 'appName',
  },
]

// =============================================================================
// 阶段映射
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
  collecting: 'var(--accent-slot)',
  analyzing: 'var(--accent-slot)',
  fixing: 'var(--accent)',
  verifying: 'var(--accent-soft)',
  cooldown: '#f59e0b',
  error: '#ef4444',
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

const TIER_LABELS: Record<string, string> = {
  permanent: '永久',
  semi: '半永久',
  ephemeral: '临时',
}

const TIER_COLORS: Record<string, string> = {
  permanent: '#f59e0b',
  semi: '#60a5fa',
  ephemeral: '#888',
}

type DockTab = 'tools' | 'evolution' | 'monitor' | 'memory'

// =============================================================================
// SystemDock 组件
// =============================================================================

export function SystemDock() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<DockTab>('tools')
  const { opacity } = useActivityOpacity({ idleThresholdMs: 30_000, minOpacity: 0.15, maxOpacity: 1.0 })

  // ── 工具状态 ──
  const { tasks, feedback, expanded, addTask, updateTask, showFeedback, toggleExpanded } = useDesktopToolbarStore()
  const [activeInput, setActiveInput] = useState<string | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [executingTool, setExecutingTool] = useState<string | null>(null)
  const pendingCount = tasks.filter((t) => t.status === 'pending' || t.status === 'running').length

  // ── 合并 IPC 订阅：单次 setState 批量更新 ──
  const [evoData, setEvoData] = useState<EvoDashData | null>(null)
  const [monData, setMonData] = useState<MonitoringData | null>(null)
  const [memData, setMemData] = useState<MemoryContextPayload | null>(null)
  const [evoLocked, setEvoLocked] = useState(false)

  // 使用 requestAnimationFrame 合并同一帧内的多次 IPC 更新
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
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(flushBatch)
    }
  }, [flushBatch])

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
    return () => {
      unsub1?.()
      unsub2?.()
      unsub3?.()
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [scheduleBatch])

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
        updateTask(taskId, {
          status: success ? 'success' : 'error',
          result: result?.result || result?.message || '',
          error: result?.error,
        })
        showFeedback({
          tool: btn.id,
          label: btn.label,
          success,
          message: result?.result || result?.message || result?.error || (success ? '完成' : '失败'),
          timestamp: Date.now(),
        })
      } catch (err: any) {
        updateTask(taskId, { status: 'error', error: String(err) })
        showFeedback({
          tool: btn.id,
          label: btn.label,
          success: false,
          message: `错误: ${err.message || String(err)}`,
          timestamp: Date.now(),
        })
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
          if (inputValue.trim()) {
            invokeTool(btn, { ...btn.defaultArgs, [btn.inputField]: inputValue.trim() })
            setInputValue('')
            setActiveInput(null)
          }
        } else {
          setActiveInput(btn.id)
          setInputValue('')
        }
      } else {
        invokeTool(btn, btn.defaultArgs)
      }
    },
    [activeInput, inputValue, invokeTool],
  )

  const handleInputSubmit = useCallback(
    (btn: ToolButton) => {
      if (inputValue.trim()) {
        invokeTool(btn, { ...btn.defaultArgs, [btn.inputField]: inputValue.trim() })
        setInputValue('')
        setActiveInput(null)
      }
    },
    [inputValue, invokeTool],
  )

  const handleLockToggle = useCallback(async (locked: boolean) => {
    try {
      const result = await (window as any).electronAPI.setEvoLock(locked)
      if (result.success) setEvoLocked(result.locked)
    } catch {}
  }, [])

  const stage = evoData?.stage || 'idle'
  const stageColor = STAGE_COLORS[stage] || 'var(--text-muted)'
  const stageLabel = STAGE_LABELS[stage] || stage
  const hasEvolutionActivity = stage !== 'idle'
  const dotColor = hasEvolutionActivity
    ? stageColor
    : monData?.evolution && monData.evolution.stage !== 'idle'
      ? '#60a5fa'
      : 'var(--text-muted)'

  const dockOverlayStyle: React.CSSProperties = {
    opacity,
    transition: 'opacity 0.8s ease',
  }

  return (
    <div className="system-dock" style={dockOverlayStyle}>
      {/* ── 折叠态 ── */}
      {!open ? (
        <button className="sd-collapsed-btn" onClick={() => setOpen(true)} title="打开系统面板">
          <span className="sd-dot" style={{ background: dotColor }} />
          {hasEvolutionActivity && <span className="sd-collapsed-label">{stageLabel}</span>}
        </button>
      ) : (
        <div className="sd-card">
          {/* ── 头部 ── */}
          <div className="sd-header">
            <div className="sd-tabs">
              <button className={`sd-tab${tab === 'tools' ? ' active' : ''}`} onClick={() => setTab('tools')} title="工具">
                <i className="ri-tools-line" />
              </button>
              <button className={`sd-tab${tab === 'evolution' ? ' active' : ''}`} onClick={() => setTab('evolution')} title="进化">
                <i className="ri-robot-2-line" />
              </button>
              <button className={`sd-tab${tab === 'monitor' ? ' active' : ''}`} onClick={() => setTab('monitor')} title="监控">
                <i className="ri-dashboard-3-line" />
              </button>
              <button className={`sd-tab${tab === 'memory' ? ' active' : ''}`} onClick={() => setTab('memory')} title="记忆">
                <i className="ri-brain-line" />
              </button>
            </div>
            <button className="sd-close" onClick={() => setOpen(false)} title="折叠">
              <i className="ri-arrow-down-s-line" />
            </button>
          </div>

          {/* ── 工具 Tab ── */}
          {tab === 'tools' && (
            <div className="sd-tab-content">
              <div className="sd-tools">
                {TOOL_BUTTONS.map((btn) => {
                  const isActive = activeInput === btn.id
                  const isExec = executingTool === btn.id
                  return (
                    <div key={btn.id} className="sd-tool-btn-wrapper">
                      <button
                        className={`sd-tool-btn${isActive ? ' active' : ''}${isExec ? ' executing' : ''}`}
                        onClick={() => handleToolClick(btn)}
                        title={btn.label}
                        disabled={isExec}
                      >
                        <i className={`${btn.icon}${isExec ? ' ri-spin' : ''}`} />
                        <span className="sd-tool-label">{btn.label}</span>
                      </button>
                      {isActive && (
                        <div className="sd-tool-input">
                          <input
                            type="text"
                            className="sd-input"
                            placeholder={btn.inputPrompt}
                            value={inputValue}
                            onChange={(e) => setInputValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleInputSubmit(btn)
                              else if (e.key === 'Escape') setActiveInput(null)
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
                <div className={`sd-feedback${feedback.success ? ' success' : ' error'}`}>
                  <span>{feedback.message}</span>
                </div>
              )}

              {/* 任务队列 */}
              {pendingCount > 0 && (
                <div className="sd-tasks">
                  <button className="sd-tasks-header" onClick={toggleExpanded}>
                    <span>任务队列 ({tasks.length})</span>
                    <i className={`ri-arrow-${expanded ? 'down' : 'up'}-s-line`} />
                  </button>
                  {expanded &&
                    tasks.slice(0, 5).map((t) => (
                      <div key={t.id} className={`sd-task-item ${t.status}`}>
                        <i
                          className={
                            t.status === 'running'
                              ? 'ri-loader-4-line ri-spin'
                              : t.status === 'success'
                                ? 'ri-check-line'
                                : t.status === 'error'
                                  ? 'ri-close-circle-line'
                                  : 'ri-time-line'
                          }
                        />
                        <span className="sd-task-title">{t.title}</span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}

          {/* ── 进化 Tab ── */}
          {tab === 'evolution' && (
            <div className="sd-tab-content">
              {evoData ? (
                <>
                  <div className="sd-evo-stage">
                    <span className="sd-evo-badge" style={{ background: stageColor }}>
                      {stageLabel}
                    </span>
                    <span className="sd-evo-mode">{evoData.safetyMode === 'review' ? '审查模式' : '自动'}</span>
                  </div>
                  <div className="sd-evo-progress">
                    <div className="sd-evo-track">
                      <div
                        className="sd-evo-fill"
                        style={{
                          width: stage === 'analyzing' || stage === 'fixing' ? '40%' : `${Math.max(0, Math.min(100, evoData.progress))}%`,
                          background: stageColor,
                        }}
                      />
                    </div>
                  </div>
                  {evoData.summary && <p className="sd-evo-summary">{evoData.summary}</p>}
                  <div className="sd-evo-stats">
                    {evoData.fixedCount > 0 && (
                      <span className="sd-stat good">
                        <i className="ri-check-line" /> {evoData.fixedCount} 修复
                      </span>
                    )}
                    {evoData.errorCount > 0 && (
                      <span className="sd-stat bad">
                        <i className="ri-error-warning-line" /> {evoData.errorCount} 错误
                      </span>
                    )}
                    {evoData.queueSize > 0 && (
                      <span className="sd-stat queue">
                        <i className="ri-stack-line" /> {evoData.queueSize} 待
                      </span>
                    )}
                    {evoData.consecutiveFailures > 0 && (
                      <span className="sd-stat bad">
                        <i className="ri-close-circle-line" /> 连续 {evoData.consecutiveFailures} 次失败
                      </span>
                    )}
                  </div>
                  <div className="sd-evo-footer">
                    <span className="sd-evo-time">{evoData.lastRunAt ? formatTimeAgo(evoData.lastRunAt) : '—'}</span>
                  </div>
                </>
              ) : (
                <p className="sd-empty">暂无进化数据</p>
              )}
            </div>
          )}

          {/* ── 监控 Tab ── */}
          {tab === 'monitor' && (
            <div className="sd-tab-content">
              {/* 锁定开关 */}
              <div className="sd-mon-header">
                <span className="sd-mon-title">系统状态</span>
                <button
                  className={`sd-lock-btn${evoLocked ? ' locked' : ''}`}
                  onClick={() => handleLockToggle(!evoLocked)}
                  title={evoLocked ? '已锁定' : '未锁定'}
                >
                  <i className={`ri-lock-${evoLocked ? '' : 'un'}lock-line`} />
                </button>
              </div>

              {/* 进化状态 */}
              {monData?.evolution && monData.evolution.stage !== 'idle' && (
                <div className="sd-mon-section">
                  <span className="sd-mon-label">进化</span>
                  <div className="sd-mon-row">
                    <div className="sd-mon-bar">
                      <div
                        className="sd-mon-fill"
                        style={{
                          width: `${monData.evolution.progress}%`,
                          background: STAGE_COLORS[monData.evolution.stage] || 'var(--accent)',
                        }}
                      />
                    </div>
                    <span className="sd-mon-pct">{monData.evolution.progress}%</span>
                  </div>
                </div>
              )}

              {/* 计划 */}
              {monData?.plan?.hasActivePlan && (
                <div className="sd-mon-section">
                  <span className="sd-mon-label">{monData.plan.title}</span>
                  <div className="sd-mon-row">
                    <div className="sd-mon-bar">
                      <div className="sd-mon-fill plan" style={{ width: `${monData.plan.progress}%` }} />
                    </div>
                    <span className="sd-mon-pct">{monData.plan.progress}%</span>
                  </div>
                  {monData.plan.current && <span className="sd-mon-current">{monData.plan.current}</span>}
                </div>
              )}

              {/* 资源 */}
              {monData?.resources && (
                <div className="sd-mon-section">
                  {monData.resources.cpu !== undefined && (
                    <div className="sd-mon-row">
                      <span className="sd-mon-label">CPU</span>
                      <div className="sd-mon-bar">
                        <div className="sd-mon-fill" style={{ width: `${monData.resources.cpu}%` }} />
                      </div>
                      <span className="sd-mon-val">{monData.resources.cpu}%</span>
                    </div>
                  )}
                  {monData.resources.memory !== undefined && (
                    <div className="sd-mon-row">
                      <span className="sd-mon-label">内存</span>
                      <div className="sd-mon-bar">
                        <div className="sd-mon-fill mem" style={{ width: `${monData.resources.memory}%` }} />
                      </div>
                      <span className="sd-mon-val">{monData.resources.memory}%</span>
                    </div>
                  )}
                </div>
              )}

              {/* 最近变更 */}
              {monData?.recentChanges && monData.recentChanges.length > 0 && (
                <div className="sd-mon-section">
                  <span className="sd-mon-label">最近变更</span>
                  {monData.recentChanges.slice(0, 3).map((c, i) => (
                    <div key={i} className="sd-change-item">
                      <span className={`sd-change-type ${c.type}`}>{c.type === 'new' ? '+' : c.type === 'deleted' ? '-' : '~'}</span>
                      <span className="sd-change-file">{c.filePath.split('/').pop() || c.filePath}</span>
                    </div>
                  ))}
                </div>
              )}

              {!monData && <p className="sd-empty">暂无监控数据</p>}
            </div>
          )}

          {/* ── 记忆 Tab ── */}
          {tab === 'memory' && (
            <div className="sd-tab-content">
              {memData && memData.cards.length > 0 ? (
                <div className="sd-mem-list">
                  {memData.cards.slice(0, 10).map((card) => (
                    <div key={card.id} className="sd-mem-card">
                      <div className="sd-mem-card-top">
                        <span className="sd-mem-type">{card.type || '未知'}</span>
                        <span className="sd-mem-tier" style={{ color: TIER_COLORS[card.tier] || '#888' }}>
                          {TIER_LABELS[card.tier] || card.tier || '—'}
                        </span>
                        {card.isPinned && <span className="sd-mem-pinned">📌</span>}
                      </div>
                      <div className="sd-mem-content" title={card.content}>
                        {(card.content || '').length > 80 ? (card.content || '').slice(0, 77) + '...' : card.content || ''}
                      </div>
                      <div className="sd-mem-card-bottom">
                        <span className="sd-mem-conf">置信 {Math.round((card.confidence || 0) * 100)}%</span>
                        {card.topics && card.topics.length > 0 && (
                          <span className="sd-mem-topics">
                            {card.topics.slice(0, 3).map((t, i) => (
                              <span key={i} className="sd-mem-topic">
                                #{t}
                              </span>
                            ))}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="sd-empty">{memData?.hasData === false ? '暂无记忆' : '等待数据…'}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// =============================================================================
// 工具函数
// =============================================================================

function formatTimeAgo(ts: number | null): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}
