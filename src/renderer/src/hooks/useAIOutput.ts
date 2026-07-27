import { useEffect, useRef, useState, useCallback } from 'react'
import { playTTS, playTTSBuffer, onTTSStart, onTTSError } from '../components/audioShared'
import { useIPCEvent } from './useIPCEvent'
import { useTimerControl } from './useTimer'
import { useAgentStore } from '../store/agentStore'

export type { AgentState } from '../store/agentStore'

// ── 语音确认会话状态类型 ──
export type ConfirmFlowState =
  | 'idle'
  | 'awaiting_voice_confirm'
  | 'voice_confirmed'
  | 'voice_rejected'

interface ConfirmSessionInfo {
  intentName: string
  description: string
  confirmMessage: string
  toolSequence: Array<{ tool: string; args: Record<string, string> }>
  slots: Record<string, string>
}

export function useAIOutput(activeSessionId: string, voiceActive: boolean, onError?: (err: string | undefined) => void) {
  const store = useAgentStore()

  const fadeTimer = useTimerControl()
  const revealTimer = useTimerControl()

  // ── 多轮语音确认状态 ──
  const [confirmFlowState, setConfirmFlowState] = useState<ConfirmFlowState>('idle')
  const confirmSessionRef = useRef<ConfirmSessionInfo | null>(null)
  /** 同步跟踪确认结果（ref 避免 setState 异步问题） */
  const confirmResultRef = useRef<boolean | null>(null)

  /**
   * 启动语音确认会话（替代 blocking window.confirm）。
   * 返回 'pending' 表示语音确认会话已启动（等待后续语音输入）；
   * 返回 true/false 表示通过 fallback dialog 完成的确认结果。
   */
  const startVoiceConfirm = useCallback(async (info: ConfirmSessionInfo): Promise<boolean | 'pending'> => {
    confirmSessionRef.current = info
    confirmResultRef.current = null
    setConfirmFlowState('awaiting_voice_confirm')

    // 通知主进程启动确认会话
    try {
      await window.electronAPI.voiceConfirmStart({
        intentName: info.intentName,
        confirmMessage: info.confirmMessage,
        slots: info.slots,
        tools: info.toolSequence,
        timeoutMs: 30000,
      })
      // 语音确认已启动，等待后续语音输入
      return 'pending'
    } catch (err) {
      console.warn('[VoiceConfirm] start failed, falling back to dialog:', err)
      // fallback: blocking dialog
      const confirmed = window.confirm(
        `🎤 语音指令识别\n\n` +
        `意图: ${info.description}\n\n` +
        `${info.confirmMessage}\n\n` +
        `将执行 ${info.toolSequence.length} 个工具:\n` +
        info.toolSequence.map((s, i) => `  ${i + 1}. ${s.tool}`).join('\n') +
        `\n\n确认执行？`,
      )
      confirmResultRef.current = confirmed
      setConfirmFlowState(confirmed ? 'voice_confirmed' : 'voice_rejected')
      return confirmed
    }
  }, [])

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

  // 带 sessionId 的 message:new = 最终完整消息；无 sessionId 的（中间 tool 输出）不清除 streaming 状态
  useIPCEvent(window.electronAPI?.onMessageNew, (msg: { id: string; role: string; sessionId?: string }) => {
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

  useIPCEvent(window.electronAPI?.onToolStatus, (status: { type: string; tool: string; message: string }) => {
    store.setToolStatus(status)
  })

  /**
   * 执行工具链并展示结果
   */
  const executeIntentAndShow = useCallback(async (intentName: string, slots: Record<string, string>, description: string) => {
    store.setAgentState('tool_executing')
    store.setToolStatus({ type: 'start', tool: 'voice_chain', message: `执行: ${description}` })

    try {
      const execResult = await window.electronAPI.executeVoiceChain(intentName, slots)

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
          `[语音工具编排] ${description}\n结果:\n${resultText}`,
          undefined,
          activeSessionId || undefined,
          true, // noTts
        )
      } catch {
        /* chat may fail, results already shown */
      }
      fadeTimer.set(() => store.resetAgent(), 15000)
    } catch (err) {
      console.error('[VoiceOrch] execute error:', err)
      store.setAgentState('replying')
      store.appendPendingText(`❌ 工具执行失败: ${String(err)}`)
      fadeTimer.set(() => store.resetAgent(), 15000)
    }
  }, [activeSessionId, store, fadeTimer])

  const handleResult = async (t: string) => {
    if (!t) return

    // ── 检查是否有活跃的语音确认会话 ──
    if (confirmFlowState === 'awaiting_voice_confirm' && confirmSessionRef.current) {
      try {
        const feedResult = await window.electronAPI.voiceConfirmFeed(t)
        if (feedResult.success) {
          if (feedResult.result === 'confirmed') {
            setConfirmFlowState('voice_confirmed')
            const info = confirmSessionRef.current
            confirmSessionRef.current = null
            store.setTranscribed(t)
            await executeIntentAndShow(info.intentName, info.slots, info.description)
            return
          } else if (feedResult.result === 'rejected') {
            setConfirmFlowState('voice_rejected')
            confirmSessionRef.current = null
            store.setTranscribed(t)
            store.setToolStatus({ type: 'info', tool: 'voice_chain', message: '操作已取消' })
            return
          }
          // 'pending' 状态仍在等待确认，继续监听
          store.setTranscribed(t)
          return
        }
      } catch (err) {
        console.warn('[VoiceConfirm] feed error, falling back:', err)
        // fallback: try window.confirm
        confirmSessionRef.current = null
        setConfirmFlowState('idle')
      }
    }

    store.setTranscribed(t)
    onError?.(undefined)
    store.setPendingText('')
    store.setDisplayText('')
    revealTimer.clear()

    // ── 语音工具编排（关键词 + LLM fallback）──
    try {
      const intentResult = await window.electronAPI.matchVoiceIntent(t, true /* useLlmFallback */)
      if (intentResult.matched && intentResult.intent) {
        const intent = intentResult.intent
        const needConfirm = true // 默认需要确认

        if (needConfirm) {
          // 尝试使用语音确认会话
          const info: ConfirmSessionInfo = {
            intentName: intent.name,
            description: intent.description,
            confirmMessage: intent.confirmMessage,
            toolSequence: intent.toolSequence,
            slots: intent.slots,
          }
          const confirmResult = await startVoiceConfirm(info)
          // startVoiceConfirm 返回 'pending' 表示语音确认会话已启动
          if (confirmResult === 'pending') {
            store.setToolStatus({
              type: 'info',
              tool: 'voice_chain',
              message: `请确认：${intent.confirmMessage}`,
            })
            return
          }
          // 返回 true/false 表示 window.confirm 的结果
          if (confirmResult === true) {
            setConfirmFlowState('idle')
            await executeIntentAndShow(intent.name, intent.slots, intent.description)
            return
          }
          // confirmResult === false：用户取消
          setConfirmFlowState('idle')
          store.setToolStatus({ type: 'info', tool: 'voice_chain', message: '操作已取消' })
          // 回退到普通聊天
          store.setAgentState('thinking')
        } else {
          // 无需确认，直接执行
          await executeIntentAndShow(intent.name, intent.slots, intent.description)
          return
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
    confirmFlowState,
    handleResult,
  } as const
}
