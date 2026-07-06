/**
 * EvaluationEmitter — Evaluation 子系统唯一写入入口
 *
 * Runtime 模块（ChatExecutor / ToolExecutor / Model Adapter / Workflow）通过
 * 此接口产生 EvaluationEvent，不直接依赖 EvaluationStore 或任何下层。
 *
 * 职责极薄：
 * - emit(event): 补充公共字段后写入 store
 * - 不承担 Metrics、Sampling、Deduplication、Fitness 等派生计算
 */

import { randomUUID } from 'crypto'
import type { EvaluationEvent, EventType, EventPayload } from './types'
import type { EvaluationRepository } from './types'

export class EvaluationEmitter {
  private store: EvaluationRepository
  private source: string
  private defaultSessionId: string

  constructor(store: EvaluationRepository, source: string, sessionId?: string) {
    this.store = store
    this.source = source
    this.defaultSessionId = sessionId ?? ''
  }

  emit(
    type: EventType,
    payload: EventPayload,
    meta?: {
      traceId?: string
      sessionId?: string
      parentEventId?: string
    },
  ): void {
    const event: EvaluationEvent = {
      id: randomUUID(),
      timestamp: Date.now(),
      traceId: meta?.traceId ?? '',
      sessionId: meta?.sessionId ?? this.defaultSessionId,
      source: this.source,
      type,
      payload: payload as any,
      parentEventId: meta?.parentEventId,
    }
    this.store.append(event)
  }
}
