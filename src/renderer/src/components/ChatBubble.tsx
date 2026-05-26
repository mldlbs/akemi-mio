import { useEffect, useRef } from 'react'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface ChatBubbleProps {
  messages: Message[]
}

export function ChatBubble({ messages }: ChatBubbleProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div className="chat-bubbles">
      {messages.map((m, i) => (
        <div key={i} className={`bubble ${m.role}`}>
          <div className="bubble-label">{m.role === 'user' ? '你' : '秋山澪'}</div>
          <div className="bubble-content">{m.content}</div>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
