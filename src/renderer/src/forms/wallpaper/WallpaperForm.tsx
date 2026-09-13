/**
 * 全屏壁纸形态的根组件。
 *
 * 形态定位：铺满桌面的**最底层画布**。它不该是一个"应用界面"，
 * 而应该是一张有呼吸感的动态背景 —— 上面可以承载待办、日程、一句话提醒这类
 * 轻量信息，但绝不放按钮矩阵，否则壁纸就变成了另一个工作台。
 *
 * 关键约束：
 * 1. 不抢焦点、不响应常规点击（主进程已把窗口设为不可聚焦 + 鼠标穿透）。
 *    因此这里的所有交互都是"可选的"：即使全部不可点，视觉也成立。
 * 2. 动态但克制：星点漂移 + 极缓的色相流动。壁纸是长时间盯着的画面，
 *    任何高频动效都会变成干扰。
 * 3. 自适应分辨率：用 viewBox + preserveAspectRatio 让星图在任何屏幕比例下都铺满。
 */

import { useEffect, useMemo, useState } from 'react'
import { hasFormBridge, onBroadcast } from '../runtime'
import type { PetMood } from '../types'
import './styles.css'

/** 星点数据。用固定种子的伪随机生成，保证每次渲染布局稳定 ——
 *  Math.random() 会让星图在每次刷新时完全重排，视觉上像"闪了一下"。 */
function seededStars(count: number, seed = 20260913) {
  const stars: { x: number; y: number; r: number; o: number; d: number }[] = []
  let s = seed
  const rand = () => {
    // 线性同余，够用且确定性
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
  for (let i = 0; i < count; i += 1) {
    stars.push({
      x: rand() * 100,
      y: rand() * 100,
      r: 0.4 + rand() * 1.5,
      o: 0.25 + rand() * 0.6,
      d: rand() * 8,
    })
  }
  return stars
}

/** 壁纸上的信息卡内容 —— 目前由广播驱动，后续可接真实数据源。 */
interface WallpaperInfo {
  title: string
  body: string
}

const MOOD_HUE: Record<PetMood, number> = {
  idle: 55,
  happy: 75,
  thinking: 250,
  alert: 30,
  sleepy: 290,
}

export function WallpaperForm() {
  const stars = useMemo(() => seededStars(140), [])
  const [info, setInfo] = useState<WallpaperInfo | null>(null)
  const [mood, setMood] = useState<PetMood>('idle')
  const [clock, setClock] = useState(() => new Date())

  // 时钟：壁纸上的时间是最自然的信息层，且成本极低。
  useEffect(() => {
    const t = window.setInterval(() => setClock(new Date()), 1000 * 20)
    return () => window.clearInterval(t)
  }, [])

  // 订阅其他形态广播：小人的情绪会带动壁纸的整体色相，
  // 形成"整个桌面是一个活的东西"的连贯感。
  useEffect(() => {
    return onBroadcast((msg) => {
      if (msg.from === 'wallpaper') return
      if (msg.type === 'pet:mood' || msg.type === 'wallpaper:mood') {
        const p = msg.payload as { mood?: PetMood } | undefined
        if (p?.mood) setMood(p.mood)
      }
      if (msg.type === 'wallpaper:info') {
        const p = msg.payload as WallpaperInfo | null | undefined
        setInfo(p ?? null)
      }
    })
  }, [])

  const hue = MOOD_HUE[mood]
  const timeText = `${clock.getHours().toString().padStart(2, '0')}:${clock.getMinutes().toString().padStart(2, '0')}`
  const dateText = `${clock.getMonth() + 1}月${clock.getDate()}日`

  return (
    <div className="wp-stage" style={{ ['--wp-hue' as string]: String(hue) }}>
      {/* ── 底层氛围：色晕 ── */}
      <div className="wp-aurora wp-aurora-a" aria-hidden="true" />
      <div className="wp-aurora wp-aurora-b" aria-hidden="true" />
      <div className="wp-grain" aria-hidden="true" />

      {/* ── 星图层 ── */}
      <svg
        className="wp-stars"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {stars.map((s, i) => (
          <circle
            key={i}
            cx={s.x}
            cy={s.y}
            r={s.r * 0.06}
            fill="oklch(0.95 0.01 85)"
            opacity={s.o}
            style={{ animationDelay: `${s.d}s` }}
            className="wp-star"
          />
        ))}
      </svg>

      {/* ── 信息层：右下角的轻量卡片 ──
          刻意放在角落而非居中：壁纸中央要保持留白，
          否则桌面图标和正在使用的窗口都会跟它打架。 */}
      <div className="wp-hud">
        <div className="wp-clock">
          <span className="wp-clock-time">{timeText}</span>
          <span className="wp-clock-date">{dateText}</span>
        </div>
        {info && (
          <div className="wp-info">
            <p className="wp-info-title">{info.title}</p>
            <p className="wp-info-body">{info.body}</p>
          </div>
        )}
      </div>

      {!hasFormBridge() && <div className="form-degraded-banner">预览模式：未接入桌面窗口</div>}
    </div>
  )
}
