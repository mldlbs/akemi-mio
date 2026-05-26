import { useState, useEffect, useCallback } from 'react'
import { VoiceInput } from './components/VoiceInput'
import { ChatBubble } from './components/ChatBubble'
import { StatusBar } from './components/StatusBar'
import './App.css'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [asrStatus, setAsrStatus] = useState('loading')
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [inputEnabled, setInputEnabled] = useState(false)

  useEffect(() => {
    window.electronAPI.getState().then((state) => {
      setAsrStatus(state.asr)
      if (state.asr === 'ready') setInputEnabled(true)
    })

    const cleanup = window.electronAPI.onStateUpdate((state) => {
      if (state.asr) setAsrStatus(state.asr as string)
      if (state.recording !== undefined) setRecording(state.recording as boolean)
      if (state.error) setError(state.error as string)
    })

    return cleanup
  }, [])

  const handleVoiceResult = useCallback(async (text: string) => {
    if (!text) return
    setMessages(prev => [...prev, { role: 'user', content: text }])
    setError(undefined)

    setMessages(prev => [...prev, { role: 'assistant', content: '正在思考...' }])

    const result = await window.electronAPI.chat(text)

    setMessages(prev => {
      const next = [...prev]
      next[next.length - 1] = {
        role: 'assistant',
        content: result.error
          ? '秋山澪暂时无法回应，请稍后再试'
          : (result.reply || '')
      }
      return next
    })

    if (result.reply) {
      window.electronAPI.speak(result.reply).catch(() => {})
    }
  }, [])

  return (
    <div className="app">
      <ChatBubble messages={messages} />
      <StatusBar asrStatus={asrStatus} recording={recording} error={error} />
      <VoiceInput onResult={handleVoiceResult} disabled={!inputEnabled} />
    </div>
  )
}

export default App
