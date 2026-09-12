import { useEffect, useRef, useCallback } from 'react'

/**
 * 声明式 setTimeout hook
 *
 * @param callback - 超时回调
 * @param delayMs  - 延迟毫秒数，传入 null 暂停
 *
 * 用法：
 * ```ts
 * useTimeout(() => setText(''), delay)
 * ```
 */
export function useTimeout(callback: () => void, delayMs: number | null): void {
  const savedCallback = useRef(callback)
  savedCallback.current = callback

  useEffect(() => {
    if (delayMs === null) return
    const id = setTimeout(() => savedCallback.current(), delayMs)
    return () => clearTimeout(id)
  }, [delayMs])
}

/**
 * 声明式 setInterval hook
 *
 * @param callback - 间隔回调
 * @param intervalMs - 间隔毫秒数，传入 null 暂停
 *
 * 用法：
 * ```ts
 * useInterval(() => setI(i => i + 1), 1000)
 * ```
 */
export function useInterval(callback: () => void, intervalMs: number | null): void {
  const savedCallback = useRef(callback)
  savedCallback.current = callback

  useEffect(() => {
    if (intervalMs === null) return
    const id = setInterval(() => savedCallback.current(), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
}

/**
 * 手动控制的定时器 hook（兼容 fadeTimer / revealTimer 等 ref 模式）
 *
 * 返回 set/clear 方法，组件卸载时自动清理
 *
 * 用法：
 * ```ts
 * const reveal = useTimerControl()
 * // 开始
 * reveal.setInterval(() => { i++; if (done) reveal.clear() }, 20)
 * // 清除
 * reveal.clear()
 * ```
 */
export function useTimerControl() {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const set = useCallback(
    (fn: () => void, delay: number) => {
      clear()
      timerRef.current = setTimeout(fn, delay)
    },
    [clear],
  )

  const setInterval_ = useCallback(
    (fn: () => void, interval: number) => {
      clear()
      timerRef.current = globalThis.setInterval(fn, interval)
    },
    [clear],
  )

  useEffect(() => {
    return () => clear()
  }, [clear])

  return { set, setInterval: setInterval_, clear }
}
