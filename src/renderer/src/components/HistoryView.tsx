import { useEffect, useRef } from 'react'
import { useHistoryViewStore } from '../store/historyViewStore'
import { MessageContent } from './MessageContent'

export function HistoryView() {
  const { sessionLabel, messages, loading, error, closeHistory } = useHistoryViewStore()
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' })
  }, [messages])

  return (
    <div className="history-view">
      {/* Header */}
      <div className="history-view-header">
        <button className="history-view-back" onClick={closeHistory} title="返回当前对话">
          <i className="ri-arrow-left-line" />
          <span>返回</span>
        </button>
        <div className="history-view-heading">
          <span className="history-view-kicker">历史记录</span>
          <h2 className="history-view-title">{sessionLabel}</h2>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="history-view-status">
          <i className="ri-loader-4-line ri-spin" />
          <span>加载中…</span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="history-view-status history-view-error">
          <i className="ri-error-warning-line" />
          <span>{error}</span>
          <button
            className="history-view-retry"
            onClick={() => {
              const state = useHistoryViewStore.getState()
              if (state.sessionId) {
                state.openHistory(state.sessionId, state.sessionLabel)
              }
            }}
          >
            重试
          </button>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && messages.length === 0 && (
        <div className="history-view-status">
          <i className="ri-inbox-line" />
          <span>此对话暂无消息</span>
        </div>
      )}

      {/* Messages */}
      {!loading && !error && messages.length > 0 && (
        <div className="history-view-messages">
          {messages.map((m) => (
            <div key={m.id} className={`msg msg-row ${m.role}`}>
              <div className="msg-avatar">
                <span className={`msg-seal ${m.role}`} aria-hidden="true">
                  {m.role === 'user' ? '你' : '澪'}
                </span>
                <span className="msg-label">{m.role === 'user' ? '你' : '秋山澪'}</span>
              </div>
              <MessageContent content={m.content} />
              <div className="msg-time">{new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  )
}
