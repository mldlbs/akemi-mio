/**
 * InMemoryEvaluationRepository — 用于 Evaluation 子系统的内存测试实现
 *
 * 不持久化，仅用于验证事件链路是否正确。
 */

import type { EvaluationEvent, EvaluationRepository, EventType } from '@akemi-mio/core/core/evaluation/types'

export class InMemoryEvaluationRepository implements EvaluationRepository {
  events: EvaluationEvent[] = []
  private subscribers = new Set<(event: EvaluationEvent) => void>()

  append(event: EvaluationEvent): void {
    this.events.push(event)
    for (const handler of this.subscribers) handler(event)
  }

  subscribe(handler: (event: EvaluationEvent) => void): () => void {
    this.subscribers.add(handler)
    return () => this.subscribers.delete(handler)
  }

  async query(range: { since: number; until?: number; type?: EventType }): Promise<EvaluationEvent[]> {
    return this.events.filter((e) => {
      if (e.timestamp < range.since) return false
      if (range.until && e.timestamp > range.until) return false
      if (range.type && e.type !== range.type) return false
      return true
    })
  }

  async getTrace(traceId: string): Promise<EvaluationEvent[]> {
    return this.events.filter((e) => e.traceId === traceId)
  }

  async queryBySeq(afterSeq: number, limit?: number): Promise<EvaluationEvent[]> {
    const filtered = this.events.filter((_, index) => index > afterSeq)
    return limit !== undefined ? filtered.slice(0, limit) : filtered
  }

  getCurrentSeq(): number {
    return this.events.length
  }

  async init(): Promise<void> {
    // no-op
  }

  async shutdown(): Promise<void> {
    // no-op
  }
}
