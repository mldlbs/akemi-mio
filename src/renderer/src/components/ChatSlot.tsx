import { useEffect, useRef } from 'react'
import type { MessageItem } from './ChatBubble'

interface ChatSlotProps {
  messages: MessageItem[]
  pendingText?: string
  displayText?: string
  transcribed?: string
  toolStatus: { type: string; tool: string; message: string } | null
}

export function ChatSlot({ messages, pendingText, displayText, transcribed, toolStatus }: ChatSlotProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, displayText])

  const hasPending = !!pendingText

  if (messages.length === 0 && !hasPending && !transcribed) {
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
      {transcribed && (
        <div className="msg msg-row user">
          <div className="msg-label">你</div>
          <div className="msg-bubble">{toolStatus ? `🔧 ${toolStatus.message}` : transcribed}</div>
        </div>
      )}

      {messages.map((m) => (
        <div key={m.id} className={`msg msg-row ${m.role}`}>
          <div className="msg-label">{m.role === 'user' ? '你' : '秋山澪'}</div>
          <div className="msg-bubble">{m.content}</div>
          <div className="msg-time">
            {new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      ))}

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
