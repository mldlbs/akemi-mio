import { create } from 'zustand'

interface ClockStore {
  now: number
}

let rafId = 0
let store: ReturnType<typeof create<ClockStore>> | null = null

function loop() {
  store?.setState({ now: Date.now() })
  rafId = requestAnimationFrame(loop)
}

export function stopClock(): void {
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
}

export const useClockStore = create<ClockStore>(() => ({ now: Date.now() }))

store = useClockStore as any
rafId = requestAnimationFrame(loop)
