import { useCallback, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useAgentStore } from '../store/agentStore'

interface InputBarProps {
  onSend: (text: string) => void
  /** Renders before the textarea */
  voiceSlot?: ReactNode
}

export function InputBar({ onSend, voiceSlot }: InputBarProps) {
  const agentState = useAgentStore((s) => s.agentState)
  const [value, setValue] = useState('')
  const [textareaRef, setTextareaRef] = useState<HTMLTextAreaElement | null>(null)

  const autoResize = useCallback(() => {
    const el = textareaRef
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  }, [textareaRef])

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
    if (textareaRef) {
      textareaRef.style.height = 'auto'
    }
  }, [value, onSend, textareaRef])

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
          ref={setTextareaRef}
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
