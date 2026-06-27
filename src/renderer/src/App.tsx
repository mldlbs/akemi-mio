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
import { playTTS, playTTSBuffer } from './components/audioShared'
import { useIPCEvent } from './hooks/useIPCEvent'
import { useSlots } from './slots/SlotContext'
import type { MessageItem } from './components/ChatBubble'

function App() {
  const [active, setActive] = useState(false)
  const [ttsPlaying, setTtsPlaying] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [historyMessages, setHistoryMessages] = useState<MessageItem[]>([])
  const [sessionHealth, setSessionHealth] = useState('100:HEALTHY:RUNNING')

  const { uiState, setActiveSlot } = useSlots()

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
    if (s.sessionHealth) setSessionHealth(s.sessionHealth as string)
  })

  useIPCEvent(window.electronAPI.onTTSAudio, (filePath) => {
    playTTS(filePath)
  })

  useIPCEvent(window.electronAPI.onTTSBuffer, (buf) => {
    playTTSBuffer(buf)
  })

  useIPCEvent(window.electronAPI.onToolStatus, (status) => {
    if (status.type === 'start') {
      setActiveSlot('tool')
    } else {
      setActiveSlot('chat')
    }
  })

  useIPCEvent(window.electronAPI.onMessageNew, (msg) => {
    setHistoryMessages((prev) => [...prev, msg])
  })

  const handleResult = useCallback(async (t: string) => {
    if (!t) return
    setError(undefined)
    try {
      await window.electronAPI.chat(t)
    } catch (err) {
      setError(String(err))
    }
  }, [])

  return (
    <div className="app-shell">
      <TopBar />
      <div className="app-body">
        <Sidebar />
        <MainArea>
          {uiState.activeSlot === 'chat' && <ChatSlot messages={historyMessages} />}
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
