import { useMemo, useState, type MouseEvent } from 'react'
import { useAgentStore } from '../store/agentStore'
import { useClockStore } from '../store/clockStore'
import { isToolActive } from '../tool/toolTypes'
import type { ToolState } from '../tool/toolTypes'
import { ToolParamSuggestions } from './ToolParamSuggestions'

function useNow(): number {
  return useClockStore((s) => s.now)
}

function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const now = useNow()
  const sec = Math.floor((now - startedAt) / 1000)
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return <span className="tool-elapsed">{`${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`}</span>
}

function CollapsibleJson({ data, max = 80 }: { data: Record<string, any>; max?: number }) {
  const raw = JSON.stringify(data)
  const [open, setOpen] = useState(false)
  if (raw.length <= max) return <div className="tool-item-args">{raw}</div>
  return (
    <div className="tool-item-args">
      <span className="tool-args-preview">{open ? raw : raw.slice(0, max) + '…'}</span>
      <button className="tool-args-toggle" onClick={() => setOpen(!open)}>
        {open ? '收起' : '展开'}
      </button>
    </div>
  )
}

function ToolIcon({ state }: { state: ToolState }) {
  switch (state.status) {
    case 'pending':
    case 'running':
      return <i className="ri-loader-4-line ri-spin" />
    case 'timeout':
      return <i className="ri-time-line" />
    case 'cancelled':
      return <i className="ri-stop-circle-line" />
    case 'error':
      return <i className="ri-close-circle-line" />
    case 'success':
      return <i className="ri-check-line" />
  }
}

export function ToolSlot() {
  const tools = useAgentStore((s) => s.tools)

  const activeTools = tools.filter(isToolActive)
  const completedTools = tools.filter((t) => !isToolActive(t))
  const allEmpty = tools.length === 0

  // 最近一次成功完成的工具，用于显示参数建议
  const lastSuccessfulTool = useMemo(() => {
    const success = tools.filter((t) => t.status === 'success')
    if (success.length === 0) return null
    return success[success.length - 1]
  }, [tools])

  if (allEmpty) {
    return (
      <div className="tool-slot">
        <div className="tool-empty-icon">
          <i className="ri-tools-line" />
        </div>
        <div className="chat-empty-text tool-empty-text">AI 在回答过程中使用工具时，工具调用会显示在此</div>
      </div>
    )
  }

  const handleCancel = (e: MouseEvent) => {
    e.stopPropagation()
    window.electronAPI.stopConversation().catch(() => {})
  }

  return (
    <div className="tool-slot tool-slot-content">
      {activeTools.length > 0 && (
        <div className="tool-slot-section">
          <div className="tool-slot-heading">
            <span>执行中</span>
            <span className="tool-count-badge">{activeTools.length}</span>
          </div>
          {activeTools.map((t) => (
            <div key={t.id} className="tool-item tool-item-running">
              <div className="tool-item-icon">
                <ToolIcon state={t} />
              </div>
              <div className="tool-item-body">
                <div className="tool-item-name">{t.tool}</div>
                {t.args && Object.keys(t.args).length > 0 && <CollapsibleJson data={t.args} />}
                <div className="tool-item-meta">
                  {t.status === 'running' && <ElapsedTimer startedAt={t.startedAt} />}
                  {t.status === 'pending' && <span>等待中</span>}
                </div>
              </div>
              <button className="tool-cancel-btn" onClick={handleCancel} title="取消此工具">
                <i className="ri-close-line" />
              </button>
            </div>
          ))}
        </div>
      )}

      {completedTools.length > 0 && (
        <div className="tool-slot-section">
          <div className="tool-slot-heading">
            <span>已执行</span>
            <span className="tool-count-badge">{completedTools.length}</span>
          </div>
          {completedTools.map((t) => {
            const cssClass =
              t.status === 'timeout'
                ? 'tool-item-timedout'
                : t.status === 'cancelled'
                  ? 'tool-item-cancelled'
                  : t.status === 'error'
                    ? 'tool-item-failed'
                    : 'tool-item-done'

            return (
              <div key={t.id} className={`tool-item ${cssClass}`}>
                <div className="tool-item-icon">
                  <ToolIcon state={t} />
                </div>
                <div className="tool-item-body">
                  <div className="tool-item-name">{t.tool}</div>
                  <div className="tool-item-meta">
                    <span className="tool-latency">{(t.latencyMs / 1000).toFixed(1)}s</span>
                    {t.status === 'timeout' && <span className="tool-error-text">超时</span>}
                    {t.status === 'cancelled' && <span className="tool-cancelled-text">已取消</span>}
                    {t.status === 'error' && <span className="tool-error-text">{t.error}</span>}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 最近成功工具的参数组合智能建议 */}
      {lastSuccessfulTool && !isToolActive(lastSuccessfulTool) && (
        <div className="tool-slot-section tool-slot-suggestions">
          <ToolParamSuggestions
            toolName={lastSuccessfulTool.tool}
            maxSuggestions={2}
            onAdopt={(args) => {
              // 采纳参数组合 — 目前关闭建议列表（用户可再次展开）
            }}
          />
        </div>
      )}
    </div>
  )
}
