/**
 * WallpaperAgentPanel — 壁纸交互模式 Agent 面板
 *
 * 在桌面壁纸 overlay 上显示半透明的 Agent 输入/输出面板。
 * 由 Ctrl+Space 全局快捷键切换显示。
 * 鼠标穿透默认开启，激活后输入区域可交互。
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useWallpaperInteractionStore } from '../store/wallpaperInteractionStore'
import type { WallpaperChatMessage } from '../store/wallpaperInteractionStore'

// =============================================================================
// 常量
// =============================================================================

const EXAMPLES = [
  '帮我整理桌面文件',
  '今天有什么待办事项？',
  '打开计算器',
  '截屏并翻译',
]

// =============================================================================
// 子组件：消息气泡
// =============================================================================

function MessageBubble({ msg }: { msg: WallpaperChatMessage }) {
  const isUser = msg.role === 'user'
  const isSystem = msg.role === 'system'

  if (isSystem) {
    return (
      <div className="wp-agent-msg wp-agent-msg-system">
        <span className="wp-agent-msg-text">{msg.content}</span>
      </div>
    )
  }

  return (
    <div className={`wp-agent-msg ${isUser ? 'wp-agent-msg-user' : 'wp-agent-msg-assistant'}`}>
      <div className="wp-agent-msg-avatar">
        {isUser ? '👤' : '🤖'}
      </div>
      <div className="wp-agent-msg-content">
        <span className="wp-agent-msg-text">{msg.content}</span>
        <span className="wp-agent-msg-time">
          {new Date(msg.timestamp).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
      </div>
    </div>
  )
}

// =============================================================================
// 主组件
// =============================================================================

export function WallpaperAgentPanel() {
  const {
    interactive,
    messages,
    status,
    addMessage,
    clearMessages,
    setStatus,
    setInteractive,
  } = useWallpaperInteractionStore()

  const [inputText, setInputText] = useState('')
  const [showExamples, setShowExamples] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const [responseText, setResponseText] = useState('')

  // ── 自动聚焦输入框 ──
  useEffect(() => {
    if (interactive && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
    if (!interactive) {
      setInputText('')
      setResponseText('')
    }
  }, [interactive])

  // ── 自动滚动到最新消息 ──
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // ── 监听 AI 流式输出（用于实时显示中间文本） ──
  useEffect(() => {
    if (!interactive) return

    const unsubChunk = window.electronAPI.onAIChunk((text) => {
      setResponseText((prev) => prev + text)
    })

    return () => {
      unsubChunk()
    }
  }, [interactive])

  // ── 监听 Esc 键退出 ──
  useEffect(() => {
    if (!interactive) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setInteractive(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [interactive, setInteractive])

  // ── 发送消息 ──
  const handleSend = useCallback(async () => {
    const text = inputText.trim()
    if (!text || status === 'processing') return

    setInputText('')
    setShowExamples(false)
    setResponseText('')

    // 添加用户消息
    addMessage({
      role: 'user',
      content: text,
      timestamp: Date.now(),
    })

    // 设置处理中状态
    setStatus('processing')

    try {
      const result = await window.electronAPI.chat(text)
      if (result?.reply) {
        addMessage({
          role: 'assistant',
          content: result.reply,
          timestamp: Date.now(),
        })
      } else if (result?.error) {
        addMessage({
          role: 'system',
          content: `错误: ${result.error}`,
          timestamp: Date.now(),
        })
      }
    } catch (err: any) {
      addMessage({
        role: 'system',
        content: `发送失败: ${err?.message || '未知错误'}`,
        timestamp: Date.now(),
      })
    } finally {
      setStatus('idle')
      setResponseText('')
    }
  }, [inputText, status, addMessage, setStatus])

  // ── 输入框按键处理 ──
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  // ── 选择示例问题 ──
  const handleExampleClick = useCallback(
    async (example: string) => {
      if (status === 'processing') return

      setInputText(example)
      setShowExamples(false)
      setResponseText('')

      addMessage({
        role: 'user',
        content: example,
        timestamp: Date.now(),
      })
      setStatus('processing')

      try {
        const result = await window.electronAPI.chat(example)
        if (result?.reply) {
          addMessage({
            role: 'assistant',
            content: result.reply,
            timestamp: Date.now(),
          })
        } else if (result?.error) {
          addMessage({
            role: 'system',
            content: `错误: ${result.error}`,
            timestamp: Date.now(),
          })
        }
      } catch (err: any) {
        addMessage({
          role: 'system',
          content: `发送失败: ${err?.message || '未知错误'}`,
          timestamp: Date.now(),
        })
      } finally {
        setStatus('idle')
        setResponseText('')
      }
    },
    [status, addMessage, setStatus],
  )

  if (!interactive) return null

  const hasMessages = messages.length > 0
  const streamingText = responseText || (status === 'processing' ? '…' : '')

  return (
    <div className="wp-agent-panel">
      {/* ── 面板头部 ── */}
      <div className="wp-agent-header">
        <div className="wp-agent-header-left">
          <span className="wp-agent-header-icon">💬</span>
          <span className="wp-agent-header-title">桌面智能助手</span>
          <span className={`wp-agent-status-dot ${status === 'processing' ? 'wp-agent-status-busy' : ''}`} />
          <span className="wp-agent-status-label">
            {status === 'processing' ? '处理中…' : '就绪'}
          </span>
        </div>
        <div className="wp-agent-header-right">
          {hasMessages && (
            <button
              className="wp-agent-header-btn"
              onClick={clearMessages}
              title="清空对话"
            >
              🗑️
            </button>
          )}
          <button
            className="wp-agent-header-btn"
            onClick={() => setInteractive(false)}
            title="关闭 (Esc)"
          >
            ✕
          </button>
        </div>
      </div>

      {/* ── 消息列表 ── */}
      <div className="wp-agent-messages">
        {!hasMessages && !streamingText && (
          <div className="wp-agent-empty">
            <div className="wp-agent-empty-icon">✨</div>
            <div className="wp-agent-empty-text">
              按 <kbd>Ctrl+Space</kbd> 再次关闭，输入指令开始使用
            </div>
            {showExamples && (
              <div className="wp-agent-examples">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    className="wp-agent-example-btn"
                    onClick={() => handleExampleClick(ex)}
                  >
                    {ex}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {messages.map((msg, i) => (
          <MessageBubble key={`${msg.timestamp}-${i}`} msg={msg} />
        ))}

        {/* 流式输出 */}
        {streamingText && (
          <div className="wp-agent-msg wp-agent-msg-assistant wp-agent-msg-streaming">
            <div className="wp-agent-msg-avatar">🤖</div>
            <div className="wp-agent-msg-content">
              <span className="wp-agent-msg-text">{streamingText}</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* ── 输入区域 ── */}
      <div className="wp-agent-input-area">
        <input
          ref={inputRef}
          className="wp-agent-input"
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={status === 'processing' ? '等待回复…' : '输入指令，Enter 发送'}
          disabled={status === 'processing'}
        />
        <button
          className="wp-agent-send-btn"
          onClick={handleSend}
          disabled={!inputText.trim() || status === 'processing'}
          title="发送 (Enter)"
        >
          {status === 'processing' ? '⏳' : '➤'}
        </button>
      </div>
    </div>
  )
}
