import { create } from 'zustand'

interface ClockStore {
  now: number
}

let intervalId: ReturnType<typeof setInterval> | null = null

function loop() {
  store?.setState({ now: Date.now() })
}

export function stopClock(): void {
  if (intervalId !== null) {
    clearInterval(intervalId)
    intervalId = null
  }
}

export const useClockStore = create<ClockStore>(() => ({ now: Date.now() }))

// 原先这里写成 ReturnType<typeof create<ClockStore>>，那是"工厂函数"的类型而不是
// "store 实例"的类型，所以 setState 不存在。直接引用实例类型即可，连带去掉 as any。
let store: typeof useClockStore | null = null

store = useClockStore
intervalId = setInterval(loop, 100)
