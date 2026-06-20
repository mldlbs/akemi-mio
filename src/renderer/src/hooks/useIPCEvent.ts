import { useEffect, useRef } from 'react'

/**
 * 声明式 IPC 事件订阅 hook
 *
 * @param register - preload 暴露的 on* 注册函数（如 window.electronAPI.onStateUpdate）
 * @param handler   - 事件处理回调
 * @param deps      - 可选的依赖数组（默认空数组，仅在 mount/unmount 时订阅）
 *
 * 用法：
 * ```ts
 * useIPCEvent(window.electronAPI.onStateUpdate, (state) => {
 *   if (state.error) setError(state.error as string)
 * })
 * ```
 */
export function useIPCEvent<T>(
  register: (cb: (data: T) => void) => () => void,
  handler: (data: T) => void,
  deps: React.DependencyList = [],
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    const cleanup = register((data: T) => {
      handlerRef.current(data)
    })
    return () => {
      cleanup?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
