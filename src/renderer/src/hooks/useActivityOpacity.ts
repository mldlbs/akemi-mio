import { useState, useEffect, useRef, useCallback } from 'react'

// =============================================================================
// useActivityOpacity — 基于用户交互频率的自适应透明度
// =============================================================================
//
// 监听窗口内的 DOM 事件（mousemove、keydown、click），追踪最近交互时间戳，
// 计算活动得分并映射到透明度值。
//
// 行为:
//   - 高频交互 → opacity 接近 maxOpacity（完全不透明）
//   - 长时间无交互 → opacity 平滑过渡到 minOpacity（近乎透明/隐藏）
//   - 使用 CSS transition 实现渐变过渡
//
// 参数:
//   idleThresholdMs — 多久无交互后完全降至 minOpacity（默认 30s）
//   minOpacity      — 最低透明度（默认 0.15）
//   maxOpacity      — 最高透明度（默认 1.0）
//
// 返回:
//   opacity    — 当前透明度值 (0-1)
//   isActive   — 用户是否处于活跃状态
//   idleTimeMs — 距离上次交互的毫秒数
//   resetTimer — 手动重置空闲计时器（供外部触发，如 IPC 事件）
//

export interface ActivityOpacityOptions {
  /** 多久无交互后完全降至 minOpacity（毫秒），默认 30000 */
  idleThresholdMs?: number
  /** 最低透明度 (0-1)，默认 0.15 */
  minOpacity?: number
  /** 最高透明度 (0-1)，默认 1.0 */
  maxOpacity?: number
  /** 检查间隔（毫秒），默认 1000 */
  checkIntervalMs?: number
}

const DEFAULT_IDLE_THRESHOLD = 30_000 // 30 秒
const DEFAULT_MIN_OPACITY = 0.15
const DEFAULT_MAX_OPACITY = 1.0
const DEFAULT_CHECK_INTERVAL = 1000 // 1 秒

export function useActivityOpacity(options: ActivityOpacityOptions = {}) {
  const {
    idleThresholdMs = DEFAULT_IDLE_THRESHOLD,
    minOpacity = DEFAULT_MIN_OPACITY,
    maxOpacity = DEFAULT_MAX_OPACITY,
    checkIntervalMs = DEFAULT_CHECK_INTERVAL,
  } = options

  const lastActivityRef = useRef(Date.now())
  const [opacity, setOpacity] = useState(maxOpacity)
  const [idleTimeMs, setIdleTimeMs] = useState(0)

  // ── 活动检测 ──

  const markActive = useCallback(() => {
    lastActivityRef.current = Date.now()
  }, [])

  // 监听 DOM 事件
  useEffect(() => {
    const events = ['mousemove', 'keydown', 'click', 'wheel', 'touchstart'] as const
    for (const ev of events) {
      window.addEventListener(ev, markActive, { passive: true })
    }
    return () => {
      for (const ev of events) {
        window.removeEventListener(ev, markActive)
      }
    }
  }, [markActive])

  // ── 定时计算透明度 ──

  useEffect(() => {
    const interval = setInterval(() => {
      const idle = Date.now() - lastActivityRef.current
      setIdleTimeMs(idle)

      // 活动得分：0（完全空闲）→ 1（刚刚活跃）
      const activityScore = Math.max(0, 1 - idle / idleThresholdMs)

      // 映射到透明度范围
      const newOpacity = minOpacity + activityScore * (maxOpacity - minOpacity)
      setOpacity(Math.round(newOpacity * 1000) / 1000) // 保留 3 位小数，避免频繁重渲染
    }, checkIntervalMs)

    return () => clearInterval(interval)
  }, [idleThresholdMs, minOpacity, maxOpacity, checkIntervalMs])

  const isActive = idleTimeMs < idleThresholdMs

  return {
    opacity,
    isActive,
    idleTimeMs,
    resetTimer: markActive,
  }
}
