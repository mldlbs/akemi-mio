/**
 * HypothesisFeedbackEvent — 正向反馈闭环证据层（设计 v1.0，P0）
 *
 * 只做三件事：类型契约、规范化校验、幂等键构建。
 * 不做聚合/权重/快照（P1 的 FeedbackLearningService），
 * 不写 Memory、不改 Hypothesis.status、不进晋级门输入。
 *
 * 双轴落点：
 * - CLI/MCP 生产端 → JSONL `feedback-events.jsonl`（交换格式，见 JsonlFeedbackEventStore）
 * - 主进程权威侧 → SQLite `hypothesis_feedback_events`（见 DrizzleFeedbackEventStore）
 * 唯一真相源方向：CLI 只追加 JSONL，主进程 ingest 单向导入（spec §九 R3）。
 */

export const FEEDBACK_EVENT_SCHEMA_VERSION = 1

export type HypothesisFeedbackEventType =
  | 'validated'
  | 'adopted'
  | 'implemented'
  | 'rejected'
  | 'regression_failed'

export type HypothesisFeedbackSourceType = 'experiment' | 'memory' | 'adoption' | 'commit' | 'manual'

export interface HypothesisFeedbackEvent {
  /** 全局唯一事件 ID */
  id: string
  /** 关联假设 UUID（必须指向真实假设，由调用方在入库前校验） */
  hypothesisId: string
  eventType: HypothesisFeedbackEventType
  sourceType: HypothesisFeedbackSourceType
  /** 来源记录 ID（adopt 事件 trace id、memory id、experiment run id 等） */
  sourceId: string
  /** 来源版本/契约版本，可选 */
  sourceVersion?: string
  /** 实现关联 commit SHA（eventType=implemented 时必填） */
  commitSha?: string
  /** 实验运行 ID，可选 */
  experimentRunId?: string
  /** 验证报告/审计记录引用，可选 */
  evidenceRef?: string
  /** 事件发生时间，epoch ms */
  occurredAt: number
  /** 入库/规范化时间，epoch ms */
  ingestedAt: number
  /** 幂等键：同键只允许生效一次（唯一约束） */
  idempotencyKey: string
  schemaVersion: number
}

export const FEEDBACK_EVENT_TYPES: readonly HypothesisFeedbackEventType[] = [
  'validated',
  'adopted',
  'implemented',
  'rejected',
  'regression_failed',
]

export const FEEDBACK_SOURCE_TYPES: readonly HypothesisFeedbackSourceType[] = [
  'experiment',
  'memory',
  'adoption',
  'commit',
  'manual',
]

/** 输入契约：调用方给出自然键字段，id/ingestedAt/idempotencyKey 由规范化器补齐。 */
export interface HypothesisFeedbackEventInput {
  hypothesisId: string
  eventType: HypothesisFeedbackEventType
  sourceType: HypothesisFeedbackSourceType
  sourceId: string
  sourceVersion?: string
  commitSha?: string
  experimentRunId?: string
  evidenceRef?: string
  /** epoch ms 或 ISO 8601 字符串 */
  occurredAt?: number | string
  id?: string
  idempotencyKey?: string
}

export type NormalizeQuarantineReason =
  | 'missing_hypothesis_id'
  | 'invalid_event_type'
  | 'invalid_source_type'
  | 'missing_source_id'
  | 'missing_commit_sha_for_implemented'
  | 'invalid_occurred_at'

export type NormalizeResult =
  | { ok: true; event: HypothesisFeedbackEvent }
  | { ok: false; reason: NormalizeQuarantineReason; raw: unknown }

