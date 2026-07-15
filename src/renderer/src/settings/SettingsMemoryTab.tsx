import { useState, useEffect, useCallback } from 'react'

// =============================================================================
// 类型定义
// =============================================================================

interface ParamValueStat {
  value: string
  count: number
  successCount: number
  failureCount: number
  successRate: number
}

interface ParamSuggestion {
  paramName: string
  topValues: ParamValueStat[]
  recommendedDefault: string | null
  confidence: number
  totalOccurrences: number
  lastUsed: number
}

interface ToolReport {
  toolName: string
  paramSuggestions: ParamSuggestion[]
  totalCalls: number
  successRate: number
  lastUsed: number
  hasEnoughData: boolean
}

interface OptimizerConfig {
  MIN_RECORDS_TO_ACTIVATE: number
  MIN_PARAM_OCCURRENCES: number
  MIN_SUCCESS_RATE: number
  MAX_SUGGESTIONS_PER_PARAM: number
  PRUNE_INTERVAL_MS: number
  LOW_EFFICIENCY_THRESHOLD: number
  enabled: boolean
}

// =============================================================================
// 工具函数
// =============================================================================

function formatDate(ts: number): string {
  if (!ts) return '-'
  const d = new Date(ts)
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

function formatSuccessRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

function formatConfidence(c: number): string {
  if (c >= 0.8) return '高'
  if (c >= 0.5) return '中'
  if (c >= 0.3) return '低'
  return '极低'
}

// =============================================================================
// SettingsMemoryTab 组件
// =============================================================================

export function SettingsMemoryTab() {
  // ── 状态 ──
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<{
    reports: ToolReport[]
    totalTools: number
    totalCalls: number
    overallSuccessRate: number
    activeTools: number
    isColdStart: boolean
  } | null>(null)
  const [optimizerStats, setOptimizerStats] = useState<{
    cacheSize: number
    lastAnalyzedAt: number
    lastPrunedAt: number
    pruneCount: number
  } | null>(null)
  const [config, setConfig] = useState<OptimizerConfig | null>(null)
  const [expandedTool, setExpandedTool] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [message, setMessage] = useState('')
  const [expandedParam, setExpandedParam] = useState<string | null>(null)

  // ── 数据加载 ──
  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [summaryRes, configRes] = await Promise.all([
        window.electronAPI.getToolOptimizerSummary(),
        window.electronAPI.getToolOptimizerConfig(),
      ])
      if (summaryRes.success) {
        setSummary(summaryRes.summary)
        setOptimizerStats(summaryRes.optimizerStats)
      } else {
        setError(summaryRes.error || '加载失败')
      }
      if (configRes.success) {
        setConfig(configRes.config)
      }
    } catch (err: any) {
      setError(err.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  // ── 操作处理 ──
  const handleToggleOptimizer = useCallback(async (enabled: boolean) => {
    if (!config) return
    try {
      const res = await window.electronAPI.setToolOptimizerConfig({ enabled })
      if (res.success) {
        setConfig({ ...config, enabled })
        setMessage(enabled ? '工具调用优化已启用' : '工具调用优化已禁用')
        setTimeout(() => setMessage(''), 2000)
      }
    } catch (err: any) {
      console.error('Failed to toggle optimizer:', err)
    }
  }, [config])

  const handleClearHistory = useCallback(async () => {
    if (!confirmClear) {
      setConfirmClear(true)
      return
    }
    try {
      const res = await window.electronAPI.clearToolCallHistory()
      if (res.success) {
        setMessage('已清空所有工具调用记录和优化缓存')
        setConfirmClear(false)
        setTimeout(() => setMessage(''), 2000)
        loadData()
      }
    } catch (err: any) {
      console.error('Failed to clear history:', err)
    }
  }, [confirmClear, loadData])

  const handleResetOptimizer = useCallback(async () => {
    try {
      const res = await window.electronAPI.clearToolOptimizer()
      if (res.success) {
        setMessage('优化器已重置')
        setTimeout(() => setMessage(''), 2000)
        loadData()
      }
    } catch (err: any) {
      console.error('Failed to reset optimizer:', err)
    }
  }, [loadData])

  // ── 冷启动提示 ──
  if (loading) {
    return (
      <div className="settings-section">
        <div className="settings-loading">加载中...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="settings-section">
        <div className="settings-error" style={{ color: '#e74c3c', fontSize: 13 }}>
          加载失败: {error}
          <button type="button" onClick={loadData} style={{ marginLeft: 8, cursor: 'pointer' }}>
            重试
          </button>
        </div>
      </div>
    )
  }

  const isColdStart = summary?.isColdStart ?? true

  return (
    <>
      <div className="settings-section">
        <span className="settings-section-title">工具调用优化</span>
        <span className="settings-help">
          系统会从工具调用历史中学习常用参数组合，在调用时自动推荐高成功率的默认值，
          减少重复输入，提升效率。需要至少 5 次调用记录后生效。
        </span>

        {message && (
          <div className="settings-message" style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0' }}>
            {message}
          </div>
        )}

        {/* 启用/禁用开关 */}
        <div className="settings-field">
          <span className="settings-label">自动优化</span>
          <div className="settings-toggle">
            <button
              type="button"
              className={`settings-toggle-btn${config?.enabled ? ' active' : ''}`}
              onClick={() => handleToggleOptimizer(true)}
            >
              启用
            </button>
            <button
              type="button"
              className={`settings-toggle-btn${!config?.enabled ? ' active' : ''}`}
              onClick={() => handleToggleOptimizer(false)}
            >
              禁用
            </button>
          </div>
          <span className="settings-help">
            {config?.enabled
              ? (isColdStart ? '已启用（冷启动中，数据不足 5 条）' : '已启用，正在根据历史数据自动优化参数推荐')
              : '已禁用，工具调用将使用默认参数'}
          </span>
        </div>
      </div>

      {/* ── 统计概览 ── */}
      <div className="settings-section">
        <span className="settings-section-title">统计概览</span>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: '8px 0' }}>
          <StatCard label="总调用次数" value={String(summary?.totalCalls ?? 0)} />
          <StatCard label="涉及工具" value={String(summary?.totalTools ?? 0)} />
          <StatCard label="活跃优化工具" value={String(summary?.activeTools ?? 0)} />
          <StatCard
            label="总体成功率"
            value={summary ? formatSuccessRate(summary.overallSuccessRate) : '-'}
          />
          <StatCard
            label="冷启动状态"
            value={isColdStart ? '进行中' : '已完成'}
            color={isColdStart ? '#f39c12' : '#2ecc71'}
          />
        </div>

        {optimizerStats && (
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
            缓存工具数: {optimizerStats.cacheSize} |
            上次分析: {formatDate(optimizerStats.lastAnalyzedAt)} |
            上次修剪: {formatDate(optimizerStats.lastPrunedAt)} |
            累计修剪: {optimizerStats.pruneCount} 次
          </div>
        )}
      </div>

      {/* ── 操作按钮 ── */}
      <div className="settings-section">
        <span className="settings-section-title">数据管理</span>
        <div style={{ display: 'flex', gap: 8, margin: '8px 0', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="settings-action-btn"
            onClick={loadData}
            style={{
              padding: '4px 12px',
              borderRadius: 6,
              border: '1px solid var(--border-color)',
              background: 'var(--bg-secondary)',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            刷新
          </button>
          <button
            type="button"
            className="settings-action-btn"
            onClick={handleResetOptimizer}
            style={{
              padding: '4px 12px',
              borderRadius: 6,
              border: '1px solid var(--border-color)',
              background: 'var(--bg-secondary)',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            重置优化器
          </button>
          <button
            type="button"
            className="settings-action-btn settings-action-danger"
            onClick={handleClearHistory}
            style={{
              padding: '4px 12px',
              borderRadius: 6,
              border: `1px solid ${confirmClear ? '#e74c3c' : 'var(--border-color)'}`,
              background: confirmClear ? '#e74c3c' : 'transparent',
              color: confirmClear ? '#fff' : '#e74c3c',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            {confirmClear ? '确认清空？' : '清空所有记录'}
          </button>
          {confirmClear && (
            <span
              onClick={() => setConfirmClear(false)}
              style={{ fontSize: 11, color: 'var(--text-secondary)', cursor: 'pointer', alignSelf: 'center' }}
            >
              取消
            </span>
          )}
        </div>
      </div>

      {/* ── 工具详情 ── */}
      <div className="settings-section">
        <span className="settings-section-title">工具参数优化详情</span>
        {summary && summary.reports.length > 0 ? (
          <div className="settings-tool-list" style={{ marginTop: 8 }}>
            {summary.reports.map((report) => (
              <ToolReportCard
                key={report.toolName}
                report={report}
                expanded={expandedTool === report.toolName}
                onToggle={() => setExpandedTool(expandedTool === report.toolName ? null : report.toolName)}
                expandedParam={expandedParam}
                onToggleParam={(paramName) => setExpandedParam(expandedParam === paramName ? null : paramName)}
              />
            ))}
          </div>
        ) : (
          <div style={{ padding: '16px 0', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
            {isColdStart
              ? '暂无数据，继续使用工具后将自动生成优化建议（需至少 5 次调用）'
              : '暂无优化建议'}
          </div>
        )}
      </div>
    </>
  )
}

// =============================================================================
// 统计卡片子组件
// =============================================================================

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div
      className="settings-stat-card"
      style={{
        flex: '1 0 100px',
        padding: '8px 12px',
        borderRadius: 8,
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-color)',
        minWidth: 90,
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 600, color: color || 'var(--text-primary)' }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
        {label}
      </div>
    </div>
  )
}

// =============================================================================
// 工具报告卡片子组件
// =============================================================================

function ToolReportCard({
  report,
  expanded,
  onToggle,
  expandedParam,
  onToggleParam,
}: {
  report: ToolReport
  expanded: boolean
  onToggle: () => void
  expandedParam: string | null
  onToggleParam: (paramName: string) => void
}) {
  const statusColor = report.hasEnoughData ? '#2ecc71' : '#f39c12'
  const statusText = report.hasEnoughData ? '活跃' : '数据不足'

  return (
    <div
      className="settings-tool-card"
      style={{
        marginBottom: 6,
        borderRadius: 8,
        border: '1px solid var(--border-color)',
        overflow: 'hidden',
      }}
    >
      <div
        className="settings-tool-header"
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          cursor: 'pointer',
          background: 'var(--bg-secondary)',
          userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 500, fontSize: 13 }}>{report.toolName}</span>
          <span
            style={{
              fontSize: 10,
              padding: '1px 6px',
              borderRadius: 8,
              background: statusColor + '22',
              color: statusColor,
              border: `1px solid ${statusColor}44`,
            }}
          >
            {statusText}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            {report.totalCalls} 次 | 成功率 {formatSuccessRate(report.successRate)}
          </span>
        </div>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)', transition: 'transform 0.2s', transform: expanded ? 'rotate(180deg)' : '' }}>
          ▼
        </span>
      </div>

      {expanded && (
        <div className="settings-tool-body" style={{ padding: '8px 12px' }}>
          {report.paramSuggestions.length > 0 ? (
            report.paramSuggestions.map((suggestion) => (
              <div
                key={suggestion.paramName}
                className="settings-param-card"
                style={{
                  marginBottom: 4,
                  padding: '6px 8px',
                  borderRadius: 6,
                  background: 'var(--bg-tertiary)',
                  cursor: 'pointer',
                }}
                onClick={() => onToggleParam(suggestion.paramName)}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 500 }}>{suggestion.paramName}</span>
                    {suggestion.recommendedDefault && (
                      <span style={{
                        fontSize: 11,
                        padding: '1px 6px',
                        borderRadius: 4,
                        background: '#2ecc7122',
                        color: '#2ecc71',
                        border: '1px solid #2ecc7144',
                      }}>
                        推荐: {suggestion.recommendedDefault.length > 20
                          ? suggestion.recommendedDefault.slice(0, 20) + '...'
                          : suggestion.recommendedDefault}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-secondary)' }}>
                    <span>{(suggestion.confidence * 100).toFixed(0)}% 置信</span>
                    <span>出现 {suggestion.totalOccurrences} 次</span>
                    <span style={{ transition: 'transform 0.2s', transform: expandedParam === suggestion.paramName ? 'rotate(180deg)' : '' }}>▼</span>
                  </div>
                </div>

                {expandedParam === suggestion.paramName && (
                  <div className="settings-param-detail" style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border-color)' }}>
                    {suggestion.topValues.length > 0 ? (
                      <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ color: 'var(--text-secondary)' }}>
                            <th style={{ textAlign: 'left', padding: '2px 4px' }}>值</th>
                            <th style={{ textAlign: 'right', padding: '2px 4px' }}>次数</th>
                            <th style={{ textAlign: 'right', padding: '2px 4px' }}>成功率</th>
                          </tr>
                        </thead>
                        <tbody>
                          {suggestion.topValues.map((v) => (
                            <tr key={v.value} style={{ borderTop: '1px solid var(--border-color)' }}>
                              <td style={{ padding: '2px 4px', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {v.value.length > 40 ? v.value.slice(0, 40) + '...' : v.value}
                              </td>
                              <td style={{ textAlign: 'right', padding: '2px 4px' }}>{v.count}</td>
                              <td style={{
                                textAlign: 'right',
                                padding: '2px 4px',
                                color: v.successRate >= 0.8 ? '#2ecc71' : v.successRate >= 0.5 ? '#f39c12' : '#e74c3c',
                              }}>
                                {formatSuccessRate(v.successRate)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '4px 0' }}>
                        数据不足，暂无参数值统计
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          ) : (
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '4px 0' }}>
              {report.hasEnoughData
                ? '该工具无可优化参数（无字符串参数或参数值过于分散）'
                : '数据不足，继续使用后将生成优化建议'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
