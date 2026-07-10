/**
 * EvaluationEventSchema — Config Event Schema 版本注册表 + 迁移层
 *
 * eventSchemaVersion 嵌入 Config Snapshot Payload JSON 而非 Event 信封，
 * 这样无需改 DB schema。旧事件无 eventSchemaVersion 字段 → 默认 v1。
 *
 * 后续加字段流程：
 * 1. EVENT_SCHEMA_VERSIONS['guardrail.config.activated'] = 2
 * 2. 新增 GuardrailPolicyConfig 字段 + DEFAULT 值
 * 3. 在 migrateConfigPayload 中加 case v1→v2 backfill 新字段为 DEFAULT
 * 4. Policy 始终读完整 config（永不 undefined）
 */

// ══════════════════════════════════════════════
// Schema Version Registry
// ══════════════════════════════════════════════

/**
 * 当前 schema version registry。
 * key = EventType，value = 当前版本号。
 * 只包含 config-related event types（其他 event type 暂不纳入 schema version 管理）。
 */
export const EVENT_SCHEMA_VERSIONS: Record<string, number> = {
  'guardrail.config.initialized': 1,
  'guardrail.config.activated': 1,
  'guardrail.config.rollback': 1,
  // M7: governance event types that carry payload schemas
  'guardrail.recommendation.created': 1,
  'guardrail.recommendation.approved': 1,
  'guardrail.recommendation.dismissed': 1,
  'guardrail.config.validation_failed': 1,
  'guardrail.projection.rebuilt': 1,
  'guardrail.projection.error': 1,
  'guardrail.health.check': 1,
  // M7.3: policy lifecycle governance event types
  'guardrail.recommendation.approval_requested': 1,
  'guardrail.recommendation.approval_accepted': 1,
  'guardrail.recommendation.approval_rejected': 1,
  'guardrail.recommendation.expired': 1,
  'guardrail.config.terminated': 1,
}

/** guardrail.outcome.observed 当前 schema 版本 */
export const OUTCOME_EVENT_SCHEMA_VERSION = 1

/** 已知的 config-related EventType 集合（ConfigStore 用此白名单过滤事件） */
export const CONFIG_EVENT_TYPES = new Set(['guardrail.config.initialized', 'guardrail.config.activated', 'guardrail.config.rollback'])

/** 已知的 governance EventType 集合 */
export const GOVERNANCE_EVENT_TYPES = new Set([
  'guardrail.recommendation.created',
  'guardrail.recommendation.approved',
  'guardrail.recommendation.dismissed',
  'guardrail.config.validation_failed',
  'guardrail.projection.rebuilt',
  'guardrail.projection.error',
  'guardrail.health.check',
  // M7.3
  'guardrail.recommendation.approval_requested',
  'guardrail.recommendation.approval_accepted',
  'guardrail.recommendation.approval_rejected',
  'guardrail.recommendation.expired',
  'guardrail.config.terminated',
])

/** 所有需要自动 stamp eventSchemaVersion 的 EventType 集合（config + governance） */
export const EVENT_SCHEMA_STAMPED_TYPES = new Set([...Array.from(CONFIG_EVENT_TYPES), ...Array.from(GOVERNANCE_EVENT_TYPES)])

// ══════════════════════════════════════════════
// Query API
// ══════════════════════════════════════════════

/**
 * 查询指定 EventType 的当前 schema 版本。
 * 未知 type 返回 1（兼容旧事件）。
 */
export function getCurrentSchemaVersion(type: string): number {
  return EVENT_SCHEMA_VERSIONS[type] ?? 1
}

// ══════════════════════════════════════════════
// Migration Layer
// ══════════════════════════════════════════════

export interface MigrateConfigPayloadInput {
  version: string
  config: Record<string, unknown>
  activatedAt: number
  [key: string]: unknown
}

/**
 * 迁移 ConfigSnapshotPayload 到当前 schema 版本。
 *
 * 迁移策略：backfill 缺失字段为 DEFAULT 值。
 * 当前所有 config event 都是 v1，所以 v1→current 是 identity。
 * 后续加字段时，在此函数中添加新 case。
 *
 * @param _type EventType
 * @param payload 原始 payload（可能缺少 eventSchemaVersion 字段）
 * @param fromVersion 原始 eventSchemaVersion（缺失时=1）
 * @returns 迁移后的完整 payload
 */
export function migrateConfigPayload(
  _type: string,
  payload: MigrateConfigPayloadInput,
  fromVersion: number = 1,
): MigrateConfigPayloadInput {
  let current = { ...payload }

  if (fromVersion >= getCurrentSchemaVersion(_type)) {
    // Already at or above current version — no migration needed
    return current
  }

  // v1 → current: identity (当前 schema 与 v1 相同)
  // 后续加字段时在此处添加 v2, v3, ... 迁移步骤

  return current
}
