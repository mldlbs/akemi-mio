import { useEffect, useRef, useCallback, useState } from 'react'
import type { MessageItem, ToolEvent } from '../slots/types'
import type { AgentState } from '../hooks/useAIOutput'

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }, [text])

  return (
    <button className={`msg-copy-btn${copied ? ' copied' : ''}`} onClick={handleCopy} title="复制">
      <i className={`ri-${copied ? 'check-line' : 'file-copy-line'}`} />
    </button>
  )
}

interface ChatSlotProps {
  messages: MessageItem[]
  pendingText?: string
  displayText?: string
  transcribed?: string
  toolStatus: { type: string; tool: string; message: string } | null
  agentState: AgentState
  toolRunning: ToolEvent[]
  toolCompleted: ToolEvent[]
  historyLoading?: boolean
}

const AGENT_LABELS: Record<AgentState, string | null> = {
  idle: null,
  thinking: '思考中…',
  tool_executing: '执行工具…',
  replying: null,
}

export function ChatSlot({
  messages,
  pendingText,
  displayText,
  transcribed,
  toolStatus,
  agentState,
  toolRunning,
  toolCompleted,
  historyLoading,
}: ChatSlotProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, displayText, toolRunning, toolCompleted])

  const hasPending = !!pendingText
  const agentLabel = AGENT_LABELS[agentState]
  const hasTools = toolRunning.length > 0 || toolCompleted.length > 0
  const showEmpty = messages.length === 0 && !hasPending && !transcribed && !hasTools && !agentLabel && !historyLoading

  // 加载中状态
  if (historyLoading) {
    return (
      <div className="chat-slot">
        <div className="chat-empty">
          <div className="chat-empty-icon">
            <i className="ri-loader-4-line ri-spin" />
          </div>
          <div className="chat-empty-text">加载中…</div>
        </div>
      </div>
    )
  }

  if (showEmpty) {
    return (
      <div className="chat-slot">
        <div className="chat-empty">
          <div className="chat-empty-icon">
            <i className="ri-chat-1-line" />
          </div>
          <div className="chat-empty-text">开始一段新对话</div>
        </div>
      </div>
    )
  }

  return (
    <div className="chat-slot">
      {/* Agent 状态指示 */}
      {agentLabel && (
        <div className="agent-indicator">
          <span className="agent-indicator-dot" />
          <span className="agent-indicator-text">{agentLabel}</span>
        </div>
      )}

      {/* 用户刚说的转录文本 */}
      {transcribed && (
        <div className="msg msg-row user">
          <div className="msg-label">你</div>
          <div className="msg-bubble">{transcribed}</div>
          <div className="msg-actions">
            <CopyButton text={transcribed} />
          </div>
        </div>
      )}

      {/* 历史消息 */}
      {messages.map((m) => (
        <div key={m.id} className={`msg msg-row ${m.role}`}>
          <div className="msg-label">{m.role === 'user' ? '你' : '秋山澪'}</div>
          <div className="msg-bubble">{m.content}</div>
          <div className="msg-actions">
            <CopyButton text={m.content} />
            <span className="msg-time">{new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        </div>
      ))}

      {/* 正在执行的 tool 卡片 */}
      {toolRunning.length > 0 && (
        <div className="tool-inline-group">
          {toolRunning.map((t) => (
            <div key={t.id} className="tool-inline tool-inline-running">
              <i className="ri-loader-4-line ri-spin" />
              <span className="tool-inline-name">{t.tool}</span>
              {t.args && <span className="tool-inline-args">{JSON.stringify(t.args).slice(0, 80)}</span>}
            </div>
          ))}
        </div>
      )}

      {/* 刚完成的 tool 卡片 */}
      {toolCompleted.length > 0 && (
        <div className="tool-inline-group">
          {toolCompleted.map((t) => (
            <div key={t.id} className={`tool-inline ${t.error ? 'tool-inline-failed' : 'tool-inline-done'}`}>
              <i className={`ri-${t.error ? 'close-circle-line' : 'check-line'}`} />
              <span className="tool-inline-name">{t.tool}</span>
              {t.latencyMs !== undefined && <span className="tool-inline-meta">{(t.latencyMs / 1000).toFixed(1)}s</span>}
              {t.error && <span className="tool-inline-error">{t.error}</span>}
            </div>
          ))}
        </div>
      )}

      {/* 流式回复 */}
      {hasPending && (
        <div className="msg msg-row assistant">
          <div className="msg-label">秋山澪</div>
          <div className="msg-bubble">
            {displayText || pendingText}
            <span className="msg-cursor" />
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  )
}
