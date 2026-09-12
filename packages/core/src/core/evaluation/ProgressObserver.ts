/**
 * ProgressObserver — Event Pipeline Observer 实现
 *
 * 职责：
 * - 订阅 EvaluationRepository 事件流
 * - 每个事件到达时调用 ProgressAnalyzer.compute(traceId, events)
 * - 将 ProgressSnapshot 分发给所有已注册的 ProgressConsumer
 *
 * 约束（ADR-003 §ADR-5）：
 * - 单例：整个进程一个实例，所有 Runtime 共享
 * - 不引用 ChatExecutor
 * - 异步无阻塞：事件处理不阻塞 EventBus 生产者
 * - 可重放：同一批 Event → 同一组 Snapshot（纯函数保证）
 * - Consumer 错误隔离：一个 Consumer 异常不影响其他 Consumer
 *
 * 数据流：
 *   EvaluationRepository.append(event)
 *       │
 *       ▼
 *   ProgressObserver.onEvent()
 *       │
 *       ▼
 *   ProgressAnalyzer.compute(traceId, events)
 *       │
 *       ▼
 *   ProgressSnapshot
 *       │
 *       ▼
 *   ProgressConsumers[] (并行分发，错误隔离)
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { EvaluationEvent } from './types'
import type { EvaluationRepository } from './types'
import type { ProgressAnalyzer, ProgressConsumer, ProgressSnapshot } from './progress'

/** 安全 Consumer 调用包装：同步 throw 和 async reject 均捕获 */
async function safeConsume(consumer: ProgressConsumer, snapshot: ProgressSnapshot): Promise<void> {
  try {
    await consumer.consume(snapshot)
  } catch {
    // 异常由调用方（Promise.allSettled 循环）处理
  }
}

/** 按 traceId 分组事件 */
function groupByTraceId(events: EvaluationEvent[]): Map<string, EvaluationEvent[]> {
  const groups = new Map<string, EvaluationEvent[]>()
  for (const ev of events) {
    if (!ev.traceId) continue
    const list = groups.get(ev.traceId) ?? []
    list.push(ev)
    groups.set(ev.traceId, list)
  }
  return groups
}

/** 启动 catch-up 窗口（毫秒），只重放可能错过的近期事件 */
const STARTUP_CATCHUP_MS = 60_000

export class ProgressObserver {
  private analyzer: ProgressAnalyzer
  private consumers: ProgressConsumer[] = []
  private unsubscribe: (() => void) | null = null

  constructor(
    private store: EvaluationRepository,
    analyzer: ProgressAnalyzer,
    private replayWindowMs: number = STARTUP_CATCHUP_MS,
  ) {
    this.analyzer = analyzer
  }

  /** 注册一个 ProgressConsumer */
  register(consumer: ProgressConsumer): void {
    this.consumers.push(consumer)
  }

  /** 取消注册一个 ProgressConsumer */
  unregister(consumer: ProgressConsumer): void {
    const idx = this.consumers.indexOf(consumer)
    if (idx >= 0) this.consumers.splice(idx, 1)
  }

  /** 启动 Observer（订阅事件流 + catch-up 重启前的尾巴） */
  async start(): Promise<void> {
    if (this.unsubscribe) {
      log('WARN', 'progress_observer_already_started')
      return
    }
    this.unsubscribe = this.store.subscribe((event) => this.onEvent(event))
    log('INFO', 'progress_observer_started', { consumerCount: this.consumers.length })

    // 非阻塞 catch-up：重放重启前可能错过的事件
    try {
      const now = Date.now()
      const catchupEvents = await this.store.query({ since: now - this.replayWindowMs })
      const traceGroups = groupByTraceId(catchupEvents)
      let replayCount = 0
      for (const [traceId, events] of traceGroups) {
        await this.handleTrace(traceId, events)
        replayCount++
      }
      if (replayCount > 0) {
        log('INFO', 'progress_observer_catchup_complete', { traceCount: replayCount, eventCount: catchupEvents.length })
      }
    } catch (err: any) {
      // catch-up 失败不影响后续 live processing
      log('WARN', 'progress_observer_catchup_failed', { error: err.message })
    }
  }

  /** 停止 Observer（取消订阅） */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    log('INFO', 'progress_observer_stopped')
  }

  /** 已启动？ */
  get running(): boolean {
    return this.unsubscribe !== null
  }

  get consumerCount(): number {
    return this.consumers.length
  }

  // ── 内部事件处理 ──

  private onEvent(event: EvaluationEvent): void {
    this.handleEvent(event).catch((err) => {
      log('ERROR', 'progress_observer_handle_error', { error: String(err) })
    })
  }

  /** 单事件入口：获取完整 trace 后 compute */
  private async handleEvent(event: EvaluationEvent): Promise<void> {
    if (!event.traceId) return
    const events = await this.store.getTrace(event.traceId)
    await this.handleTrace(event.traceId, events)
  }

  /** 核心处理逻辑：compute + 分发 */
  private async handleTrace(traceId: string, events: EvaluationEvent[]): Promise<void> {
    if (events.length === 0) return
    const snapshot = this.analyzer.compute(traceId, events)

    const results = await Promise.allSettled(this.consumers.map((consumer) => safeConsume(consumer, snapshot)))

    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r.status === 'rejected') {
        log('WARN', 'progress_observer_consumer_error', {
          consumerIndex: i,
          error: String(r.reason),
        })
      }
    }
  }
}
