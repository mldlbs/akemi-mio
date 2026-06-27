import { useState, useEffect, useCallback, useRef } from 'react'
import { VoiceInput } from './components/VoiceInput'
import { StatusBar } from './components/StatusBar'
import { TopBar } from './components/TopBar'
import { Sidebar } from './components/Sidebar'
import { MainArea } from './components/MainArea'
import { InputBar } from './components/InputBar'
import { ChatSlot } from './components/ChatSlot'
import { ToolSlot } from './components/ToolSlot'
import { PreviewSlot } from './components/PreviewSlot'
import { playTTS, playTTSBuffer, onTTSStart, onTTSError } from './components/audioShared'
import { useIPCEvent } from './hooks/useIPCEvent'
import { useTimerControl } from './hooks/useTimer'
import { useSlots } from './slots/SlotContext'
import type { MessageItem } from './components/ChatBubble'

export type { MessageItem }

function App() {
  const [active, setActive] = useState(false)
  const [ttsPlaying, setTtsPlaying] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [historyMessages, setHistoryMessages] = useState<MessageItem[]>([])
  const [sessionHealth, setSessionHealth] = useState('100:HEALTHY:RUNNING')
  const [pendingText, setPendingText] = useState('')
  const [displayText, setDisplayText] = useState('')
  const [transcribed, setTranscribed] = useState('')
  const [toolStatus, setToolStatus] = useState<{ type: string; tool: string; message: string } | null>(null)

  const fadeTimer = useTimerControl()
  const revealTimer = useTimerControl()
  const textRef = useRef('')
  const { uiState, setActiveSlot, setActiveChatId } = useSlots()

  useEffect(() => {
    textRef.current = pendingText
  }, [pendingText])

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
    if (s.sessionHealth) setSessionHealth(s.sessionHealth as string)
  })

  useIPCEvent(window.electronAPI.onAIChunk, (chunk) => {
    setPendingText((prev) => prev + chunk)
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
      setActiveSlot('tool')
    } else {
      setToolStatus(null)
      setActiveSlot('chat')
    }
  })

  useIPCEvent(window.electronAPI.onMessageNew, (msg) => {
    setHistoryMessages((prev) => [...prev, msg])
    setPendingText('')
    setDisplayText('')
    revealTimer.clear()
  })

  const handleResult = useCallback(async (t: string) => {
    if (!t) return
    setTranscribed(t)
    setError(undefined)
    setPendingText('')
    setDisplayText('')
    setToolStatus(null)
    revealTimer.clear()
    try {
      await window.electronAPI.chat(t)
    } catch (err) {
      setError(String(err))
    }
    fadeTimer.set(() => {
      setPendingText('')
      setDisplayText('')
      setTranscribed('')
    }, 10000)
  }, [])

  return (
    <div className="app-shell">
      <TopBar />
      <div className="app-body">
        <Sidebar historyMessages={historyMessages} activeChatId={uiState.activeChatId} onSelectChat={setActiveChatId} />
        <MainArea>
          {uiState.activeSlot === 'chat' && <ChatSlot messages={historyMessages} pendingText={pendingText} displayText={displayText} transcribed={transcribed} toolStatus={toolStatus} />}
          {uiState.activeSlot === 'tool' && <ToolSlot />}
          {uiState.activeSlot === 'preview' && <PreviewSlot />}
        </MainArea>
      </div>
      <InputBar onSend={handleResult} />

      <div style={{ position: 'fixed', bottom: 80, right: 24, zIndex: 50, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
        <StatusBar conversationActive={active} ttsPlaying={ttsPlaying} error={error} sessionHealth={sessionHealth} />
        <VoiceInput onResult={handleResult} onConversationChange={setActive} ttsPlaying={ttsPlaying} />
      </div>

      <button
        className="cap-toggle-btn"
        onClick={() => window.electronAPI.openAgentWindow()}
        title="打开 Agent 面板"
        style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 50 }}
      >
        <i className="ri-robot-2-line" />
      </button>
    </div>
  )
}

export default App
