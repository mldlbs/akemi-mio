import { useState, useEffect, useCallback, useRef } from 'react'

// =============================================================================
// 类型
// =============================================================================

export interface TopActionItem {
  actionId: string
  category: string
  label: string
  icon: string
  trigger: string
  toolName?: string
  frequency: number
  lastUsedAt: number
}

interface TopActionsPayload {
  actions: TopActionItem[]
  timestamp: number
}

// =============================================================================
// 预设动作图标映射（兜底）
// =============================================================================

const ACTION_ICON_FALLBACK: Record<string, string> = {
  'voice:start': 'ri-mic-line',
  'voice:ode_solve': 'ri-function-line',
  'tool:desktop_quick_note': 'ri-sticky-note-line',
  'tool:desktop_todo_add': 'ri-task-line',
  'tool:desktop_app_launch': 'ri-apps-2-line',
}

const ACTION_LABEL_FALLBACK: Record<string, string> = {
  'voice:start': '语音输入',
}

// =============================================================================
// BehaviorQuickActions — 行为感知桌面快捷入口
// =============================================================================
//
// 在壁纸 Overlay 右下角以浮动按钮形式展示 Top-2 高频操作，
// 点击后触发对应的 Agent 动作。
//
// 行为:
//   - 获取高频动作列表并订阅实时更新
//   - 无高频动作时隐藏自身
//   - 鼠标穿透：自身设置为 auto，子按钮可交互
//   - 专注模式 / 交互模式下隐藏
//
// 触发方式:
//   - voice:start   → 发送语音启动消息
//   - tool:invoke   → 调用桌面工具
//
// =============================================================================

export function BehaviorQuickActions() {
  const [actions, setActions] = useState<TopActionItem[]>([])
  const [loading, setLoading] = useState(true)
  const [executingId, setExecutingId] = useState<string | null>(null)
  const mountedRef = useRef(true)

  // ── 初始加载 ──
  useEffect(() => {
    mountedRef.current = true
    loadTopActions()

    // 订阅实时更新
    const unsub = window.electronAPI.onBehaviorTopActions((payload: TopActionsPayload) => {
      if (mountedRef.current) {
        setActions(payload.actions || [])
        setLoading(false)
      }
    })

    return () => {
      mountedRef.current = false
      unsub?.()
    }
  }, [])

  // ── 获取 Top-N ──
  const loadTopActions = useCallback(async () => {
    try {
      const result = await window.electronAPI.getBehaviorTopActions(2)
      if (mountedRef.current && result.success) {
        setActions(result.actions || [])
      }
    } catch {
      // 静默降级
    } finally {
      if (mountedRef.current) {
        setLoading(false)
      }
    }
  }, [])

  // ── 执行动作 ──
  const handleActionClick = useCallback(
    async (item: TopActionItem) => {
      if (executingId) return
      setExecutingId(item.actionId)

      try {
        if (item.trigger === 'voice:start') {
          // 语音动作 → 通过 chat 发送语音启动消息
          await window.electronAPI.chat('🎤 启动语音模式', 'wp_qa_' + Date.now())
        } else if (item.trigger === 'tool:invoke' && item.toolName) {
          // 工具动作 → 调用桌面工具
          await window.electronAPI.invokeDesktopTool(item.toolName, {})
        }
      } catch {
        // 静默失败
      } finally {
        if (mountedRef.current) {
          setExecutingId(null)
        }
      }
    },
    [executingId],
  )

  // ── 空/加载/隐藏状态 ──
  if (loading) return null
  if (actions.length === 0) return null

  // ── 从 item 获取图标（优先使用 item 提供的，兜底使用 fallback 映射） ──
  const getIcon = (item: TopActionItem): string => {
    if (item.icon && item.icon !== 'ri-tools-line') return item.icon
    return ACTION_ICON_FALLBACK[item.actionId] || 'ri-flashlight-line'
  }

  const getLabel = (item: TopActionItem): string => {
    if (item.label && item.label !== item.actionId) return item.label
    return ACTION_LABEL_FALLBACK[item.actionId] || item.actionId.replace(/^tool:/, '').replace(/_/g, ' ')
  }

  return (
    <div className="wp-quick-actions" role="toolbar" aria-label="快捷操作">
      {actions.map((item) => {
        const isExecuting = executingId === item.actionId

        return (
          <button
            key={item.actionId}
            className={`wp-qa-btn${isExecuting ? ' wp-qa-executing' : ''}`}
            onClick={() => handleActionClick(item)}
            disabled={isExecuting}
            title={`${getLabel(item)} (使用 ${item.frequency} 次)`}
            aria-label={getLabel(item)}
          >
            <i className={`${getIcon(item)}${isExecuting ? ' ri-spin' : ''}`} />
            <span className="wp-qa-label">{getLabel(item)}</span>
          </button>
        )
      })}
    </div>
  )
}
