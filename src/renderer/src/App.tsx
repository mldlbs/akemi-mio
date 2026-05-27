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
  const [error, setError] = useState<string | undefined>()
  const [conversationActive, setConversationActive] = useState(false)
  const [inputEnabled, setInputEnabled] = useState(false)

  useEffect(() => {
    window.electronAPI.getState().then((state) => {
      setAsrStatus(state.asr)
      if (state.asr === 'ready') setInputEnabled(true)
    })

    const cleanup = window.electronAPI.onStateUpdate((state) => {
      if (state.asr) setAsrStatus(state.asr as string)
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
          ? errorMessage(result.error)
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
      <StatusBar asrStatus={asrStatus} conversationActive={conversationActive} error={error} />
      <VoiceInput onResult={handleVoiceResult} onConversationChange={setConversationActive} disabled={!inputEnabled} />
    </div>
  )
}

function errorMessage(code: string): string {
  switch (code) {
    case 'NO_KEY': return '请在终端设置 OPENROUTER_API_KEY 后再试'
    case 'INVALID_KEY': return 'API Key 无效，请检查 OPENROUTER_API_KEY'
    case 'RATE_LIMITED': return '请求太频繁，请稍后重试'
    case 'TIMEOUT': return 'AI 响应超时，请稍后重试'
    case 'NETWORK': return '网络连接失败，请检查网络'
    default: return `秋山澪暂时无法回应 (${code})`
  }
}

export default App
