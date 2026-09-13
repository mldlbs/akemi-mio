/**
 * 对话框形态的根组件 —— 无边框透明窗口里的一张"会话卡片"。
 *
 * 版面从上到下：标题栏（可拖拽） → 消息流 → 输入区。
 * 之所以要自定义标题栏：窗口是无边框的（frame:false），
 * 没有系统标题栏就没有拖动抓手与关闭按钮，必须自备。
 */

import { useEffect, useRef, useState } from 'react'
import { useChatForm } from './useChatForm'
import { hasFormBridge, setFormVisible, toggleForm } from '../runtime'
import type { FormMessage } from '../types'
import './styles.css'

function formatTime(at: number): string {
  const d = new Date(at)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

function MessageBubble({ message }: { message: FormMessage }) {
  const isUser = message.role === 'user'
  return (
    <div className={`chat-row ${isUser ? 'chat-row-user' : 'chat-row-assistant'}`}>
      <div className={`chat-bubble ${isUser ? 'chat-bubble-user' : 'chat-bubble-assistant'}`}>
        {/* 纯文本渲染：只把换行还原，不做 Markdown —— 轻量优先 */}
        <span className="chat-bubble-text">{message.text}</span>
        {message.streaming && <span className="chat-caret" aria-hidden="true" />}
        <time className="chat-time">{formatTime(message.at)}</time>
      </div>
    </div>
  )
}

export function ChatForm() {
  const { messages, sending, clear, send } = useChatForm()
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // 新消息到达时滚到底部。用 scrollTop 直接赋值而非 scrollIntoView，
  // 后者在透明窗口里可能把整个 body 一起滚走。
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = () => {
    // 必须先挡一层再清输入框：send 内部有 !trimmed / sending 的早退，
    // 先清空的话，被拒的输入就永久丢失了（用户输入了字，却什么都没发生）。
    if (sending || !draft.trim()) return
    const text = draft
    setDraft('')
    void send(text)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 发送，Shift+Enter 换行 —— IM 的通用约定
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
    // Esc 收起对话框，回到桌面
    if (e.key === 'Escape') {
      void setFormVisible('chat', false)
    }
  }

  return (
    <div className="chat-card">
      {/* ── 标题栏 ── */}
      <header className="chat-titlebar form-drag-region">
        <span className="chat-avatar-dot" aria-hidden="true" />
        <span className="chat-title">Akemi Mio</span>
        <span className="chat-subtitle">{sending ? '思考中…' : '随时可以说话'}</span>
        <div className="chat-titlebar-actions form-no-drag">
          <button className="chat-icon-btn" onClick={clear} title="清空会话" aria-label="清空会话" disabled={messages.length === 0}>
            ⌫
          </button>
          <button
            className="chat-icon-btn"
            onClick={() => void toggleForm('pet')}
            title="切换到宠物形态"
            aria-label="切换到宠物形态"
          >
            ❀
          </button>
          <button
            className="chat-icon-btn chat-icon-btn-close"
            onClick={() => void setFormVisible('chat', false)}
            title="收起（Esc）"
            aria-label="收起对话框"
          >
            ✕
          </button>
        </div>
      </header>

      {/* ── 消息流 ── */}
      <div className="chat-list" ref={listRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            <p className="chat-empty-title">想聊点什么？</p>
            <p className="chat-empty-hint">Enter 发送 · Shift+Enter 换行 · Esc 收起</p>
          </div>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} message={m} />)
        )}
      </div>

      {/* ── 输入区 ── */}
      <div className="chat-composer">
        <textarea
          ref={inputRef}
          className="chat-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="说点什么…"
          rows={1}
          disabled={sending}
        />
        <button className="chat-send" onClick={submit} disabled={sending || draft.trim().length === 0} title="发送" aria-label="发送">
          ↑
        </button>
      </div>

      {!hasFormBridge() && <div className="form-degraded-banner">预览模式：未接入桌面窗口</div>}
    </div>
  )
}
