/**
 * ingestFeedbackEvents — CLI JSONL → 主进程 SQLite 单向导入（P0）
 *
 * 方向固定：CLI/MCP 只追加 feedback-events.jsonl；主进程定期/按需 ingest。
 * 不做反向同步（spec §九 R3：同步验证前禁止双端各自算权重）。
 * 幂等：靠 idempotency_key 唯一约束，重复导入不增样本。
 * 隔离：规范化失败或 hypothesisId 无对应假设的事件进 quarantine 返回值，不入库、不丢弃。
 */

import { normalizeFeedbackEvent, type HypothesisFeedbackEvent, type NormalizeQuarantineReason } from './FeedbackEvents'
import type { DrizzleFeedbackEventStore } from './DrizzleFeedbackEventStore'
import type { JsonlFeedbackEventStore } from './JsonlFeedbackEventStore'

export interface IngestFeedbackResult {
  /** 成功写入权威侧的事件数 */
  ingested: number
  /** 因 idempotencyKey 已存在而跳过 */
  deduped: number
  /** 规范化失败或假设不存在 */
  quarantined: Array<{ reason: NormalizeQuarantineReason | 'unknown_hypothesis'; raw: unknown }>
}

export interface IngestFeedbackOptions {
  /** 校验 hypothesisId 是否指向真实假设；返回 false 的事件进隔离。 */
  hypothesisExists?: (id: string) => boolean
  now?: number
}

/**
 * 隔离可观测（评审 a4）：把导入结果格式化成可落日志/回传的摘要。
 * 静默隔离 = 静默丢失，调用方必须落这份摘要。
 */
export function formatIngestSummary(result: IngestFeedbackResult): string {
  const parts = [`ingested=${result.ingested}`, `deduped=${result.deduped}`]
  if (result.quarantined.length > 0) {
    const byReason = new Map<string, number>()
    for (const q of result.quarantined) byReason.set(q.reason, (byReason.get(q.reason) ?? 0) + 1)
    const detail = [...byReason].map(([reason, n]) => `${reason}:${n}`).join(',')
    parts.push(`quarantined=${result.quarantined.length}(${detail})`)
  }
  return `feedback-ingest ${parts.join(' ')}`
}

/**
 * @param jsonlSource CLI 侧 JSONL store（或等价的 list() 数据源）
 * @param target 主进程权威 SQLite store
 */
export function ingestFeedbackEvents(
  jsonlSource: Pick<JsonlFeedbackEventStore, 'list'>,
  target: Pick<DrizzleFeedbackEventStore, 'append' | 'hasKey'>,
  options: IngestFeedbackOptions = {},
): IngestFeedbackResult {
  const now = options.now ?? Date.now()
  const result: IngestFeedbackResult = { ingested: 0, deduped: 0, quarantined: [] }

  for (const raw of jsonlSource.list()) {
    const normalized = normalizeFeedbackEvent(raw, now)
    if (!normalized.ok) {
      result.quarantined.push({ reason: normalized.reason, raw })
      continue
    }
    const event: HypothesisFeedbackEvent = normalized.event
    if (options.hypothesisExists && !options.hypothesisExists(event.hypothesisId)) {
      result.quarantined.push({ reason: 'unknown_hypothesis', raw })
      continue
    }
    if (target.hasKey(event.idempotencyKey)) {
      result.deduped++
      continue
    }
    const appendResult = target.append(event)
    if (appendResult.appended) result.ingested++
    else if (appendResult.deduped) result.deduped++
  }

  return result
}
