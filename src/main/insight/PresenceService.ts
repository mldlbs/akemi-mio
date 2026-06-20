import { eventBus, EventBus } from '../core/EventBus'
import { log } from '../logger/Logger'
import type { PresenceState } from './types'

export class PresenceService {
  private state: PresenceState = 'active'
  private lastActivity = Date.now()
  private idleTimeoutMs: number
  private eventBus: EventBus
  private listeners: Array<(from: PresenceState, to: PresenceState) => void> = []

  constructor(idleTimeoutMinutes = 5, bus?: EventBus) {
    this.idleTimeoutMs = idleTimeoutMinutes * 60 * 1000
    this.eventBus = bus || eventBus
    this.eventBus.on('agent.input.received', () => this.markActive())
  }

  private markActive(): void {
    const prev = this.state
    const awayMs = Date.now() - this.lastActivity
    this.lastActivity = Date.now()
    if (prev === 'away') {
      this.state = 'active'
      this.notify(prev, 'active')
      log('INFO', 'presence_returned', { away_ms: awayMs })
    }
  }

  tick(): void {
    const prev = this.state
    const awayMs = Date.now() - this.lastActivity

    if (prev === 'active' && awayMs >= this.idleTimeoutMs) {
      this.state = 'away'
      this.notify(prev, 'away')
      log('INFO', 'presence_away', { idle_ms: awayMs })
    }
  }

  isAway(): boolean {
    return this.state === 'away'
  }

  isActive(): boolean {
    return this.state === 'active'
  }

  getState(): PresenceState {
    return this.state
  }

  getAwayDurationMs(): number {
    if (this.state === 'away') return Date.now() - this.lastActivity
    return 0
  }

  onTransition(cb: (from: PresenceState, to: PresenceState) => void): () => void {
    this.listeners.push(cb)
    return () => {
      this.listeners = this.listeners.filter(l => l !== cb)
    }
  }

  private notify(from: PresenceState, to: PresenceState): void {
    for (const cb of this.listeners) {
      try { cb(from, to) } catch { /* guard */ }
    }
  }
}
