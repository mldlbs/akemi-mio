/**
 * 宠物小人的程序化形象。
 *
 * 为什么不用图片资源：仓库里并没有配套的立绘/精灵图，
 * 而 SVG 可以做到零外部依赖、任意缩放不糊、并且**表情与配色可以随状态实时变化**
 * （瞳孔形变、眉线角度、腮红色相），这是静态图做不到的。
 * 后续若要换成正式美术资源，只需替换本组件，外部接口（mood/gesture）不变。
 *
 * 图形分层（后 → 前）：光晕 → 躯干 → 围巾 → 头 → 耳 → 脸 → 眼 → 眉/嘴 → 装饰
 * 每层单独成组，便于 CSS 动画各自驱动，互不干扰。
 */

import { useEffect, useRef, useState } from 'react'
import type { PetGesture, PetMood } from '../types'

interface PetAvatarProps {
  mood: PetMood
  gesture: PetGesture | null
  /** 一次动作播放结束后的回调，由父组件用于清空 gesture */
  onGestureEnd?: () => void
}

/** 情绪 → 配色主题。色相沿用项目令牌的暖炭 + 朱红 + 金，不引入新色系。 */
const MOOD_THEME: Record<PetMood, { body: string; bodyDark: string; accent: string; cheek: string; glow: string }> = {
  idle: {
    body: 'oklch(0.86 0.045 60)',
    bodyDark: 'oklch(0.72 0.05 58)',
    accent: 'oklch(0.67 0.155 28)',
    cheek: 'oklch(0.72 0.13 30 / 0.5)',
    glow: 'oklch(0.84 0.125 80 / 0.35)',
  },
  happy: {
    body: 'oklch(0.89 0.06 75)',
    bodyDark: 'oklch(0.76 0.07 70)',
    accent: 'oklch(0.78 0.16 55)',
    cheek: 'oklch(0.75 0.17 25 / 0.6)',
    glow: 'oklch(0.86 0.15 75 / 0.45)',
  },
  thinking: {
    body: 'oklch(0.8 0.04 250)',
    bodyDark: 'oklch(0.66 0.05 250)',
    accent: 'oklch(0.6 0.11 255)',
    cheek: 'oklch(0.7 0.06 250 / 0.4)',
    glow: 'oklch(0.68 0.1 255 / 0.35)',
  },
  alert: {
    body: 'oklch(0.85 0.09 35)',
    bodyDark: 'oklch(0.7 0.12 32)',
    accent: 'oklch(0.62 0.2 25)',
    cheek: 'oklch(0.68 0.18 25 / 0.55)',
    glow: 'oklch(0.7 0.18 30 / 0.45)',
  },
  sleepy: {
    body: 'oklch(0.74 0.03 290)',
    bodyDark: 'oklch(0.6 0.04 290)',
    accent: 'oklch(0.55 0.08 285)',
    cheek: 'oklch(0.65 0.06 290 / 0.4)',
    glow: 'oklch(0.62 0.08 290 / 0.3)',
  },
}

