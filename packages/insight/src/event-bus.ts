/**
 * Minimal EventBus for @akemi-mio/insight.
 * Typed EventEmitter wrapper — no external dependencies.
 */

import { EventEmitter } from 'events'

export interface EventBus {
  on(event: string, listener: (...args: any[]) => void): void
  off(event: string, listener: (...args: any[]) => void): void
  emit(event: string, ...args: any[]): void
}

class MinimalEventBus implements EventBus {
  private emitter = new EventEmitter()

  on(event: string, listener: (...args: any[]) => void): void {
    this.emitter.on(event, listener)
  }

  off(event: string, listener: (...args: any[]) => void): void {
    this.emitter.off(event, listener)
  }

  emit(event: string, ...args: any[]): void {
    this.emitter.emit(event, ...args)
  }
}

/** Default singleton EventBus instance */
export const eventBus: EventBus = new MinimalEventBus()
