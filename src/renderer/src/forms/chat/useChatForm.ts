/**
 * 对话框形态的会话逻辑。
 *
 * 与主壳（src/renderer/src）的关系：**刻意不复用**。
 * 主壳承载完整工作台（多 slot、工作流、博客、设备状态…），依赖树很重；
 * 对话框形态的定位是"随手问一句"，把它挂在主壳的 store/hook 上会带来
 * 大量无谓依赖，也容易因为主壳某个 hook 报错而整窗白屏。
 * 因此这里维护一个自包含的、极小的会话状态机。
 *
 * 消息如何真正送达后端：通过 existing 的 Electron 桥（window.electronAPI）。
 * 若桥不可用（浏览器预览），退化为本地回声，保证 UI 可演示。
 */

import { useCallback, useRef, useState } from 'react'
import { broadcast } from '../runtime'
import type { FormMessage } from '../types'

/** 桥接形状的宽松声明：只声明本形态用到的那部分，避免耦合主壳的完整类型。 */
interface LooseBridge {
  sendMessage?: (payload: unknown) => Promise<unknown> | unknown
  invoke?: (channel: string, payload?: unknown) => Promise<unknown>
}

function readBridge(): LooseBridge | null {
  const w = window as unknown as { electronAPI?: LooseBridge; electron?: LooseBridge }
  return w.electronAPI ?? w.electron ?? null
}

let seq = 0
function nextId(): string {
  seq += 1
  return `fmsg_${Date.now()}_${seq}`
}

export interface ChatFormState {
  messages: FormMessage[]
  sending: boolean
  /** 一键清空会话 */
  clear: () => void
  /** 发送一条用户消息 */
  send: (text: string) => Promise<void>
}

export function useChatForm(): ChatFormState {
  const [messages, setMessages] = useState<FormMessage[]>([])
  const [sending, setSending] = useState(false)
  // 用 ref 记录流式回复的 id，避免闭包拿到旧的 messages
  const streamingIdRef = useRef<string | null>(null)

  const appendAssistantText = useCallback((id: string, chunk: string) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text: m.text + chunk } : m)))
  }, [])

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || sending) return

      const userMsg: FormMessage = { id: nextId(), role: 'user', text: trimmed, at: Date.now() }
      setMessages((prev) => [...prev, userMsg])
      setSending(true)

      // 通知其他形态：小人在思考
      broadcast('chat:thinking', null)

      const replyId = nextId()
      streamingIdRef.current = replyId
      setMessages((prev) => [...prev, { id: replyId, role: 'assistant', text: '', at: Date.now(), streaming: true }])

      const bridge = readBridge()
      try {
        if (bridge?.invoke) {
          const result = await bridge.invoke('chat:send', { text: trimmed, form: 'chat' })
          const reply =
            typeof result === 'string'
              ? result
              : ((result as { text?: string; content?: string } | null)?.text ?? (result as { content?: string } | null)?.content ?? '')
          if (reply) appendAssistantText(replyId, reply)
        } else {
          // 降级：桥不可用时给一个本地回声，让 UI 流程完整可演示
          await new Promise((r) => setTimeout(r, 320))
          appendAssistantText(replyId, `（预览模式，未连接后端）收到：${trimmed}`)
        }
        broadcast('chat:reply', undefined)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        appendAssistantText(replyId, `\n[出错了] ${msg}`)
        broadcast('chat:error', `出错了：${msg}`)
      } finally {
        setMessages((prev) => prev.map((m) => (m.id === replyId ? { ...m, streaming: false } : m)))
        streamingIdRef.current = null
        setSending(false)
      }
    },
    [appendAssistantText, sending],
  )

  const clear = useCallback(() => {
    setMessages([])
    streamingIdRef.current = null
  }, [])

  return { messages, sending, clear, send }
}
