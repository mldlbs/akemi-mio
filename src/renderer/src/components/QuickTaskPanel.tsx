/**
 * QuickTaskPanel — 快捷任务推荐面板
 *
 * 在主界面显示基于用户行为模式自动生成的快捷任务推荐。
 * 用户可一键执行、关闭、稍后提醒或编辑任务步骤。
 *
 * 集成方式：
 * - 可作为独立面板插入 Sidebar、RightPanel 或 SystemDock
 * - 通过 useQuickTasks hook 连接主进程的 QuickTaskService
 *
 * 行为：
 * - 有活跃推荐时显示摘要气泡
 * - 展开后显示推荐列表，按置信度排序
 * - 每个推荐项显示标题、步骤列表、执行/关闭/编辑按钮
 * - 无推荐时显示空状态提示
 */

import { useState, useCallback } from 'react'
import { useQuickTasks } from '../hooks/useQuickTasks'
import type { QuickTask } from '../store/quickTaskStore'

// =============================================================================
// QuickTaskCard — 单个任务卡片
// =============================================================================

interface QuickTaskCardProps {
  task: QuickTask
  onExecute: (id: string) => void
  onDismiss: (id: string) => void
  onEdit: (task: QuickTask) => void
}

function QuickTaskCard({ task, onExecute, onDismiss, onEdit }: QuickTaskCardProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className={`qt-card qt-level-${task.recommendationLevel}`}>
      {/* ── 头部 ── */}
      <div className="qt-card-header" onClick={() => setExpanded(!expanded)}>
        <div className="qt-card-title-row">
          <span className="qt-card-title">{task.title}</span>
          <span className="qt-card-badge">{task.frequency}次</span>
        </div>
        <span className="qt-card-confidence">{Math.round(task.confidence * 100)}%</span>
      </div>

      {/* ── 步骤预览（折叠/展开） ── */}
      {expanded && (
        <div className="qt-card-steps">
          {task.steps.map((step, i) => (
            <div key={i} className="qt-step-row">
              <span className="qt-step-index">{i + 1}</span>
              <span className="qt-step-label">{step.label}</span>
              <code className="qt-step-tool">{step.tool}</code>
            </div>
          ))}
          <p className="qt-card-desc">{task.description}</p>
        </div>
      )}

      {/* ── 操作按钮 ── */}
      <div className="qt-card-actions">
        <button className="qt-btn qt-btn-execute" onClick={() => onExecute(task.id)} title="执行此快捷任务">
          ▶ 执行
        </button>
        {task.steps.length > 0 && (
          <button className="qt-btn qt-btn-edit" onClick={() => onEdit(task)} title="编辑任务步骤">
            ✎ 编辑
          </button>
        )}
        <button className="qt-btn qt-btn-dismiss" onClick={() => onDismiss(task.id)} title="不再推荐此任务">
          ✕ 关闭
        </button>
      </div>
    </div>
  )
}

// =============================================================================
// QuickTaskPanel
// =============================================================================

interface QuickTaskPanelProps {
  /** 是否默认展开（用于侧边栏等场景，默认 true） */
  defaultExpanded?: boolean
  /** 最大显示的推荐数（默认 5） */
  maxDisplay?: number
}

