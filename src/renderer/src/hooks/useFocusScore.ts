import { useState, useEffect, useRef } from 'react'
import type { BehaviorState } from './useBehaviorAwareWallpaper'

// =============================================================================
// useFocusScore — 行为专注分数 Hook
// =============================================================================
//
// 基于 UserBehavior 的行为数据，每 10 秒采样一次，
// 维护最近 5 分钟（30 个样本）的活动率窗口，
// 结合当前应用类别 / 空闲时间 / 全屏状态，
// 计算 0–100 的专注分数。
//
// 全部计算本地化，不上传任何隐私信息。
//
// =============================================================================

// =============================================================================
// 类型
// =============================================================================

export interface FocusScoreConfig {
  enabled: boolean
  windowSize: number
  sampleInterval: number
  highThreshold: number
  mediumThreshold: number
  restReminderAfterMs: number
}

export interface FocusScoreState {
  /** 当前专注分数 0–100 */
  score: number
  /** 0–1 进度值（用于进度条） */
  progress: number
  /** 文字标签 */
  label: string
  /** 主色调 CSS 颜色 */
  color: string
  /** 渐变色起点 */
  gradientFrom: string
  /** 渐变色终点 */
  gradientTo: string
  /** 是否应显示休息提醒 */
  restReminder: boolean
  /** 休息提醒文字 */
  restReminderText: string
  /** 原始专注等级 */
  level: 'high' | 'medium' | 'low' | 'rest'
  /** 当前配置 */
  config: FocusScoreConfig
}

// =============================================================================
// 默认值 & localStorage 持久化
// =============================================================================

const LS_FOCUS_KEY = 'mio_focus_dash_config'

export const DEFAULT_FOCUS_CONFIG: FocusScoreConfig = {
  enabled: true,
  windowSize: 30,         // 5 min × 6/min (每 10s 采样)
  sampleInterval: 10_000, // 10s
  highThreshold: 70,
  mediumThreshold: 40,
  restReminderAfterMs: 600_000, // 10 min
}

/** 从 localStorage 读取保存的配置，仅当 customConfig 未提供时使用 */
function loadSavedConfig(): FocusScoreConfig {
  try {
    const stored = localStorage.getItem(LS_FOCUS_KEY)
    if (stored) {
      return { ...DEFAULT_FOCUS_CONFIG, ...JSON.parse(stored) }
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_FOCUS_CONFIG }
}

// =============================================================================
// 颜色映射
// =============================================================================

const FOCUS_COLORS: Record<
  FocusScoreState['level'],
  { label: string; color: string; gradientFrom: string; gradientTo: string }
> = {
  high:   { label: '高度专注', color: '#22c55e', gradientFrom: '#22c55e', gradientTo: '#16a34a' },
  medium: { label: '中度专注', color: '#f59e0b', gradientFrom: '#f59e0b', gradientTo: '#d97706' },
  low:    { label: '低度专注', color: '#f97316', gradientFrom: '#f97316', gradientTo: '#ea580c' },
  rest:   { label: '需要休息', color: '#ef4444', gradientFrom: '#ef4444', gradientTo: '#dc2626' },
} as const

// =============================================================================
// 分数计算
// =============================================================================

function computeInstantScore(b: BehaviorState): number {
  let score = 50 // 基础分

  if (b.activityState === 'active') score += 35
  else if (b.activityState === 'idle') score -= 20
  else if (b.activityState === 'away') score -= 50

  if (b.appCategory === 'code') score += 15
  else if (b.appCategory === 'communication') score -= 5
  else if (b.appCategory === 'media') score -= 15

  if (b.fullscreen) score += 5

  if (b.idleTimeMs > 0) {
    score -= Math.min(30, Math.floor(b.idleTimeMs / 10_000))
  }

  return Math.max(0, Math.min(100, Math.round(score)))
}

function scoreToLevel(score: number, highThreshold: number, mediumThreshold: number): FocusScoreState['level'] {
  if (score >= highThreshold) return 'high'
  if (score >= mediumThreshold) return 'medium'
  if (score <= 10) return 'rest'
  return 'low'
}

function levelToColors(level: FocusScoreState['level']) {
  return FOCUS_COLORS[level]
}

// =============================================================================
// Hook
// =============================================================================

export function useFocusScore(
  behavior: BehaviorState | null,
  customConfig?: Partial<FocusScoreConfig>,
): FocusScoreState {
  // 合并配置 — 未提供 customConfig 时从 localStorage 读取
  const base = customConfig ? DEFAULT_FOCUS_CONFIG : loadSavedConfig()
  const config: FocusScoreConfig = { ...base, ...customConfig }

  // behavior 存入 ref — interval 通过 ref 始终读取最新值
  const behaviorRef = useRef(behavior)
  behaviorRef.current = behavior

  const samplesRef = useRef<number[]>([])
  const lowFocusStartRef = useRef<number | null>(null)
  const initializedRef = useRef(false)

  const [scores, setScores] = useState<{
    score: number
    level: FocusScoreState['level']
    restReminder: boolean
  }>(() => ({
    score: 50,
    level: 'medium',
    restReminder: false,
  }))

  // ── 初始采样：behavior 就绪后立即计算一次 ──
  useEffect(() => {
    if (!config.enabled) return
    if (!behavior) return
    if (initializedRef.current) return
    initializedRef.current = true

    const instant = computeInstantScore(behavior)
    samplesRef.current = [instant]
    const level = scoreToLevel(instant, config.highThreshold, config.mediumThreshold)
    setScores({ score: instant, level, restReminder: false })
  }, [behavior]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── 定时采样 ──
  useEffect(() => {
    if (!config.enabled) return

    const timer = setInterval(() => {
      const b = behaviorRef.current
      if (!b) return

      const buf = samplesRef.current
      const instant = computeInstantScore(b)

      buf.push(instant)
      if (buf.length > config.windowSize) {
        buf.shift()
      }

      const avg = buf.reduce((a, b) => a + b, 0) / buf.length
      const finalScore = Math.round(avg)

      const level = scoreToLevel(finalScore, config.highThreshold, config.mediumThreshold)

      let restReminder = false
      if (level === 'low' || level === 'rest') {
        if (lowFocusStartRef.current === null) {
          lowFocusStartRef.current = Date.now()
        } else if (Date.now() - lowFocusStartRef.current >= config.restReminderAfterMs) {
          restReminder = true
        }
      } else {
        lowFocusStartRef.current = null
      }

      setScores({ score: finalScore, level, restReminder })
    }, config.sampleInterval)

    return () => clearInterval(timer)
  }, [config.enabled, config.windowSize, config.sampleInterval, config.highThreshold, config.mediumThreshold, config.restReminderAfterMs])

  // ── 计算显示属性 ──
  const colors = levelToColors(scores.level)

  return {
    score: scores.score,
    progress: scores.score / 100,
    label: scores.restReminder ? '建议休息' : colors.label,
    color: colors.color,
    gradientFrom: colors.gradientFrom,
    gradientTo: colors.gradientTo,
    restReminder: scores.restReminder,
    restReminderText: scores.restReminder
      ? `已持续低专注超过 ${Math.round(config.restReminderAfterMs / 60_000)} 分钟，建议起身活动`
      : '',
    level: scores.level,
    config,
  }
}
