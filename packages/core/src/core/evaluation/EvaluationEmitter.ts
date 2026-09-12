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
import { EVENT_SCHEMA_STAMPED_TYPES, getCurrentSchemaVersion } from './EvaluationEventSchema'
import { ENVELOPE_SCHEMA_VERSION } from './types'

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
    // 对 config-related events 自动 stamp eventSchemaVersion
    let finalPayload: Record<string, unknown> = payload as any
    if (EVENT_SCHEMA_STAMPED_TYPES.has(type)) {
      finalPayload = { ...finalPayload, eventSchemaVersion: getCurrentSchemaVersion(type) }
    }

    const event: EvaluationEvent = {
      id: randomUUID(),
      schemaVersion: ENVELOPE_SCHEMA_VERSION,
      timestamp: Date.now(),
      traceId: meta?.traceId ?? '',
      sessionId: meta?.sessionId ?? this.defaultSessionId,
      source: this.source,
      type,
      payload: finalPayload as any,
      parentEventId: meta?.parentEventId,
    }
    this.store.append(event)
  }

  /** R4-A P0: 强制刷入未持久化事件。P0 事件（guardrail.terminated）在 emit 后调用。 */
  async forceFlush(): Promise<void> {
    if ('forceFlush' in this.store && typeof (this.store as any).forceFlush === 'function') {
      await (this.store as any).forceFlush()
    }
  }
}
