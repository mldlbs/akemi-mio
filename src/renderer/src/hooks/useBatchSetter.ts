import { useRef, useCallback } from 'react'

/**
 * 高性能 IPC 订阅 Hook：使用 rAF 批次合并高频推送。
 * 同一帧内的多次 setter 调用只会触发一次渲染。
 *
 * 用法:
 *   const setPayload = useBatchSetter(dispatch)
 *   unsub = api.onData((d) => setPayload(d))
 */
export function useBatchSetter<T>(setter: (val: T) => void): (val: T) => void {
  const pendingRef = useRef<T | null>(null)
  const rafRef = useRef<number>(0)
  const setterRef = useRef(setter)
  setterRef.current = setter

  return useCallback((val: T) => {
    pendingRef.current = val
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      const v = pendingRef.current
      pendingRef.current = null
      if (v !== null) {
        setterRef.current(v)
      }
    })
  }, [])
}