export function PetAvatar({ mood, gesture, onGestureEnd }: PetAvatarProps) {
  const theme = MOOD_THEME[mood]
  const [blinking, setBlinking] = useState(false)
  const timerRef = useRef<number | null>(null)

  // 眨眼由组件自行随机驱动 —— 让小人"活着"的关键细节。
  // 间隔刻意不固定（2.4~5.6s），固定节奏会显得机械像机器人。
  useEffect(() => {
    let cancelled = false
    const schedule = () => {
      const delay = 2400 + Math.random() * 3200
      timerRef.current = window.setTimeout(() => {
        if (cancelled) return
        setBlinking(true)
        window.setTimeout(() => {
          if (cancelled) return
          setBlinking(false)
          schedule()
        }, 130)
      }, delay)
    }
    schedule()
    return () => {
      cancelled = true
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  // 一次性动作：加类名播放，动画结束后通知父组件清空。
  const gestureClass = gesture ? `pet-gesture-${gesture}` : ''

  useEffect(() => {
    if (!gesture || !onGestureEnd) return
    const duration = gesture === 'bounce' ? 620 : 480
    const t = window.setTimeout(onGestureEnd, duration)
    return () => window.clearTimeout(t)
  }, [gesture, onGestureEnd])

  // 情绪影响瞳孔与嘴型。sleepy 与 happy 的眼睛走特殊造型。
  const eyeOpen = mood === 'sleepy' ? 0.25 : blinking ? 0.06 : 1
  const pupilR = mood === 'alert' ? 4.6 : mood === 'happy' ? 3.6 : 4.2
  const browAngle = mood === 'alert' ? -14 : mood === 'thinking' ? 8 : mood === 'sleepy' ? 4 : 0

  return (
    <svg
      className={`pet-svg ${gestureClass}`}
      viewBox="0 0 160 200"
      width="160"
      height="200"
      role="img"
      aria-label={`Akemi Mio 宠物形态，当前情绪：${mood}`}
    >
      <defs>
        {/* 呼吸光晕：让小人从桌面"浮起来"，而不是贴纸一样贴在屏幕上 */}
        <radialGradient id="pet-glow" cx="50%" cy="62%" r="50%">
          <stop offset="0%" stopColor={theme.glow} stopOpacity="0.9" />
          <stop offset="70%" stopColor={theme.glow} stopOpacity="0.15" />
          <stop offset="100%" stopColor={theme.glow} stopOpacity="0" />
        </radialGradient>
        {/* 躯干渐变：上浅下深，制造体积感 */}
        <linearGradient id="pet-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={theme.body} />
          <stop offset="100%" stopColor={theme.bodyDark} />
        </linearGradient>
        {/* 头部高光 */}
        <radialGradient id="pet-head-hl" cx="36%" cy="30%" r="45%">
          <stop offset="0%" stopColor="oklch(0.98 0.02 90 / 0.75)" />
          <stop offset="100%" stopColor="oklch(0.98 0.02 90 / 0)" />
        </radialGradient>
      </defs>

      {/* ── 光晕层 ── */}
      <ellipse className="pet-glow" cx="80" cy="128" rx="58" ry="52" fill="url(#pet-glow)" />

      {/* ── 躯干 ── */}
      <g className="pet-torso">
        <path d="M52 150 Q52 122 80 122 Q108 122 108 150 L110 176 Q110 188 96 188 L64 188 Q50 188 50 176 Z" fill="url(#pet-body)" />
        {/* 围巾：朱红点缀，也是形态的识别色 */}
        <path d="M54 128 Q80 140 106 128 L104 138 Q80 150 56 138 Z" fill={theme.accent} />
        <path d="M100 133 L112 158 L102 161 L94 137 Z" fill={theme.accent} opacity="0.85" />
      </g>

      {/* ── 手臂（呼吸时轻微摆动）── */}
      <g className="pet-arm pet-arm-left">
        <ellipse cx="46" cy="158" rx="9" ry="13" fill={theme.bodyDark} />
      </g>
      <g className="pet-arm pet-arm-right">
        <ellipse cx="114" cy="158" rx="9" ry="13" fill={theme.bodyDark} />
      </g>

      {/* ── 头部 ── */}
      <g className="pet-head">
        {/* 耳：thinking 时轻微下垂，alert 时竖起 */}
        <g className={`pet-ears pet-ears-${mood}`}>
          <path d="M56 74 Q48 46 64 48 Q70 60 68 76 Z" fill={theme.bodyDark} />
          <path d="M104 74 Q112 46 96 48 Q90 60 92 76 Z" fill={theme.bodyDark} />
        </g>

        {/* 脸 */}
        <ellipse cx="80" cy="94" rx="38" ry="36" fill="url(#pet-body)" />
        <ellipse cx="80" cy="94" rx="38" ry="36" fill="url(#pet-head-hl)" />

        {/* 腮红 */}
        <ellipse cx="58" cy="104" rx="8" ry="5.5" fill={theme.cheek} />
        <ellipse cx="102" cy="104" rx="8" ry="5.5" fill={theme.cheek} />

        {/* 眉：角度随情绪变化 */}
        <g stroke={theme.bodyDark} strokeWidth="2.4" strokeLinecap="round" opacity={mood === 'happy' ? 0.35 : 0.8}>
          <line x1="62" y1="80" x2="72" y2={80 + browAngle * 0.12} transform={`rotate(${-browAngle} 67 80)`} />
          <line x1="88" y1={80 + browAngle * 0.12} x2="98" y2="80" transform={`rotate(${browAngle} 93 80)`} />
        </g>

        {/* 眼 */}
        <g className="pet-eyes">
          {/* happy 时用 ^ ^ 弯月眼 */}
          {mood === 'happy' ? (
            <>
              <path d="M66 94 Q72 86 78 94" stroke="oklch(0.3 0.02 50)" strokeWidth="2.8" fill="none" strokeLinecap="round" />
              <path d="M84 94 Q90 86 96 94" stroke="oklch(0.3 0.02 50)" strokeWidth="2.8" fill="none" strokeLinecap="round" />
            </>
          ) : (
            <>
              <g className="pet-eye pet-eye-left">
                <ellipse cx="72" cy="94" rx="8" ry={8 * eyeOpen} fill="oklch(0.97 0.01 85)" />
                <circle cx="72" cy={94 + (1 - eyeOpen) * 3} r={pupilR * (0.35 + eyeOpen * 0.65)} fill="oklch(0.26 0.02 50)" />
                {/* 瞳孔高光 —— 一个亮点就让眼睛有神 */}
                <circle cx="69.5" cy={91 + (1 - eyeOpen) * 3} r="1.5" fill="oklch(1 0 0 / 0.9)" />
              </g>
              <g className="pet-eye pet-eye-right">
                <ellipse cx="88" cy="94" rx="8" ry={8 * eyeOpen} fill="oklch(0.97 0.01 85)" />
                <circle cx="88" cy={94 + (1 - eyeOpen) * 3} r={pupilR * (0.35 + eyeOpen * 0.65)} fill="oklch(0.26 0.02 50)" />
                <circle cx="85.5" cy={91 + (1 - eyeOpen) * 3} r="1.5" fill="oklch(1 0 0 / 0.9)" />
              </g>
            </>
          )}
        </g>

        {/* 嘴 */}
        <g className="pet-mouth">
          {mood === 'happy' ? (
            <path d="M74 106 Q80 113 86 106" stroke={theme.accent} strokeWidth="2.4" fill="none" strokeLinecap="round" />
          ) : mood === 'alert' ? (
            <ellipse cx="80" cy="109" rx="3.6" ry="4.4" fill={theme.accent} opacity="0.85" />
          ) : mood === 'thinking' ? (
            <path d="M75 109 Q80 107 85 110" stroke="oklch(0.4 0.02 55)" strokeWidth="2.2" fill="none" strokeLinecap="round" />
          ) : mood === 'sleepy' ? (
            <path d="M76 108 Q80 111 84 108" stroke="oklch(0.45 0.02 55)" strokeWidth="2" fill="none" strokeLinecap="round" />
          ) : (
            <path d="M76 107 Q80 111 84 107" stroke="oklch(0.4 0.02 55)" strokeWidth="2.2" fill="none" strokeLinecap="round" />
          )}
        </g>
      </g>

      {/* ── 情绪装饰层 ── */}
      {/* thinking：气泡思考点 */}
      {mood === 'thinking' && (
        <g className="pet-mood-deco pet-deco-thinking" fill={theme.accent}>
          <circle cx="122" cy="62" r="3.2" />
          <circle cx="130" cy="54" r="4.4" />
          <circle cx="140" cy="44" r="6" opacity="0.9" />
        </g>
      )}
      {/* sleepy：Z Z Z */}
      {mood === 'sleepy' && (
        <g className="pet-mood-deco pet-deco-sleepy" fill="oklch(0.72 0.015 82)" fontFamily="'Sora', sans-serif" fontWeight="600">
          <text x="118" y="58" fontSize="12">
            z
          </text>
          <text x="128" y="46" fontSize="16">
            Z
          </text>
          <text x="140" y="30" fontSize="20">
            Z
          </text>
        </g>
      )}
      {/* alert：感叹号 */}
      {mood === 'alert' && (
        <g className="pet-mood-deco pet-deco-alert" fill={theme.accent}>
          <rect x="124" y="36" width="5" height="18" rx="2.5" />
          <circle cx="126.5" cy="61" r="3" />
        </g>
      )}
      {/* happy：飘落的小星 */}
      {mood === 'happy' && (
        <g className="pet-mood-deco pet-deco-happy" fill="oklch(0.88 0.14 85)">
          <path d="M124 46 l2.6 5.6 6.1 0.7 -4.5 4.2 1.2 6 -5.4 -3 -5.4 3 1.2 -6 -4.5 -4.2 6.1 -0.7 Z" opacity="0.9" />
        </g>
      )}
    </svg>
  )
}
