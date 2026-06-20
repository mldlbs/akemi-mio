import { useState, useEffect, useCallback, useRef } from 'react'
import { VoiceInput } from './components/VoiceInput'
import { StatusBar } from './components/StatusBar'
import { WaveRibbon } from './components/WaveRibbon'
import { ChatBubble, type MessageItem } from './components/ChatBubble'
import { playTTS, playTTSBuffer, stopTTS, onTTSStart, onTTSError } from './components/audioShared'
import { useIPCEvent } from './hooks/useIPCEvent'
import { useTimerControl } from './hooks/useTimer'

function App() {
  const [active, setActive] = useState(false)
  const [ttsPlaying, setTtsPlaying] = useState(false)
  const [text, setText] = useState('')
  const [transcribed, setTranscribed] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [displayText, setDisplayText] = useState('')
  const [overflow, setOverflow] = useState(false)
  const [toolStatus, setToolStatus] = useState<{ type: string; tool: string; message: string } | null>(null)
  const [inputText, setInputText] = useState('')
  const [inputOpen, setInputOpen] = useState(false)
  const [historyMessages, setHistoryMessages] = useState<MessageItem[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)

  const fadeTimer = useTimerControl()
  const revealTimer = useTimerControl()

  const textRef = useRef('')

  const marqueeRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const replyRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    const el = marqueeRef.current
    if (el) setOverflow(el.scrollWidth > el.clientWidth)
  }, [transcribed])

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(() => {
      const el = marqueeRef.current
      if (el) setOverflow(el.scrollWidth > el.clientWidth)
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    textRef.current = text
  }, [text])

  useEffect(() => {
    const onStart = (duration: number) => {
      const t = textRef.current
      if (!t) return
      revealTimer.clear()
      setDisplayText('')
      const totalMs = duration * 1000
      const intervalMs = Math.max(20, totalMs / t.length)
      let i = 0
      revealTimer.setInterval(() => {
        i++
        setDisplayText(t.slice(0, i))
        if (i >= t.length) revealTimer.clear()
      }, intervalMs)
    }
    const onError = (err: string) => {
      setError(err)
    }
    onTTSStart(onStart)
    onTTSError(onError)
    return () => {
      revealTimer.clear()
      fadeTimer.clear()
    }
  }, [])

  // 自动水平滚动底部
  useEffect(() => {
    const el = replyRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [displayText])

  // 加载对话历史
  useEffect(() => {
    window.electronAPI
      .getMessageHistory(200)
      .then((msgs) => {
        setHistoryMessages(msgs)
      })
      .catch(() => {})
  }, [])

  useIPCEvent(window.electronAPI.onStateUpdate, (s) => {
    if (s.error) setError(s.error as string)
    if (s.ttsPlaying !== undefined) setTtsPlaying(s.ttsPlaying as boolean)
  })

  useIPCEvent(window.electronAPI.onAIChunk, (chunk) => {
    setText((prev) => prev + chunk)
    fadeTimer.clear()
  })

  useIPCEvent(window.electronAPI.onTTSAudio, (filePath) => {
    playTTS(filePath)
  })

  useIPCEvent(window.electronAPI.onTTSBuffer, (buf) => {
    playTTSBuffer(buf)
  })

  useIPCEvent(window.electronAPI.onToolStatus, (status) => {
    if (status.type === 'start') {
      setToolStatus(status)
    } else {
      setToolStatus(null)
    }
  })

  // 新消息实时追加到历史
  useIPCEvent(window.electronAPI.onMessageNew, (msg) => {
    setHistoryMessages((prev) => [...prev, msg])
  })

  const handleResult = useCallback(async (t: string) => {
    if (!t) return
    setTranscribed(t)
    setText('')
    setDisplayText('')
    setError(undefined)
    setToolStatus(null)
    revealTimer.clear()
    try {
      await window.electronAPI.chat(t)
    } catch (err) {
      setError(String(err))
    }
    fadeTimer.set(() => {
      setText('')
      setDisplayText('')
    }, 10000)
  }, [])

  const handleSend = useCallback(async () => {
    const t = inputText.trim()
    if (!t) return
    setInputText('')
    await handleResult(t)
    inputRef.current?.focus()
  }, [inputText, handleResult])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  return (
    <div className="shell">
      <div className="app">
        {/* 主视觉区 */}
        <div className="viz-area">
          <div className="viz-glow" />
          <div className="viz-ring" />
          <WaveRibbon ttsPlaying={ttsPlaying} />
        </div>

        {/* 状态指示器 */}
        <StatusBar conversationActive={active} ttsPlaying={ttsPlaying} error={error} />

        {/* 转录显示 — 鼠标移入展开输入框 */}
        <div
          className="transcript-card"
          onMouseEnter={() => setInputOpen(true)}
          onMouseLeave={() => {
            if (!inputText.trim() && document.activeElement !== inputRef.current) {
              setInputOpen(false)
            }
          }}
        >
          <div className="marquee-wrap" ref={wrapRef}>
            <div className={`marquee-inner${overflow ? ' scrolling' : ''}`} key={transcribed || ' '} ref={marqueeRef}>
              {toolStatus ? `🔧 ${toolStatus.message}` : transcribed || ' '}
            </div>
          </div>
          {displayText && (
            <p className="reply-text" ref={replyRef}>
              {displayText}
            </p>
          )}
          <div className={`text-input-wrap ${inputOpen ? 'visible' : ''}`}>
            <div className="text-input-row">
              <input
                ref={inputRef}
                className="text-input"
                type="text"
                placeholder="打字输入 API 密钥、URL 等语音不便的内容"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={() => {
                  if (!inputText.trim()) setInputOpen(false)
                }}
              />
              <button className="btn-send" onClick={handleSend} disabled={!inputText.trim()}>
                <i className="ri-send-plane-2-fill" />
              </button>
            </div>
          </div>
        </div>

        {/* 历史消息 */}
        <div className="history-section">
          <button
            className="btn-history-toggle"
            onClick={() => setHistoryOpen((o) => !o)}
            title={historyOpen ? '收起对话历史' : '展开对话历史'}
          >
            <i className={`ri-chat-history-${historyOpen ? 'fill' : 'line'}`} />
            <span>对话记录</span>
          </button>
          {historyOpen && (
            <div className="history-panel">
              <ChatBubble messages={historyMessages} />
            </div>
          )}
        </div>

        {/* 控制区 */}
        <div className="control-area">
          <VoiceInput onResult={handleResult} onConversationChange={setActive} ttsPlaying={ttsPlaying} />
        </div>
      </div>
    </div>
  )
}

export default App
