import { useState, useCallback } from 'react'
import { useDesktopToolbarStore } from '../store/desktopToolbarStore'
import { useActivityOpacity } from '../hooks/useActivityOpacity'
import type { DesktopTask } from '../store/desktopToolbarStore'

// =============================================================================
// 工具图标配置
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
// DesktopToolbar 组件
// =============================================================================

export function DesktopToolbar() {
  const { tasks, feedback, visible, expanded, addTask, updateTask, showFeedback, toggleVisible, toggleExpanded } = useDesktopToolbarStore()

  const { opacity } = useActivityOpacity({ idleThresholdMs: 30_000, minOpacity: 0.15, maxOpacity: 1.0 })

  const [activeInput, setActiveInput] = useState<string | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [executingTool, setExecutingTool] = useState<string | null>(null)

  const pendingCount = tasks.filter((t) => t.status === 'pending' || t.status === 'running').length

  // ── 执行工具 ──
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
        const result = await window.electronAPI.invokeDesktopTool(btn.tool, args)
        const success = !result?.error && result?.success !== false

        // 契约是 { success, result?, error? }，没有 message 字段 —— 原先读 result.message
        // 恒为 undefined，反馈文案永远退化成 '完成'/'失败'。
        updateTask(taskId, {
          status: success ? 'success' : 'error',
          result: result?.result || '',
          error: result?.error,
        })

        showFeedback({
          tool: btn.id,
          label: btn.label,
          success,
          message: result?.result || result?.error || (success ? '完成' : '失败'),
          timestamp: Date.now(),
        })
      } catch (err: any) {
        updateTask(taskId, {
          status: 'error',
          error: String(err),
        })

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

  // ── 处理工具按钮点击 ──
  const handleToolClick = useCallback(
    (btn: ToolButton) => {
      if (btn.inputPrompt) {
        // 需要输入参数 → 显示输入框
        if (activeInput === btn.id) {
          // 再次点击 → 执行
          if (inputValue.trim()) {
            const args = { ...btn.defaultArgs, [btn.inputField]: inputValue.trim() }
            invokeTool(btn, args)
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

  // ── 处理输入框提交 ──
  const handleInputSubmit = useCallback(
    (btn: ToolButton) => {
      if (inputValue.trim()) {
        const args = { ...btn.defaultArgs, [btn.inputField]: inputValue.trim() }
        invokeTool(btn, args)
        setInputValue('')
        setActiveInput(null)
      }
    },
    [inputValue, invokeTool],
  )

  // ── 处理输入框按键 ──
  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent, btn: ToolButton) => {
      if (e.key === 'Enter') {
        handleInputSubmit(btn)
      } else if (e.key === 'Escape') {
        setActiveInput(null)
        setInputValue('')
      }
    },
    [handleInputSubmit],
  )

  // ── 点击其他区域关闭输入 ──
  const handleBlur = useCallback(() => {
    // 延迟关闭以避免按钮点击冲突
    setTimeout(() => {
      setActiveInput(null)
      setInputValue('')
    }, 150)
  }, [])

  const overlayStyle = { opacity, transition: 'opacity 0.8s ease' }

  if (!visible) {
    return (
      <div className="desktop-toolbar desktop-toolbar-collapsed" style={overlayStyle}>
        <button className="dt-toggle-btn dt-toggle-show" onClick={toggleVisible} title="显示工具栏">
          <i className="ri-menu-line" />
        </button>
      </div>
    )
  }

  return (
    <div className="desktop-toolbar" style={overlayStyle}>
      {/* ── 工具按钮组 ── */}
      <div className="dt-buttons">
        {TOOL_BUTTONS.map((btn) => {
          const isActive = activeInput === btn.id
          const isExecuting = executingTool === btn.id

          return (
            <div key={btn.id} className="dt-btn-wrapper">
              <button
                className={`dt-tool-btn${isActive ? ' active' : ''}${isExecuting ? ' executing' : ''}`}
                onClick={() => handleToolClick(btn)}
                title={btn.label}
                disabled={isExecuting}
              >
                <i className={`${btn.icon}${isExecuting ? ' ri-spin' : ''}`} />
                <span className="dt-btn-label">{btn.label}</span>
              </button>

              {/* ── 内联输入 ── */}
              {isActive && (
                <div className="dt-inline-input">
                  <input
                    type="text"
                    className="dt-input"
                    placeholder={btn.inputPrompt}
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={(e) => handleInputKeyDown(e, btn)}
                    onBlur={handleBlur}
                    autoFocus
                  />
                  <button className="dt-input-submit" onMouseDown={() => handleInputSubmit(btn)}>
                    <i className="ri-arrow-right-line" />
                  </button>
                </div>
              )}
            </div>
          )
        })}

        {/* ── 任务计数徽章 ── */}
        {pendingCount > 0 && (
          <button className="dt-task-badge" onClick={toggleExpanded} title="查看任务队列">
            <span className="dt-badge-count">{pendingCount}</span>
            <i className={`ri-arrow-${expanded ? 'down' : 'up'}-s-line`} />
          </button>
        )}
      </div>

      {/* ── 反馈提示 ── */}
      {feedback && (
        <div className={`dt-feedback${feedback.success ? ' success' : ' error'}`}>
          <i className={`ri-${feedback.success ? 'check' : 'error-warning'}-line`} />
          <span className="dt-feedback-text">{feedback.message}</span>
        </div>
      )}

      {/* ── 展开的任务队列 ── */}
      {expanded && tasks.length > 0 && (
        <div className="dt-task-queue">
          <div className="dt-queue-header">
            <span>任务队列</span>
            <span className="dt-queue-count">{tasks.length}</span>
          </div>
          <div className="dt-queue-list">
            {tasks.slice(0, 10).map((task) => (
              <QueueItem key={task.id} task={task} />
            ))}
          </div>
        </div>
      )}

      {/* ── 折叠按钮 ── */}
      <button className="dt-toggle-btn dt-toggle-hide" onClick={toggleVisible} title="隐藏工具栏">
        <i className="ri-close-line" />
      </button>
    </div>
  )
}

// =============================================================================
// 队列项子组件
// =============================================================================

function QueueItem({ task }: { task: DesktopTask }) {
  const icon =
    task.status === 'running'
      ? 'ri-loader-4-line ri-spin'
      : task.status === 'success'
        ? 'ri-check-line'
        : task.status === 'error'
          ? 'ri-close-circle-line'
          : 'ri-time-line'

  const className = task.status === 'error' ? 'dt-queue-item error' : task.status === 'success' ? 'dt-queue-item success' : 'dt-queue-item'

  return (
    <div className={className}>
      <i className={icon} />
      <span className="dt-queue-title">{task.title}</span>
      {task.error && <span className="dt-queue-error">{task.error}</span>}
      {task.result && task.status === 'success' && <span className="dt-queue-result">{task.result}</span>}
    </div>
  )
}
