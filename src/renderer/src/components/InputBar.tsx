import { useState, useCallback, useRef, type KeyboardEvent, type ReactNode } from 'react'
import type { AgentState } from '../hooks/useAIOutput'

interface InputBarProps {
  onSend: (text: string) => void
  /** Renders before the textarea */
  voiceSlot?: ReactNode
  agentState?: AgentState
}

export function InputBar({ onSend, voiceSlot, agentState }: InputBarProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const autoResize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  }, [])

  const isBusy = agentState === 'thinking' || agentState === 'tool_executing' || agentState === 'replying'

  const handleStop = useCallback(async () => {
    try {
      await window.electronAPI.stopConversation()
    } catch {
      /* ignore */
    }
  }, [])

  const handleSend = useCallback(() => {
    const t = value.trim()
    if (!t) return
    onSend(t)
    setValue('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [value, onSend])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  return (
    <div className="inputbar">
      <div className="inputbar-row">
        {voiceSlot}
        <textarea
          ref={textareaRef}
          className="inputbar-field"
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            autoResize()
          }}
          onKeyDown={handleKeyDown}
          placeholder="输入消息…"
          rows={1}
        />
        {isBusy ? (
          <button className="inputbar-stop" onClick={handleStop} title="停止回复">
            <i className="ri-stop-fill" />
          </button>
        ) : (
          <button className="inputbar-send" disabled={!value.trim()} onClick={handleSend} title="发送">
            <i className="ri-send-plane-2-fill" />
          </button>
        )}
      </div>
    </div>
  )
}