function toEpochMs(value: number | string | undefined, now: number): number | null {
  if (value === undefined || value === null || value === '') return now
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/**
 * 幂等键 = 自然键拼接。同 hypothesisId+eventType+sourceType+sourceId(+commitSha/experimentRunId)
 * 的重复提交会得到同键，存储层靠唯一约束去重。
 */
export function buildFeedbackIdempotencyKey(parts: {
  hypothesisId: string
  eventType: string
  sourceType: string
  sourceId: string
  commitSha?: string
  experimentRunId?: string
}): string {
  return [
    parts.hypothesisId,
    parts.eventType,
    parts.sourceType,
    parts.sourceId,
    parts.commitSha || '',
    parts.experimentRunId || '',
  ].join(':')
}

function newEventId(): string {
  return `fbe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 规范化 + 校验。不合格事件不丢弃、不生效——调用方写入隔离队列。
 * 注意：本函数不校验 hypothesisId 是否指向真实假设（那需要 store 查询），
 * 由生产者/ingest 在调用前或调用后单独把关（spec §五.1）。
 */
export function normalizeFeedbackEvent(raw: unknown, now: number = Date.now()): NormalizeResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'missing_hypothesis_id', raw }
  }
  const input = raw as HypothesisFeedbackEventInput
  const hypothesisId = typeof input.hypothesisId === 'string' ? input.hypothesisId.trim() : ''
  if (!hypothesisId) {
    return { ok: false, reason: 'missing_hypothesis_id', raw }
  }
  if (!FEEDBACK_EVENT_TYPES.includes(input.eventType)) {
    return { ok: false, reason: 'invalid_event_type', raw }
  }
  if (!FEEDBACK_SOURCE_TYPES.includes(input.sourceType)) {
    return { ok: false, reason: 'invalid_source_type', raw }
  }
  const sourceId = typeof input.sourceId === 'string' ? input.sourceId.trim() : ''
  if (!sourceId) {
    return { ok: false, reason: 'missing_source_id', raw }
  }
  const commitSha = typeof input.commitSha === 'string' && input.commitSha.trim() ? input.commitSha.trim() : undefined
  if (input.eventType === 'implemented' && !commitSha) {
    return { ok: false, reason: 'missing_commit_sha_for_implemented', raw }
  }
  const experimentRunId =
    typeof input.experimentRunId === 'string' && input.experimentRunId.trim() ? input.experimentRunId.trim() : undefined
  const sourceVersion =
    typeof input.sourceVersion === 'string' && input.sourceVersion.trim() ? input.sourceVersion.trim() : undefined
  const evidenceRef = typeof input.evidenceRef === 'string' && input.evidenceRef.trim() ? input.evidenceRef.trim() : undefined
  const occurredAt = toEpochMs(input.occurredAt, now)
  if (occurredAt === null) {
    return { ok: false, reason: 'invalid_occurred_at', raw }
  }
  const idempotencyKey =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim()
      ? input.idempotencyKey.trim()
      : buildFeedbackIdempotencyKey({ hypothesisId, eventType: input.eventType, sourceType: input.sourceType, sourceId, commitSha, experimentRunId })

  const event: HypothesisFeedbackEvent = {
    id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : newEventId(),
    hypothesisId,
    eventType: input.eventType,
    sourceType: input.sourceType,
    sourceId,
    ...(sourceVersion ? { sourceVersion } : {}),
    ...(commitSha ? { commitSha } : {}),
    ...(experimentRunId ? { experimentRunId } : {}),
    ...(evidenceRef ? { evidenceRef } : {}),
    occurredAt,
    ingestedAt: now,
    idempotencyKey,
    schemaVersion: FEEDBACK_EVENT_SCHEMA_VERSION,
  }
  return { ok: true, event }
}

/** 证据维度归类（spec §五.0）：选择 / 质量 / 落地。聚合时分维度累计，不合并成"成功次数"。 */
export function feedbackEvidenceDimension(eventType: HypothesisFeedbackEventType): 'selection' | 'quality' | 'landing' | 'negative' {
  switch (eventType) {
    case 'adopted':
      return 'selection'
    case 'validated':
      return 'quality'
    case 'implemented':
      return 'landing'
    case 'rejected':
    case 'regression_failed':
      return 'negative'
    default:
      return 'negative'
  }
}
