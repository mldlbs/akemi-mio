import { useState, useEffect, useCallback, useRef } from 'react'
import { VoiceInput } from './components/VoiceInput'
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

interface SessionItem {
  id: string
  label: string
  messageCount: number
  lastActivityAt: number
  createdAt: number
}

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
  const [personaLevel, setPersonaLevel] = useState<string>('core')
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string>('')

  const fadeTimer = useTimerControl()
  const revealTimer = useTimerControl()
  const textRef = useRef('')
  const { uiState, setActiveSlot } = useSlots()

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

  // 加载会话列表
  useEffect(() => {
    window.electronAPI
      .getSessions()
      .then((s) => {
        setSessions(s)
        if (s.length > 0 && !activeSessionId) {
          setActiveSessionId(s[0].id)
        }
      })
      .catch(() => {})
  }, [])

  // 按活跃 session 加载消息
  useEffect(() => {
    if (!activeSessionId) return
    window.electronAPI
      .getMessagesBySession(activeSessionId)
      .then((msgs) => {
        setHistoryMessages(msgs)
      })
      .catch(() => {})
  }, [activeSessionId])

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
    // 新消息到来时始终追加到当前会话，并自动切换到最新 session
    if (msg.sessionId && msg.sessionId !== activeSessionId) {
      setActiveSessionId(msg.sessionId)
      setHistoryMessages([msg])
    } else if (msg.sessionId === activeSessionId) {
      setHistoryMessages((prev) => [...prev, msg])
    }
    setPendingText('')
    setDisplayText('')
    revealTimer.clear()
    // 刷新会话列表
    window.electronAPI
      .getSessions()
      .then(setSessions)
      .catch(() => {})
  })

  useIPCEvent(window.electronAPI.onPersonaUpdated, (data) => {
    setPersonaLevel(data.level)
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
      await window.electronAPI.chat(t, undefined, activeSessionId || undefined)
    } catch (err) {
      setError(String(err))
    }
    fadeTimer.set(() => {
      setPendingText('')
      setDisplayText('')
      setTranscribed('')
    }, 10000)
  }, [activeSessionId])

  const handleSelectChat = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId)
  }, [])

  return (
    <div className="app-shell">
      <TopBar
        conversationActive={active}
        ttsPlaying={ttsPlaying}
        error={error}
        sessionHealth={sessionHealth}
        personaLevel={personaLevel}
        agentSlot={
          <button className="cap-toggle-btn" onClick={() => window.electronAPI.openAgentWindow()} title="Agent 面板">
            <i className="ri-robot-2-line" />
          </button>
        }
      />
      <div className="app-body">
        <Sidebar sessions={sessions} activeSessionId={activeSessionId} onSelectChat={handleSelectChat} />
        <MainArea>
          {uiState.activeSlot === 'chat' && (
            <ChatSlot
              messages={historyMessages}
              pendingText={pendingText}
              displayText={displayText}
              transcribed={transcribed}
              toolStatus={toolStatus}
            />
          )}
          {uiState.activeSlot === 'tool' && <ToolSlot />}
          {uiState.activeSlot === 'preview' && <PreviewSlot />}
        </MainArea>
      </div>
      <InputBar
        onSend={handleResult}
        voiceSlot={<VoiceInput onResult={handleResult} onConversationChange={setActive} ttsPlaying={ttsPlaying} />}
      />
    </div>
  )
}

export default App
