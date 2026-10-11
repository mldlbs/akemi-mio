/**
 * GuardrailTraceSink — 机制涌现 P0 (c)：Guardrail 触发/恢复事件写入 observer traces。
 *
 * 复用 observer.ingest 的 traces.jsonl 行格式（与 mio-cli observer.js sinks 对齐），
 * 无新管线：仅追加一行 JSONL。
 *
 * 事件：
 * - guardrail.triggered：action 为 warning / terminate
 * - guardrail.recovery：同 trace 内从非 continue 恢复为 continue
 *
 * 写入失败只 WARN，绝不阻塞决策路径（与 GuardrailDecisionStore 同哲学）。
 */
import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { randomUUID } from 'crypto'
import { log } from '../../logger/Logger'

export type GuardrailTraceEventType = 'guardrail.triggered' | 'guardrail.recovery'

export interface GuardrailTraceEvent {
  event_type: GuardrailTraceEventType
  trace_id: string
  outcome?: string
  payload: Record<string, unknown>
}

export type GuardrailTraceSink = (event: GuardrailTraceEvent) => void

/**
 * 文件 sink：追加到 traces.jsonl。
 * 行 schema 与 observer.js createSinks().trace 对齐：
 * { id, timestamp, trace_id, event_type, outcome, payload, agent, host, project }
 */
export function createFileGuardrailTraceSink(
  tracesPath: string,
  meta?: { agent?: string; host?: string; project?: string },
): GuardrailTraceSink {
  return (event: GuardrailTraceEvent) => {
    try {
      mkdirSync(dirname(tracesPath), { recursive: true })
      const record = {
        id: `trace_${randomUUID()}`,
        timestamp: new Date().toISOString(),
        trace_id: event.trace_id,
        event_type: event.event_type,
        outcome: event.outcome ?? null,
        payload: event.payload,
        agent: meta?.agent ?? 'mio-agent-runtime',
        host: meta?.host ?? 'mio-agent-runtime',
        project: meta?.project ?? 'akemi-mio',
      }
      appendFileSync(tracesPath, JSON.stringify(record) + '\n', 'utf8')
    } catch (err: any) {
      log('WARN', 'guardrail_trace_sink.write_failed', {
        event_type: event.event_type,
        error: err?.message,
      })
    }
  }
}
