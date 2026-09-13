/**
 * 宠物小人形态的根组件。
 *
 * 形态定位：常驻桌面的小形象。它不承担完整会话职能 ——
 * 复杂对话交给"对话框形态"，它只负责"在场感"：状态可见、随手能戳、随口能说。
 *
 * 因此这里只做三件事：
 * 1. 用情绪 + 动作表达当前状态（来自主进程或其他形态的广播）。
 * 2. 提供最小交互：拖拽移动、双击唤起对话框、悬停工具条。
 * 3. 可选鼠标穿透 —— 让用户能在小人身上点击底下的桌面图标。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { PetAvatar } from './PetAvatar'
import type { PetGesture, PetMood } from '../types'
import {
  broadcast,
  hasFormBridge,
  onAgentActivity,
  onBroadcast,
  setFormVisible,
  setIgnoreMouseEvents,
} from '../runtime'
import { toolLabel } from '../types'
import './styles.css'

/** 情绪自动回落：临时情绪（happy/alert）展示一段时间后回到 idle，
 *  否则小人会永远咧着嘴笑，反而不像"有反应"而像坏了。 */
const MOOD_HOLD_MS = 4200

/** 空闲多久后打瞌睡。桌面宠物最讨喜的细节就是这个。 */
const SLEEPY_AFTER_MS = 45_000

