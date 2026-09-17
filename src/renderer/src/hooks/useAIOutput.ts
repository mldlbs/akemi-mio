import { useCallback, useEffect, useRef, useState } from 'react'
import { playTTS, playTTSBuffer, onTTSStart, onTTSError } from '../components/audioShared'
import { useIPCEvent } from './useIPCEvent'
import { useTimerControl } from './useTimer'
import { useAgentStore } from '../store/agentStore'
import { chatErrorText } from '../lib/chatErrorText'

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

/**
 * 需要「把原文还回输入框」的错误码 —— 判据是**用户消息根本没落库**，不是「失败了」。
 *
 * `InputBar.handleSend` 在调用 `onSend` 之后立刻 `setValue('')`，输入框是组件内部 state，
 * 上层拿不到原文。所以一旦提交被拒，用户刚打的字就没了 —— 而 `BUSY` 恰恰是最容易撞上的：
 * 上一轮还在跑时按 Enter（`InputBar` 忙碌时只把发送键换成停止键，**不禁用 textarea**，
 * `handleKeyDown` 的 Enter 照样走 `handleSend`）。
 *
 * 三个码都在「任何副作用之前」返回：
 * - `BUSY` —— `ChatExecutor.run()` 顶部的重入守卫（packages/intelligence/src/agent/ChatExecutor.ts）
 * - `CIRCUIT_OPEN` —— `AgentService.processTextInput` 的第一件事就是熔断检查，同样早于 `run()`
 * - `PAUSED` —— `packages/main/src/ipc/handlers/agent.ts` 的 `ai:chat` handler 在调用
 *   `processTextInput` 之前直接返回
 *
 * 其余码（TIMEOUT / NETWORK / NO_KEY / EMPTY_RESPONSE / API_ERROR:5xx …）都在 `run()` **内部**
 * 产出，那时 `insertMessage(userMsg)` 已经执行过 —— 消息已经在历史里了，
 * 再回填只会让用户重发一遍，所以**不能**放进这个表。
 */
export const REJECTED_BEFORE_RUN: ReadonlySet<string> = new Set(['BUSY', 'CIRCUIT_OPEN', 'PAUSED'])

/**
 * 待回填进输入框的草稿。
 *
 * `token` 单调递增：同一条文本被连拒两次时，纯字符串 prop 前后相同，
 * `InputBar` 的 effect 不会重跑（用户会发现第二次没有回填）。
 */
export interface RestoreDraft {
  text: string
  token: number
}

export function useAIOutput(activeSessionId: string, voiceActive: boolean, onError?: (err: string | undefined) => void) {
  const store = useAgentStore()
  const [voiceIntentPrompt, setVoiceIntentPrompt] = useState<VoiceIntentPrompt | null>(null)
  const [restoreDraft, setRestoreDraft] = useState<RestoreDraft | null>(null)
  const restoreTokenRef = useRef(0)

  const fadeTimer = useTimerControl()
  const revealTimer = useTimerControl()

  useEffect(() => {
    store.resetAgent()
    setVoiceIntentPrompt(null)
    // 换会话时丢掉待回填的草稿：否则新会话的 InputBar 一挂载就会把旧会话的草稿塞进去
    setRestoreDraft(null)
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
      setRestoreDraft(null)
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
    async (text: string, restoreOnReject = false) => {
      store.setAgentState('thinking')
      try {
        const result = await window.electronAPI.chat(text, undefined, activeSessionId || undefined, !voiceActive)
        // 主进程用「正常 resolve + error 字段」表达失败（熔断 / 内部错误 / 暂停…），
        // 不接返回值就等于把这些错误静默吞掉 —— 用户只会看到「思考中」然后消失。
        const message = chatErrorText(result?.error)
        if (message) onError?.(message)

        // 本轮根本没被受理（消息未落库）→ 输入框里的原文已经被 handleSend 清掉了，还回去。
        // 注意只对文本提交做：语音的原文不该塞回文本框（那不是用户「打的字」）。
        if (restoreOnReject && result?.error && REJECTED_BEFORE_RUN.has(result.error)) {
          restoreTokenRef.current += 1
          setRestoreDraft({ text, token: restoreTokenRef.current })
        }
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
      await sendChat(text, true)
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
    restoreDraft,
    handleTextSubmit,
    handleVoiceResult,
    confirmVoiceIntent,
    sendVoiceIntentAsChat,
    dismissVoiceIntent,
  } as const
}
