import { useCallback, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useAgentStore } from '../store/agentStore'
import type { VoiceIntentPrompt } from '../hooks/useAIOutput'

interface InputBarProps {
  onSend: (text: string) => void
  /** Renders before the textarea */
  voiceSlot?: ReactNode
  voiceIntentPrompt?: VoiceIntentPrompt | null
  onConfirmVoiceIntent?: () => void
  onSendVoiceIntentAsChat?: () => void
  onDismissVoiceIntent?: () => void
}

export function InputBar({
  onSend,
  voiceSlot,
  voiceIntentPrompt,
  onConfirmVoiceIntent,
  onSendVoiceIntentAsChat,
  onDismissVoiceIntent,
}: InputBarProps) {
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
      {voiceIntentPrompt && (
        <div className="inputbar-intent-card" role="status" aria-live="polite">
          <div className="inputbar-intent-copy">
            <div className="inputbar-intent-label">语音指令候选</div>
            <div className="inputbar-intent-title">{voiceIntentPrompt.intent.description}</div>
            <div className="inputbar-intent-text">{voiceIntentPrompt.intent.confirmMessage}</div>
            <div className="inputbar-intent-tools">
              {voiceIntentPrompt.intent.toolSequence.map((step, index) => (
                <span key={`${step.tool}-${index}`} className="inputbar-intent-tool">
                  {step.tool}
                </span>
              ))}
            </div>
          </div>
          <div className="inputbar-intent-actions">
            <button type="button" className="inputbar-intent-primary" onClick={onConfirmVoiceIntent}>
              执行指令
            </button>
            <button type="button" className="inputbar-intent-secondary" onClick={onSendVoiceIntentAsChat}>
              当聊天发送
            </button>
            <button type="button" className="inputbar-intent-dismiss" onClick={onDismissVoiceIntent} aria-label="忽略语音指令">
              <i className="ri-close-line" />
            </button>
          </div>
        </div>
      )}
      <div className="inputbar-row">
        {voiceSlot && <div className="inputbar-utilities">{voiceSlot}</div>}
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
