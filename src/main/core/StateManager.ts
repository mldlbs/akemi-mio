type Listener = (state: UIState) => void

export interface UIState {
  asr?: string
  ttsPlaying?: boolean
  recording?: boolean
  error?: string
  model?: string
}

export class StateManager {
  private state: UIState = {}
  private listeners: Set<Listener> = new Set()
  private pushToRenderer?: (state: Partial<UIState>) => void

  get(): UIState {
    return { ...this.state }
  }

  update(partial: Partial<UIState>): void {
    this.state = { ...this.state, ...partial }
    this.pushToRenderer?.(partial)
    for (const listener of this.listeners) {
      listener(this.state)
    }
  }

  subscribe(callback: Listener): () => void {
    this.listeners.add(callback)
    return () => { this.listeners.delete(callback) }
  }

  setPushToRenderer(fn: (state: Partial<UIState>) => void): void {
    this.pushToRenderer = fn
  }
}
