import { useEffect, useRef } from 'react'
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

  // ai:chunk 合并节流：16ms 窗口内只触发一次 React 更新
  const chunkBufRef = useRef('')
  const chunkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useIPCEvent(window.electronAPI.onAIChunk, (chunk: string) => {
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

  useIPCEvent(window.electronAPI.onTTSAudio, (filePath: string) => {
    playTTS(filePath)
  })
  useIPCEvent(window.electronAPI.onTTSBuffer, (buf: ArrayBuffer) => {
    playTTSBuffer(buf)
  })

  // 带 sessionId 的 message:new = 最终完整消息；无 sessionId 的（中间 tool 输出）不清除 streaming 状态
  useIPCEvent(window.electronAPI.onMessageNew, (msg: { id: string; role: string; sessionId?: string }) => {
    if (msg.sessionId && msg.role === 'assistant') {
      // flush 残留 chunk 再重置
      if (chunkBufRef.current) {
        store.appendPendingText(chunkBufRef.current)
        chunkBufRef.current = ''
      }
      if (chunkTimerRef.current) {
        clearInterval(chunkTimerRef.current)
        chunkTimerRef.current = null
      }
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
    onError?.(undefined)
    store.setPendingText('')
    store.setDisplayText('')
    revealTimer.clear()

    // ── 语音工具编排：检查是否匹配工具意图 ──
    try {
      const intentResult = await window.electronAPI.matchVoiceIntent(t)
      if (intentResult.matched && intentResult.intent) {
        const confirmed = window.confirm(
          `🎤 语音指令识别\n\n` +
            `意图: ${intentResult.intent.description}\n\n` +
            `${intentResult.intent.confirmMessage}\n\n` +
            `将执行 ${intentResult.intent.toolSequence.length} 个工具:\n` +
            intentResult.intent.toolSequence.map((s, i) => `  ${i + 1}. ${s.tool}`).join('\n') +
            `\n\n确认执行？`,
        )
        if (confirmed) {
          store.setAgentState('tool_executing')
          store.setToolStatus({ type: 'start', tool: 'voice_chain', message: `执行: ${intentResult.intent.description}` })

          const execResult = await window.electronAPI.executeVoiceChain(intentResult.intent.name, intentResult.intent.slots)

          // 展示执行结果
          const resultLines: string[] = []
          for (const step of execResult.steps) {
            const icon = step.success ? '✅' : '❌'
            resultLines.push(`${icon} ${step.tool} (${step.durationMs}ms)`)
            if (step.error) resultLines.push(`   错误: ${step.error}`)
            if (step.output && step.output.length < 500) {
              resultLines.push(`   ${step.output.split('\n').slice(0, 3).join('\n')}`)
            }
          }
          const resultText = resultLines.join('\n')
          store.setAgentState('replying')
          store.appendPendingText(`🔧 工具执行完成:\n${resultText}`)

          // 也作为消息发送
          try {
            await window.electronAPI.chat(
              `[语音工具编排] ${intentResult.intent.description}\n结果:\n${resultText}`,
              undefined,
              activeSessionId || undefined,
              true, // noTts
            )
          } catch {
            /* chat may fail, results already shown */
          }
          fadeTimer.set(() => store.resetAgent(), 15000)
          return
        } else {
          // 用户取消，回退到普通聊天
          store.setAgentState('thinking')
        }
      }
    } catch (err) {
      // 意图匹配失败静默回退到普通聊天
      console.warn('[VoiceOrch] intent match error:', err)
    }

    // ── 普通聊天流程 ──
    store.setAgentState('thinking')
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
