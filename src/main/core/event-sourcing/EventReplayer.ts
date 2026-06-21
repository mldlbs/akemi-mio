import type { EventStoreEngine } from '../../core/EventBusTypes'
import { log } from '../../logger/Logger'

/**
 * EventReplayer — 启动时重放持久化事件恢复状态
 *
 * 接收已注册的 EventBus 实例和 EventStore，查询自指定时间点之后的事件
 * 并按顺序重放到订阅者。
 */
export class EventReplayer {
  private store: EventStoreEngine

  constructor(store: EventStoreEngine) {
    this.store = store
  }

  /**
   * 重放指定 channel 的事件到 eventBus。
   */
  async replay(eventBus: any, channels: string[], sinceTimestamp: number): Promise<number> {
    let count = 0
    for (const channel of channels) {
      try {
        const events = await this.store.query(channel, sinceTimestamp)
        for (const ev of events) {
          let payload: any
          try {
            payload = JSON.parse(ev.payload)
          } catch {
            payload = ev.payload
          }
          eventBus.emit(channel, payload, { source: ev.source ?? undefined, traceId: ev.traceId ?? undefined })
          count++
        }
        log('INFO', 'event_replay', { channel, count: events.length, since: new Date(sinceTimestamp).toISOString() })
      } catch (err: any) {
        log('WARN', 'event_replay_failed', { channel, error: err.message })
      }
    }
    return count
  }
}
