import { useEffect, useRef } from 'react'

export interface MessageItem {
  id: string
  source: 'electron' | 'telegram'
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

interface ChatBubbleProps {
  messages: MessageItem[]
}

export function ChatBubble({ messages }: ChatBubbleProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div className="chat-bubbles">
      {messages.map((m, i) => (
        <div key={m.id} className={`bubble ${m.role}`}>
          <div className="bubble-label">
            {m.role === 'user' ? '你' : '秋山澪'}
            {m.source === 'telegram' && <span className="source-tag">Telegram</span>}
          </div>
          <div className="bubble-content">{m.content}</div>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