export function PetForm() {
  const [mood, setMood] = useState<PetMood>('idle')
  const [gesture, setGesture] = useState<PetGesture | null>(null)
  const [bubble, setBubble] = useState<string | null>(null)
  const [passthrough, setPassthrough] = useState(false)

  const moodTimerRef = useRef<number | null>(null)
  const sleepyTimerRef = useRef<number | null>(null)
  const bubbleTimerRef = useRef<number | null>(null)

  // ── 空闲进入 sleepy ──
  const resetIdleTimer = useCallback(() => {
    if (sleepyTimerRef.current !== null) window.clearTimeout(sleepyTimerRef.current)
    sleepyTimerRef.current = window.setTimeout(() => {
      setMood((cur) => (cur === 'idle' ? 'sleepy' : cur))
    }, SLEEPY_AFTER_MS)
  }, [])

  /** 设置临时情绪，并在 MOOD_HOLD_MS 后回落 idle。idle/sleepy 为稳定态，不参与回落。 */
  const setTransientMood = useCallback((next: PetMood) => {
    setMood(next)
    if (moodTimerRef.current !== null) window.clearTimeout(moodTimerRef.current)
    if (next === 'idle' || next === 'sleepy') return
    moodTimerRef.current = window.setTimeout(() => setMood('idle'), MOOD_HOLD_MS)
  }, [])

  const say = useCallback((text: string, durationMs = 5200) => {
    setBubble(text)
    if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current)
    bubbleTimerRef.current = window.setTimeout(() => setBubble(null), durationMs)
  }, [])

  // ── 交互唤醒：任何鼠标活动都重置瞌睡计时 ──
  useEffect(() => {
    resetIdleTimer()
    const onActivity = () => {
      setMood((cur) => (cur === 'sleepy' ? 'idle' : cur))
      resetIdleTimer()
    }
    window.addEventListener('pointermove', onActivity)
    window.addEventListener('pointerdown', onActivity)
    return () => {
      window.removeEventListener('pointermove', onActivity)
      window.removeEventListener('pointerdown', onActivity)
      if (sleepyTimerRef.current !== null) window.clearTimeout(sleepyTimerRef.current)
      if (moodTimerRef.current !== null) window.clearTimeout(moodTimerRef.current)
      if (bubbleTimerRef.current !== null) window.clearTimeout(bubbleTimerRef.current)
    }
  }, [resetIdleTimer])

  // ── 订阅其他形态广播：对话框形态开始生成 → 小人进入 thinking ──
  useEffect(() => {
    return onBroadcast((msg) => {
      if (msg.from === 'pet') return
      switch (msg.type) {
        case 'chat:thinking':
          setTransientMood('thinking')
          break
        case 'chat:reply':
          setTransientMood('happy')
          setGesture('bounce')
          if (typeof msg.payload === 'string') say(msg.payload, 6000)
          break
        case 'chat:error':
          setTransientMood('alert')
          if (typeof msg.payload === 'string') say(msg.payload, 6000)
          break
        case 'wallpaper:mood': {
          // 壁纸形态若主动播报情绪，小人跟随
          const p = msg.payload as { mood?: PetMood } | undefined
          if (p?.mood) setTransientMood(p.mood)
          break
        }
        default:
          break
      }
    })
  }, [say, setTransientMood])

  // ── 订阅真实 Agent 活动 ──
  //
  // 与上面的形态间广播（chat:thinking 等，属于"形态自己说的话"）不同，
  // 这一路是**真实对话流的镜像**：主窗口收到 ai:chunk / tool:status 后转发过来。
  // 宠物因此能反映真实工作状态，而不只是形态间自娱自乐。
  useEffect(() => {
    // ai:chunk 是逐块流式的（几十毫秒一块），若每块都 say() 会导致
    // 气泡疯狂闪烁、且把 streaming 文本整段重复弹出。因此累积到
    // 静默 700ms 才认为是"说完了"，只展示最终结果。
    let pending = ''
    let flushTimer: number | null = null

    const flush = () => {
      flushTimer = null
      const text = pending.trim()
      pending = ''
      if (!text) return
      // 过长的回复不适合塞进小气泡，截断并加省略号
      const shown = text.length > 90 ? `${text.slice(0, 90)}…` : text
      say(shown, 7000)
    }

    return onAgentActivity((activity) => {
      switch (activity.kind) {
        case 'thinking':
          setTransientMood('thinking')
          break

        case 'tool': {
          // 工具调用是"正在干活"的明确信号
          setTransientMood('thinking')
          const label = activity.text ? toolLabel(activity.text) : ''
          if (label) say(`${label}…`, 4000)
          break
        }

        case 'speaking':
          pending += activity.text
          if (flushTimer !== null) window.clearTimeout(flushTimer)
          flushTimer = window.setTimeout(flush, 700)
          break

        case 'done':
          // 收尾：若有未 flush 的文本立即展示，并露出"完成"的表情
          if (flushTimer !== null) {
            window.clearTimeout(flushTimer)
            flushTimer = null
          }
          if (pending.trim()) {
            flush()
          } else {
            setTransientMood('happy')
            setGesture('bounce')
          }
          break

        case 'error':
          setTransientMood('alert')
          if (activity.text) say(activity.text, 6000)
          break

        default:
          break
      }
    })
  }, [say, setTransientMood])

  // ── 点击行为 ──
  const handleDoubleClick = useCallback(() => {
    setGesture('wave')
    broadcast('pet:summon-chat', null)
    void setFormVisible('chat', true)
  }, [])

  const handleClick = useCallback(() => {
    if (mood === 'sleepy') {
      setTransientMood('idle')
      say('唔……醒了。')
      return
    }
    setGesture('bounce')
    setTransientMood('happy')
    broadcast('pet:poked', null)
  }, [mood, say, setTransientMood])

  const togglePassthrough = useCallback(() => {
    setPassthrough((prev) => {
      const next = !prev
      void setIgnoreMouseEvents(next)
      return next
    })
  }, [])

  return (
    <div
      className={`pet-stage ${passthrough ? 'pet-passthrough' : ''}`}
      onDoubleClick={handleDoubleClick}
      onClick={handleClick}
      title="单击互动 · 双击打开对话框 · 拖拽移动"
    >
      {/* 悬停工具条：常驻会挡住小人，所以只在靠近时浮现 */}
      <div className="pet-toolbar form-no-drag" onClick={(e) => e.stopPropagation()}>
        <button
          className={`pet-tool-btn ${passthrough ? 'is-active' : ''}`}
          onClick={togglePassthrough}
          title={passthrough ? '恢复鼠标交互' : '开启鼠标穿透（点到下面的桌面）'}
          aria-label={passthrough ? '恢复鼠标交互' : '开启鼠标穿透'}
        >
          {passthrough ? '◌' : '◉'}
        </button>
        <button
          className="pet-tool-btn"
          onClick={() => {
            setGesture('wave')
            broadcast('pet:summon-chat', null)
            void setFormVisible('chat', true)
          }}
          title="打开对话框"
          aria-label="打开对话框"
        >
          ✦
        </button>
        <button
          className="pet-tool-btn"
          onClick={() => void setFormVisible('pet', false)}
          title="隐藏小人（可在设置里恢复）"
          aria-label="隐藏小人"
        >
          ✕
        </button>
      </div>

      {bubble && <div className="pet-bubble">{bubble}</div>}

      <PetAvatar mood={mood} gesture={gesture} onGestureEnd={() => setGesture(null)} />

      {!hasFormBridge() && <div className="form-degraded-banner">预览模式：未接入桌面窗口</div>}
    </div>
  )
}
