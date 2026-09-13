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

/** 单击判定的延迟。太短的话双击仍会被算成两次单击（系统双击阈值在数百毫秒量级）。 */
const CLICK_DEBOUNCE_MS = 250

export function PetForm() {
  const [mood, setMood] = useState<PetMood>('idle')
  const [gesture, setGesture] = useState<PetGesture | null>(null)
  const [bubble, setBubble] = useState<string | null>(null)
  const [passthrough, setPassthrough] = useState(false)

  const moodTimerRef = useRef<number | null>(null)
  const sleepyTimerRef = useRef<number | null>(null)
  const bubbleTimerRef = useRef<number | null>(null)
  /** 单击延迟执行的句柄。dblclick 到达时取消，见 handleClick 的注释。 */
  const clickTimerRef = useRef<number | null>(null)
  /** 最后一次指针位置。开启穿透的瞬间要靠它立即命中测试一次。 */
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null)

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
    const onActivity = (e: Event) => {
      // 顺手记下指针位置：开启穿透的那一刻要用它立即命中测试一次，
      // 否则指针已经停在工具条上时，用户得先动一下鼠标才点得到按钮。
      if (e instanceof MouseEvent) lastPointerRef.current = { x: e.clientX, y: e.clientY }
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
      if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current)
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

    const off = onAgentActivity((activity) => {
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

    return () => {
      // 卸载时若还有未 flush 的流式文本，定时器会继续跑并对已卸载组件 setState。
      if (flushTimer !== null) window.clearTimeout(flushTimer)
      off()
    }
  }, [say, setTransientMood])

  // ── 订阅主壳的真实 agent 状态 ──
  //
  // 与 ai:chunk 的区别：chunk 是"已经说出话了"，而这个状态覆盖
  // **用户发问到第一个字之间的空窗期** —— 那几秒宠物若毫无反应，
  // 看起来就像坏了。这是 from='shell' 的广播，不是形态间自说自话。
  useEffect(() => {
    return onBroadcast((msg) => {
      if (msg.from !== 'shell' || msg.type !== 'agent:state') return
      const p = msg.payload as { state?: string } | null | undefined
      switch (p?.state) {
        case 'thinking':
          setTransientMood('thinking')
          break
        case 'tool':
          setTransientMood('thinking')
          break
        case 'replying':
          // 开始输出正文，不在气泡里重复（正文由 ai:chunk 负责展示）
          setTransientMood('happy')
          break
        case 'idle':
          // 回到空闲：'idle' 会清掉临时情绪定时器，让空闲计时器接管（久坐会打瞌睡）
          setTransientMood('idle')
          break
        default:
          break
      }
    })
  }, [setTransientMood])

  // ── 点击行为 ── ──
  const poke = useCallback(() => {
    if (mood === 'sleepy') {
      setTransientMood('idle')
      say('唔……醒了。')
      return
    }
    setGesture('bounce')
    setTransientMood('happy')
    broadcast('pet:poked', null)
  }, [mood, say, setTransientMood])

  /**
   * 单击延后一拍再执行。
   *
   * DOM 规范里 dblclick 之前必然先触发**两次** click。若直接在 click 里响应，
   * "双击唤起对话框"会顺带广播两次 pet:poked —— 监听方（比如统计被戳次数）
   * 就会把一次双击算成两次。因此延后到双击阈值之后再判定，
   * dblclick 到达时把待执行的单击取消掉。
   */
  const handleClick = useCallback(() => {
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current)
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null
      poke()
    }, CLICK_DEBOUNCE_MS)
  }, [poke])

  const handleDoubleClick = useCallback(() => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
    }
    setGesture('wave')
    broadcast('pet:summon-chat', null)
    void setFormVisible('chat', true)
  }, [])

  const togglePassthrough = useCallback(() => {
    setPassthrough((prev) => {
      const next = !prev
      void setIgnoreMouseEvents(next)
      return next
    })
  }, [])

  // ── 穿透状态下的命中测试 ──
  //
  // 问题：窗口一旦忽略鼠标事件，连"关闭穿透"的那个按钮自己都点不到了 ——
  // 开启就成了单向操作，只能重启应用。主进程侧用的是
  // setIgnoreMouseEvents(on, { forward: true })，forward 让窗口仍能收到
  // mousemove，于是这里据此做命中测试：指针进入标记为可交互的区域时
  // 临时关掉穿透，离开后恢复。交互区域用 data-passthrough-hit 标注。
  useEffect(() => {
    if (!passthrough) return
    let interactive = false

    const apply = (hit: boolean) => {
      if (hit === interactive) return
      interactive = hit
      void setIgnoreMouseEvents(!hit)
    }
    const test = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y)
      apply(!!el?.closest('[data-passthrough-hit]'))
    }

    const onMove = (e: MouseEvent) => test(e.clientX, e.clientY)

    // 开启瞬间用最后一次已知位置先判一次：指针恰好停在工具条上时，
    // 等用户移动鼠标才恢复交互，看起来就是"点了没反应"。
    const last = lastPointerRef.current
    if (last) test(last.x, last.y)

    window.addEventListener('mousemove', onMove)
    return () => {
      window.removeEventListener('mousemove', onMove)
      // 这里刻意不恢复穿透：关闭穿透由 togglePassthrough 负责。
      // 若在 cleanup 里恢复，effect 的清理会先于状态更新跑完，
      // 把用户刚关掉的穿透又盖回 true。
    }
  }, [passthrough])

  return (
    <div
      className={`pet-stage ${passthrough ? 'pet-passthrough' : ''}`}
      onDoubleClick={handleDoubleClick}
      onClick={handleClick}
      title="单击互动 · 双击打开对话框 · 拖拽移动"
    >
      {/* 悬停工具条：常驻会挡住小人，所以只在靠近时浮现 */}
      <div
        className="pet-toolbar form-no-drag"
        data-passthrough-hit=""
        onClick={(e) => e.stopPropagation()}
      >
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