export function QuickTaskPanel({ defaultExpanded = true, maxDisplay = 5 }: QuickTaskPanelProps) {
  const { activeRecommendations, hasUnreadRecommendation, loading, executeTask, dismissTask, snoozeTask, editTask, markRead, analyzeNow } =
    useQuickTasks()

  const [panelExpanded, setPanelExpanded] = useState(defaultExpanded)
  const [editingTask, setEditingTask] = useState<QuickTask | null>(null)
  const [editSteps, setEditSteps] = useState<string>('')
  const [actionFeedback, setActionFeedback] = useState<string | null>(null)

  const tasks = activeRecommendations.slice(0, maxDisplay)

  // ── 执行任务 ──
  const handleExecute = useCallback(
    async (taskId: string) => {
      const result = await executeTask(taskId)
      if (result?.success) {
        setActionFeedback('✅ 任务已执行')
      } else {
        setActionFeedback(`❌ ${result?.error || '执行失败'}`)
      }
      setTimeout(() => setActionFeedback(null), 3000)
    },
    [executeTask],
  )

  // ── 关闭任务 ──
  const handleDismiss = useCallback(
    async (taskId: string) => {
      await dismissTask(taskId)
      setActionFeedback('已关闭推荐')
      setTimeout(() => setActionFeedback(null), 2000)
    },
    [dismissTask],
  )

  // ── 编辑任务 ──
  const handleStartEdit = useCallback((task: QuickTask) => {
    setEditingTask(task)
    setEditSteps(task.steps.map((s) => `${s.tool}: ${s.label}`).join('\n'))
  }, [])

  const handleSaveEdit = useCallback(async () => {
    if (!editingTask) return
    // 解析用户编辑的步骤
    const lines = editSteps.split('\n').filter((l) => l.trim())
    const steps = lines.map((line) => {
      const [tool, ...labelParts] = line.split(':')
      return {
        tool: tool.trim(),
        label: labelParts.join(':').trim() || tool.trim(),
      }
    })
    const result = await editTask(editingTask.id, steps)
    if (result?.success) {
      setActionFeedback('✅ 任务已更新')
    } else {
      setActionFeedback(`❌ ${result?.error || '编辑失败'}`)
    }
    setEditingTask(null)
    setTimeout(() => setActionFeedback(null), 3000)
  }, [editingTask, editSteps, editTask])

  // ── 展开/收起 ──
  const handleToggle = useCallback(() => {
    setPanelExpanded(!panelExpanded)
    if (!panelExpanded) markRead()
  }, [panelExpanded, markRead])

  return (
    <div className="qt-panel">
      {/* ── 面板头部 ── */}
      <div className="qt-panel-header" onClick={handleToggle}>
        <span className="qt-panel-title">
          快捷任务
          {hasUnreadRecommendation && <span className="qt-unread-dot" />}
        </span>
        <span className="qt-panel-count">{activeRecommendations.length}</span>
        <button
          className="qt-btn qt-btn-refresh"
          onClick={(e) => {
            e.stopPropagation()
            analyzeNow()
          }}
          title="立即分析行为模式"
          disabled={loading}
        >
          ↻
        </button>
      </div>

      {/* ── 反馈提示 ── */}
      {actionFeedback && <div className="qt-feedback">{actionFeedback}</div>}

      {/* ── 推荐列表 ── */}
      {panelExpanded && (
        <div className="qt-panel-body">
          {loading && tasks.length === 0 && <div className="qt-empty">分析行为模式中...</div>}

          {!loading && tasks.length === 0 && (
            <div className="qt-empty">
              <p>暂无快捷任务推荐</p>
              <p className="qt-empty-hint">持续使用后，Agent 会自动学习你的操作习惯</p>
            </div>
          )}

          {tasks.map((task) => (
            <QuickTaskCard key={task.id} task={task} onExecute={handleExecute} onDismiss={handleDismiss} onEdit={handleStartEdit} />
          ))}

          {activeRecommendations.length > maxDisplay && (
            <div className="qt-more-hint">还有 {activeRecommendations.length - maxDisplay} 个推荐...</div>
          )}
        </div>
      )}

      {/* ── 编辑弹窗（简易行内编辑） ── */}
      {editingTask && (
        <div className="qt-edit-overlay" onClick={() => setEditingTask(null)}>
          <div className="qt-edit-modal" onClick={(e) => e.stopPropagation()}>
            <h4>编辑快捷任务</h4>
            <p className="qt-edit-desc">
              每行一个步骤，格式：<code>工具名: 描述</code>
            </p>
            <textarea
              className="qt-edit-textarea"
              value={editSteps}
              onChange={(e) => setEditSteps(e.target.value)}
              rows={editingTask.steps.length + 2}
            />
            <div className="qt-edit-actions">
              <button className="qt-btn qt-btn-cancel" onClick={() => setEditingTask(null)}>
                取消
              </button>
              <button className="qt-btn qt-btn-execute" onClick={handleSaveEdit}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
