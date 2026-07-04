import { useEffect } from 'react'
import { playTTS, playTTSBuffer, onTTSStart, onTTSError } from '../components/audioShared'
import { useIPCEvent } from './useIPCEvent'
import { useTimerControl } from './useTimer'
import { useAgentStore } from '../store/agentStore'

export type { AgentState } from '../store/agentStore'

export function useAIOutput(activeSessionId: string, voiceActive: boolean, onError?: (err: string | undefined) => void) {
  const store = useAgentStore()

  const fadeTimer = useTimerControl()
  const revealTimer = useTimerControl()

  // 切换会话时立即清空所有 streaming 状态
  useEffect(() => {
    store.resetAgent()
    revealTimer.clear()
    fadeTimer.clear()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId])

  // TTS display reveal (mount-only)
  useEffect(() => {
    const onStart = (duration: number) => {
      const t = store.pendingText
      if (!t) return
      revealTimer.clear()
      store.setDisplayText('')
      const totalMs = duration * 1000
      const intervalMs = Math.max(20, totalMs / t.length)
      let i = 0
      revealTimer.setInterval(() => {
        i++
        store.setDisplayText(t.slice(0, i))
        if (i >= t.length) revealTimer.clear()
      }, intervalMs)
    }
    const onErr = (err: string) => {
      onError?.(err)
    }
    onTTSStart(onStart)
    onTTSError(onErr)
    return () => {
      revealTimer.clear()
      fadeTimer.clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useIPCEvent(window.electronAPI.onAIChunk, (chunk: string) => {
    store.appendPendingText(chunk)
    fadeTimer.clear()
  })

  useIPCEvent(window.electronAPI.onTTSAudio, (filePath: string) => {
    playTTS(filePath)
  })
  useIPCEvent(window.electronAPI.onTTSBuffer, (buf: ArrayBuffer) => {
    playTTSBuffer(buf)
  })

  // 带 sessionId 的 message:new = 最终完整消息；无 sessionId 的（中间 tool 输出）不清除 streaming 状态
  useIPCEvent(window.electronAPI.onMessageNew, (msg: { id: string; role: string; sessionId?: string }) => {
    if (msg.sessionId && msg.role === 'assistant') {
      store.resetAgent()
      revealTimer.clear()
    }
  })

  useIPCEvent(window.electronAPI.onToolStatus, (status: { type: string; tool: string; message: string }) => {
    store.setToolStatus(status)
  })

  const handleResult = async (t: string) => {
    if (!t) return
    store.setTranscribed(t)
    store.setAgentState('thinking')
    onError?.(undefined)
    store.setPendingText('')
    store.setDisplayText('')
    revealTimer.clear()
    try {
      await window.electronAPI.chat(t, undefined, activeSessionId || undefined, !voiceActive)
    } catch (err) {
      onError?.(String(err))
    }
    fadeTimer.set(() => {
      store.resetAgent()
    }, 10000)
  }

  return {
    pendingText: store.pendingText,
    displayText: store.displayText,
    transcribed: store.transcribed,
    toolStatus: store.toolStatus,
    agentState: store.agentState,
    handleResult,
  } as const
}
