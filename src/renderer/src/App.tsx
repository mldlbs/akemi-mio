import { useState, useEffect, useCallback, useRef } from 'react'
import { VoiceInput } from './components/VoiceInput'
import { ChatBubble } from './components/ChatBubble'
import { StatusBar } from './components/StatusBar'
import './App.css'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

function cleanReply(text: string): string {
  return text
    .replace(/\*{1,2}(.*?)\*{1,2}/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
    .replace(/[～~]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function App() {
  const [messages, setMessages] = useState<Message[]>([])
  const [error, setError] = useState<string | undefined>()
  const [conversationActive, setConversationActive] = useState(false)
  const [ttsPlaying, setTtsPlaying] = useState(false)
  const lastAssistantIdx = useRef(-1)
  const streamingRef = useRef('')
  const unsubChunkRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const cleanup = window.electronAPI.onStateUpdate((state) => {
      if (state.error) setError(state.error as string)
      if (state.ttsPlaying !== undefined) setTtsPlaying(state.ttsPlaying as boolean)
    })

    return cleanup
  }, [])

  useEffect(() => {
    unsubChunkRef.current = window.electronAPI.onAIChunk((chunk) => {
      streamingRef.current += chunk
      setMessages(prev => {
        const next = [...prev]
        if (lastAssistantIdx.current >= 0 && lastAssistantIdx.current < next.length) {
          next[lastAssistantIdx.current] = {
            role: 'assistant',
            content: streamingRef.current
          }
        }
        return next
      })
    })

    return () => unsubChunkRef.current?.()
  }, [])

  const handleVoiceResult = useCallback(async (text: string) => {
    if (!text) return
    setMessages(prev => [...prev, { role: 'user', content: text }])
    setError(undefined)

    streamingRef.current = ''
    lastAssistantIdx.current = messages.length + 1
    setMessages(prev => [...prev, { role: 'assistant', content: '' }])

    const result = await window.electronAPI.chat(text)

    const finalContent = result.error
      ? errorMessage(result.error)
      : cleanReply(result.reply || '')

    streamingRef.current = finalContent
    setMessages(prev => {
      const next = [...prev]
      if (lastAssistantIdx.current >= 0 && lastAssistantIdx.current < next.length) {
        next[lastAssistantIdx.current] = { role: 'assistant', content: finalContent }
      }
      return next
    })

    if (result.reply) {
      // TTS handled during streaming in main process
    }
  }, [messages.length])

  return (
    <div className="app">
      <ChatBubble messages={messages} />
      <StatusBar conversationActive={conversationActive} ttsPlaying={ttsPlaying} error={error} />
      <VoiceInput onResult={handleVoiceResult} onConversationChange={setConversationActive} ttsPlaying={ttsPlaying} />
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
