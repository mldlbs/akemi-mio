import { useEffect, useState, useCallback } from 'react'

// =============================================================================
// 类型定义
// =============================================================================

export interface ParamCombination {
  args: Record<string, any>
  frequency: number
  successRate: number
  rating: number
  lastUsed: number
  firstSeen: number
}

interface ToolParamSuggestionsProps {
  /** 工具名称 */
  toolName: string
  /** 是否启用（数据不足时自动隐藏） */
  enabled?: boolean
  /** 建议数量上限 */
  maxSuggestions?: number
  /** 用户采纳某个组合时的回调 */
  onAdopt?: (args: Record<string, any>) => void
  /** 用户调整的入口（无具体实现，仅通知父组件） */
  onAdjust?: (args: Record<string, any>) => void
}

// =============================================================================
// 工具函数
// =============================================================================

/** 格式化时间戳为相对时间 */
function relativeTime(ts: number): string {
  const delta = Date.now() - ts
  const hours = Math.floor(delta / 3600000)
  if (hours < 1) return '刚刚'
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}天前`
  return `${Math.floor(days / 30)}月前`
}

/** 截断参数值显示 */
function truncateValue(value: unknown, max = 50): string {
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value)
  if (str.length <= max) return str
  return str.slice(0, max) + '…'
}

/** 格式化评分百分比 */
function formatRating(rating: number): string {
  return (rating * 100).toFixed(0)
}

// =============================================================================
// 渲染辅助
// =============================================================================

/** 单个参数组合的显示条目 */
function CombinationItem({
  combo,
  onAdopt,
  onDismiss,
  onAdjust,
}: {
  combo: ParamCombination
  onAdopt: (args: Record<string, any>) => void
  onDismiss: (args: Record<string, any>) => void
  onAdjust: (args: Record<string, any>) => void
}) {
  const [feedbackGiven, setFeedbackGiven] = useState(false)

  // 提取有意义的参数（排除系统注入的 _ 前缀参数）
  const displayArgs = Object.entries(combo.args).filter(([key]) => !key.startsWith('_'))

  const handleAdopt = useCallback(() => {
    setFeedbackGiven(true)
    onAdopt(combo.args)
  }, [combo.args, onAdopt])

  const handleDismiss = useCallback(() => {
    setFeedbackGiven(true)
    onDismiss(combo.args)
  }, [combo.args, onDismiss])

  const handleAdjust = useCallback(() => {
    onAdjust(combo.args)
  }, [combo.args, onAdjust])

  return (
    <div className="tool-param-combo-item">
      {/* 参数展示 */}
      <div className="tool-param-combo-args">
        {displayArgs.slice(0, 4).map(([key, value]) => (
          <span key={key} className="tool-param-combo-arg">
            <span className="tool-param-combo-key">{key}</span>
            <span className="tool-param-combo-val">{truncateValue(value)}</span>
          </span>
        ))}
        {displayArgs.length > 4 && <span className="tool-param-combo-more">+{displayArgs.length - 4}</span>}
      </div>

      {/* 评分与元数据 */}
      <div className="tool-param-combo-meta">
        <span
          className={`tool-param-combo-rating ${combo.successRate >= 0.8 ? 'rating-high' : combo.successRate >= 0.5 ? 'rating-mid' : 'rating-low'}`}
        >
          {formatRating(combo.successRate)}% 成功率
        </span>
        <span className="tool-param-combo-freq">{combo.frequency}次</span>
        <span className="tool-param-combo-time">{relativeTime(combo.lastUsed)}</span>
      </div>

      {/* 操作按钮 */}
      {!feedbackGiven && (
        <div className="tool-param-combo-actions">
          <button className="tool-param-combo-btn tool-param-combo-adopt" onClick={handleAdopt} title="采纳此参数组合">
            <i className="ri-check-line" /> 采纳
          </button>
          <button className="tool-param-combo-btn tool-param-combo-adjust" onClick={handleAdjust} title="调整后使用">
            <i className="ri-pencil-line" />
          </button>
          <button className="tool-param-combo-btn tool-param-combo-dismiss" onClick={handleDismiss} title="不推荐此组合">
            <i className="ri-close-line" />
          </button>
        </div>
      )}

      {feedbackGiven && (
        <div className="tool-param-combo-feedback-done">
          <i className="ri-check-line" /> 已反馈
        </div>
      )}
    </div>
  )
}

// =============================================================================
// 主组件
// =============================================================================

/**
 * ToolParamSuggestions — 工具参数记忆智能默认值组件。
 *
 * 当工具被调用时，查询 Memory 中该工具最常用的成功参数组合，
 * 以建议列表形式展示，支持一键采纳 / 调整 / 反馈不推荐。
 */
export function ToolParamSuggestions({ toolName, enabled = true, maxSuggestions = 3, onAdopt, onAdjust }: ToolParamSuggestionsProps) {
  const [combinations, setCombinations] = useState<ParamCombination[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 查询后端参数组合建议
  useEffect(() => {
    if (!enabled || !toolName) return

    let cancelled = false
    setLoading(true)
    setError(null)

    window.electronAPI
      .getToolParamDefaults(toolName, maxSuggestions)
      .then((result) => {
        if (cancelled) return
        if (result.success && result.combinations.length > 0) {
          setCombinations(result.combinations)
        } else {
          setCombinations([])
        }
        setLoading(false)
      })
      .catch((err: Error) => {
        if (cancelled) return
        setError(String(err))
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [toolName, enabled, maxSuggestions])

  // 采纳回调：记录正面反馈 + 触发父组件回调
  const handleAdopt = useCallback(
    (args: Record<string, any>) => {
      window.electronAPI.recordToolParamFeedback(toolName, args, 0.8).catch(() => {})
      onAdopt?.(args)
    },
    [toolName, onAdopt],
  )

  // 不推荐回调：记录负面反馈
  const handleDismiss = useCallback(
    (args: Record<string, any>) => {
      window.electronAPI.recordToolParamFeedback(toolName, args, -0.5).catch(() => {})
    },
    [toolName],
  )

  // 调整回调
  const handleAdjust = useCallback(
    (args: Record<string, any>) => {
      onAdjust?.(args)
    },
    [onAdjust],
  )

  // 数据不足时不渲染
  if (!enabled || (!loading && combinations.length === 0 && !error)) {
    return null
  }

  return (
    <div className="tool-param-suggestions">
      <div className="tool-param-suggestions-header">
        <i className="ri-lightbulb-flash-line" />
        <span>记忆推荐参数组合</span>
        <span className="tool-param-suggestions-hint">基于历史成功调用</span>
      </div>

      {loading && (
        <div className="tool-param-suggestions-loading">
          <i className="ri-loader-4-line ri-spin" /> 加载建议中...
        </div>
      )}

      {error && (
        <div className="tool-param-suggestions-error">
          <i className="ri-alert-line" /> {error}
        </div>
      )}

      {!loading && combinations.length > 0 && (
        <div className="tool-param-combo-list">
          {combinations.map((combo, idx) => (
            <CombinationItem
              key={`${toolName}-combo-${idx}`}
              combo={combo}
              onAdopt={handleAdopt}
              onDismiss={handleDismiss}
              onAdjust={handleAdjust}
            />
          ))}
        </div>
      )}
    </div>
  )
}
