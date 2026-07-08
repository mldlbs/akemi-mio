import { create } from 'zustand'

interface ClockStore {
  now: number
}

let intervalId: ReturnType<typeof setInterval> | null = null
let store: ReturnType<typeof create<ClockStore>> | null = null

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

store = useClockStore as any
intervalId = setInterval(loop, 100)
