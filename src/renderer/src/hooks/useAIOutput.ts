import { useCallback, useEffect, useRef, useState } from 'react'
import { playTTS, playTTSBuffer, onTTSStart, onTTSError } from '../components/audioShared'
import { useIPCEvent } from './useIPCEvent'
import { useTimerControl } from './useTimer'
import { useAgentStore } from '../store/agentStore'

export type { AgentState } from '../store/agentStore'

interface VoiceIntentMatch {
  name: string
  description: string
  confirmMessage: string
  toolSequence: Array<{ tool: string; args: Record<string, string> }>
  slots: Record<string, string>
}

export interface VoiceIntentPrompt {
  text: string
  intent: VoiceIntentMatch
}

export function useAIOutput(activeSessionId: string, voiceActive: boolean, onError?: (err: string | undefined) => void) {
  const store = useAgentStore()
  const [voiceIntentPrompt, setVoiceIntentPrompt] = useState<VoiceIntentPrompt | null>(null)

  const fadeTimer = useTimerControl()
  const revealTimer = useTimerControl()

  useEffect(() => {
    store.resetAgent()
    setVoiceIntentPrompt(null)
    revealTimer.clear()
    fadeTimer.clear()
  }, [activeSessionId])

  useEffect(() => {
    const onStart = (duration: number) => {
      const text = store.pendingText
      if (!text) return
      revealTimer.clear()
      store.setDisplayText('')
      const totalMs = duration * 1000
      const intervalMs = Math.max(20, totalMs / text.length)
      let index = 0
      revealTimer.setInterval(() => {
        index++
        store.setDisplayText(text.slice(0, index))
        if (index >= text.length) revealTimer.clear()
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
  }, [])

  const chunkBufRef = useRef('')
  const chunkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useIPCEvent(window.electronAPI?.onAIChunk, (chunk: string) => {
    chunkBufRef.current += chunk
    fadeTimer.clear()
    if (!chunkTimerRef.current) {
      chunkTimerRef.current = setInterval(() => {
        if (chunkBufRef.current) {
          store.appendPendingText(chunkBufRef.current)
          chunkBufRef.current = ''
        } else if (chunkTimerRef.current) {
          clearInterval(chunkTimerRef.current)
          chunkTimerRef.current = null
        }
      }, 16)
    }
  })

  useIPCEvent(window.electronAPI?.onTTSAudio, (filePath: string) => {
    playTTS(filePath)
  })

  useIPCEvent(window.electronAPI?.onTTSBuffer, (buf: ArrayBuffer) => {
    playTTSBuffer(buf)
  })

  useIPCEvent(window.electronAPI?.onMessageNew, (msg: { id: string; role: string; sessionId?: string }) => {
    if (msg.sessionId && msg.role === 'assistant') {
      if (chunkBufRef.current) {
        store.appendPendingText(chunkBufRef.current)
        chunkBufRef.current = ''
      }
      if (chunkTimerRef.current) {
        clearInterval(chunkTimerRef.current)
        chunkTimerRef.current = null
      }
      store.resetAgent()
      setVoiceIntentPrompt(null)
      revealTimer.clear()
    }
  })

  useIPCEvent(window.electronAPI?.onToolStatus, (status: { type: string; tool: string; message: string }) => {
    store.setToolStatus(status)
  })

  const clearSubmissionState = useCallback(
    (text: string, source: 'text' | 'voice') => {
      if (!text) return false
      store.setTranscribed(source === 'voice' ? text : '')
      setVoiceIntentPrompt(null)
      onError?.(undefined)
      store.setPendingText('')
      store.setDisplayText('')
      revealTimer.clear()
      return true
    },
    [onError, revealTimer, store],
  )

  const scheduleReset = useCallback(
    (delayMs: number) => {
      fadeTimer.set(() => {
        store.resetAgent()
      }, delayMs)
    },
    [fadeTimer, store],
  )

  const sendChat = useCallback(
    async (text: string) => {
      store.setAgentState('thinking')
      try {
        await window.electronAPI.chat(text, undefined, activeSessionId || undefined, !voiceActive)
      } catch (err) {
        onError?.(String(err))
      }
      scheduleReset(10000)
    },
    [activeSessionId, onError, scheduleReset, store, voiceActive],
  )

  const buildVoiceExecutionText = useCallback(
    (steps: Array<{ tool: string; success: boolean; output: string; error?: string; durationMs: number }>) => {
      const lines: string[] = []
      for (const step of steps) {
        const icon = step.success ? '✓' : '✕'
        lines.push(`${icon} ${step.tool} (${step.durationMs}ms)`)
        if (step.error) lines.push(`   错误: ${step.error}`)
        if (step.output && step.output.length < 500) {
          lines.push(`   ${step.output.split('\n').slice(0, 3).join('\n')}`)
        }
      }
      return lines.join('\n')
    },
    [],
  )

  const executeVoiceIntent = useCallback(
    async (prompt: VoiceIntentPrompt) => {
      store.setAgentState('tool_executing')
      store.setToolStatus({ type: 'start', tool: 'voice_chain', message: `执行: ${prompt.intent.description}` })

      const execResult = await window.electronAPI.executeVoiceChain(prompt.intent.name, prompt.intent.slots)
      const resultText = buildVoiceExecutionText(execResult.steps)

      store.setAgentState('replying')
      store.appendPendingText(`🔧 工具执行完成:\n${resultText}`)

      try {
        await window.electronAPI.chat(
          `[语音工具编排] ${prompt.intent.description}\n结果:\n${resultText}`,
          undefined,
          activeSessionId || undefined,
          true,
        )
      } catch {
        /* results are already visible in the UI */
      }

      scheduleReset(15000)
    },
    [activeSessionId, buildVoiceExecutionText, scheduleReset, store],
  )

  const handleTextSubmit = useCallback(
    async (text: string) => {
      if (!clearSubmissionState(text, 'text')) return
      await sendChat(text)
    },
    [clearSubmissionState, sendChat],
  )

  const handleVoiceResult = useCallback(
    async (text: string) => {
      if (!clearSubmissionState(text, 'voice')) return

      try {
        const intentResult = await window.electronAPI.matchVoiceIntent(text)
        if (intentResult.matched && intentResult.intent) {
          setVoiceIntentPrompt({ text, intent: intentResult.intent })
          return
        }
      } catch (err) {
        console.warn('[VoiceOrch] intent match error:', err)
      }

      await sendChat(text)
    },
    [clearSubmissionState, sendChat],
  )

  const confirmVoiceIntent = useCallback(async () => {
    if (!voiceIntentPrompt) return
    setVoiceIntentPrompt(null)
    await executeVoiceIntent(voiceIntentPrompt)
  }, [executeVoiceIntent, voiceIntentPrompt])

  const sendVoiceIntentAsChat = useCallback(async () => {
    if (!voiceIntentPrompt) return
    if (!clearSubmissionState(voiceIntentPrompt.text, 'voice')) return
    await sendChat(voiceIntentPrompt.text)
  }, [clearSubmissionState, sendChat, voiceIntentPrompt])

  const dismissVoiceIntent = useCallback(() => {
    setVoiceIntentPrompt(null)
  }, [])

  return {
    pendingText: store.pendingText,
    displayText: store.displayText,
    transcribed: store.transcribed,
    toolStatus: store.toolStatus,
    agentState: store.agentState,
    voiceIntentPrompt,
    handleTextSubmit,
    handleVoiceResult,
    confirmVoiceIntent,
    sendVoiceIntentAsChat,
    dismissVoiceIntent,
  } as const
}
