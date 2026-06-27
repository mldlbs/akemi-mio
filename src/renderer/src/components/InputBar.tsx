import { useState, useCallback, useRef, type KeyboardEvent } from 'react'
import { useSlots } from '../slots/SlotContext'

interface InputBarProps {
  onSend: (text: string) => void
}

export function InputBar({ onSend }: InputBarProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { setCommandMode } = useSlots()

  const autoResize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
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
      if (e.key === '/' && value === '') {
        setCommandMode(true)
      }
    },
    [handleSend, value, setCommandMode],
  )

  return (
    <div className="inputbar">
      <div className="inputbar-row">
        <button className="inputbar-attach" title="附加">
          <i className="ri-attachment-2" />
        </button>
        <textarea
          ref={textareaRef}
          className="inputbar-field"
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            autoResize()
          }}
          onKeyDown={handleKeyDown}
          placeholder="输入消息…  / 触发命令"
          rows={1}
        />
        <button className="inputbar-send" disabled={!value.trim()} onClick={handleSend} title="发送">
          <i className="ri-send-plane-2-fill" />
        </button>
      </div>
    </div>
  )
}
