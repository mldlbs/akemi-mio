/**
 * Evaluation Event Protocol — 系统级事件协议
 *
 * 所有可评估事件的统一定义。本文件仅承担协议定义，
 * 不包含 Metrics、Fitness、Scoring、Evolution 等派生概念。
 *
 * 关键约束：
 * - Event 只记录"发生了什么"，绝不记录"意味着什么"
 * - Event 是不可变的追加日志
 * - type 和 payload 的组合构成一个不可逆事实
 *
 * ── 数据流 ──
 * Runtime ─→ Event (不可变事实)
 *                ─→ Metrics Engine (统计 → 指标)
 *                      ─→ Fitness Engine (目标函数 → 适应度)
 *                            ─→ Evolution (决策)
 */

// ══════════════════════════════════════════════
// Envelope Schema Version（M7.1）
// ══════════════════════════════════════════════

/** 当前 Envelope Schema 版本号。
 *  属于 Event 信封层，与 payload 内部的 eventSchemaVersion 正交。
 *  新事件可选填充，缺省 = 1，向后兼容。 */
export const ENVELOPE_SCHEMA_VERSION = 1

// ══════════════════════════════════════════════
// Event 外壳
// ══════════════════════════════════════════════

export interface EvaluationEvent {
  /** 全局唯一事件 ID（UUIDv4） */
  id: string
  /** Envelope schema 版本，缺省 = 1（向后兼容）。与 payload 内的 eventSchemaVersion 正交 */
  schemaVersion?: number
  /** Unix 毫秒时间戳 */
  timestamp: number
  /** 一次请求的全链路追踪 ID */
  traceId: string
  /** 会话 ID */
  sessionId: string
  /** 产生事件的模块名，例如 "ChatExecutor", "WorkflowScheduler", "PipelineOrchestrator" */
  source: string
  /** 事件类型，见 EventType */
  type: EventType
  /** 类型相关的原始数据 */
  payload: EventPayload
  /** 父事件 ID，用于构建因果链 */
  parentEventId?: string
  /** R2-A: Replay 游标序号。flush 时分配，已有行可为 undefined */
  seq?: number
}

// ══════════════════════════════════════════════
// Event 类型枚举
// ══════════════════════════════════════════════

export type EventType =
  // ── Task（任务生命周期） ──
  | 'task.started'
  | 'task.completed'
  // ── Tool（工具调用） ──
  | 'tool.invoked'
  | 'tool.completed'
  // ── Model（LLM 调用） ──
  | 'model.invoked'
  | 'model.completed'
  // ── Message（消息流） ──
  | 'user.message'
  | 'agent.response'
  // ── User Action（用户对输出的操作——不可逆事实） ──
  | 'user.action'
  // ── Workflow（工作流生命周期） ──
  | 'workflow.started'
  | 'workflow.completed'
  // ── Guardrail（干预记录 —— 不可逆事实） ──
  | 'guardrail.checked'
  | 'guardrail.terminated'
  // ── Guardrail Action Delivery（Runtime 执行事实） ──
  | 'guardrail.action_delivered'
  | 'guardrail.action_delivery_failed'
  // ── Guardrail Config Versioning（配置生命周期） ──
  | 'guardrail.config.initialized'
  | 'guardrail.config.activated'
  | 'guardrail.config.rollback'
  // ── Guardrail Outcome Observation（反馈回路） ──
  | 'guardrail.outcome.observed'
  // ── Guardrail Governance（M7 — 治理操作）
  | 'guardrail.recommendation.created'
  | 'guardrail.recommendation.approved'
  | 'guardrail.recommendation.dismissed'
  | 'guardrail.config.validation_failed'
  | 'guardrail.projection.rebuilt'
  | 'guardrail.projection.error'
  // ── Audit（系统操作审计）
  | 'guardrail.health.check'
  // ── Guardrail Governance M7.3（Policy Lifecycle）
  | 'guardrail.recommendation.approval_requested'
  | 'guardrail.recommendation.approval_accepted'
  | 'guardrail.recommendation.approval_rejected'
  | 'guardrail.recommendation.expired'
  // ── Guardrail Config Lifecycle（M7.3 — Config Termination）
  | 'guardrail.config.terminated'
  // ── Evolution Governance（Phase 3C.2）
  | 'evolution.policy.decision'
  // ── Session Memory（ADR-013）
  | 'session.digest.retrieved'
  | 'session.digest.retrieved_noop'
  | 'memory.compaction.failed'

// ══════════════════════════════════════════════
// 任务类别
// ══════════════════════════════════════════════

export type TaskKind =
  | 'chat' // 用户对话
  | 'workflow' // 工作流执行
  | 'maintenance' // 自动维护管道
  | 'evolution' // 进化决策
  | 'evaluation' // 评估回溯
  | 'tool' // 后台工具任务

// ══════════════════════════════════════════════
// Payload 负载（按 type 区分）
// ══════════════════════════════════════════════

export interface TaskStartedPayload {
  kind: TaskKind
  /** 任务描述 / prompt / intent */
  description?: string
  /** 输入长度（字符数） */
  inputLength?: number
}

export interface TaskCompletedPayload {
  kind: TaskKind
  /** 原始终止状态 —— 不是评价 */
  outcome: 'completed' | 'failed' | 'abandoned'
  /** 耗时 ms */
  durationMs: number
  /** 错误消息（仅 outcome=abandoned/failed 时存在） */
  error?: string
}

export interface ToolInvokedPayload {
  /** 工具名称 */
  toolName: string
  /** 工具参数（不含敏感信息） */
  args?: Record<string, unknown>
}

export interface ToolCompletedPayload {
  /** 工具名称 */
  toolName: string
  /** 耗时 ms */
  durationMs: number
  /** 原始输出（截断到安全长度） */
  output?: string
  /** 原始错误消息 */
  error?: string
}

export interface ModelInvokedPayload {
  /** 模型标识 */
  modelName: string
  /** Prompt 字符数 */
  promptLength: number
  /** Prompt token 数（如果 API 返回了） */
  promptTokens?: number
  /** 输入 Token 来源归因（v1.1） */
  tokenBreakdown?: {
    system: number
    memory: number
    retrieval: number
    runtime: number
    user: number
    history: number
    tools: number
  }
}

export interface ModelCompletedPayload {
  /** 模型标识 */
  modelName: string
  /** 耗时 ms */
  durationMs: number
  /** API 返回的 input token 数 */
  inputTokens: number
  /** API 返回的 output token 数 */
  outputTokens: number
  /** 响应字符数 */
  responseLength: number
  /** 响应截断 */
  responsePreview?: string
  /** 原始错误 */
  error?: string
}

export interface UserMessagePayload {
  /** 消息长度 */
  length: number
  /** 内容类型 */
  contentType?: 'text' | 'voice' | 'image' | 'file'
}

export interface AgentResponsePayload {
  /** 响应长度 */
  length: number
  /** 耗时 ms */
  durationMs: number
}

/**
 * User Action — 原始事实，不是 Feedback。
 *
 * 不应包含 accept / reject / good / bad 等解释性语义。
 * 这些应由 Metrics Engine 推导。
 */
export interface UserActionPayload {
  /** 用户动作 */
  action:
    | 'copy' // 复制了回答
    | 'regenerate' // 点击重新生成
    | 'edit' // 修改了回答后发送
    | 'continue' // 继续追问
    | 'new_message' // 新消息（语义切换）
    | 'thumbs_up' // 点赞
    | 'thumbs_down' // 点踩
    | 'close_session' // 关闭会话
  /** 关联的 message ID */
  targetMessageId?: string
}

export interface WorkflowStartedPayload {
  /** 工作流定义 ID */
  workflowId: string
  /** 工作流名称 */
  name?: string
  /** 阶段数 */
  totalPhases: number
}

export interface WorkflowCompletedPayload {
  /** 工作流定义 ID */
  workflowId: string
  /** 原始终止状态 */
  outcome: 'completed' | 'failed' | 'abandoned'
  /** 耗时 ms */
  durationMs: number
  /** 各 agent 调用统计 */
  agentCount: number
  /** 错误消息 */
  error?: string
}

// ══════════════════════════════════════════════
// Guardrail Payloads（干预记录 —— 不可逆事实）
// ══════════════════════════════════════════════

export interface GuardrailCheckedPayload {
  /** 检测时的轮次 */
  turn: number
  /** 决策结果 */
  decision: 'continue' | 'warning' | 'terminate'
  /** 决策原因 */
  reason: string
}

export interface GuardrailTerminatedPayload {
  /** 终止时轮次 */
  turn: number
  /** 终止时已执行轮次 */
  totalTurns: number
  /** 终止原因 */
  reason: string
}

// ══════════════════════════════════════════════
// Guardrail Action Delivery Payloads（Runtime 执行事实）
//
// Decision 层与 Delivery 层职责分离：
//   guardrail.terminated         — Policy 决定终止（但尚未执行）
//   guardrail.action_delivered   — 决策已被 Runtime 成功执行
//   guardrail.action_delivery_failed — 决策未能被 Runtime 执行
//
// Delivery Event 必须通过 decisionId 引用 GuardrailDecision，
// 不允许嵌入 Snapshot、PolicyInput、evaluationSignals 等 Policy 计算输入。
// ══════════════════════════════════════════════

export interface GuardrailActionDeliveredPayload {
  /** 决策 ID，与 GuardrailDecision 关联 */
  decisionId: string
  /** 关联 traceId */
  traceId: string
  /** 实际生效的 RuntimeAction */
  actionType: 'TERMINATE' | 'WARNING' | 'CONTINUE'
  /** Policy 版本 */
  policyVersion: string
  /** 投递时间戳 */
  timestamp: number
}

export interface GuardrailActionDeliveryFailedPayload {
  /** 决策 ID，与 GuardrailDecision 关联 */
  decisionId: string
  /** 关联 traceId */
  traceId: string
  /** Policy 期望的 RuntimeAction */
  intendedAction: 'TERMINATE' | 'WARNING' | 'CONTINUE'
  /** Policy 版本 */
  policyVersion: string
  /** 投递时间戳 */
  timestamp: number
  /** 失败原因 */
  errorCode: string
}

// ══════════════════════════════════════════════
// Guardrail Config Versioning Payloads（配置生命周期）
//
// guardrail.config.activated  — 新版本上线（由 Config Store 生产）
// guardrail.config.rollback   — 版本回退（由 Config Store 生产）
//
// 这些事件不属于 Delivery Trace（不关联具体 Decision），
// 也与 guardrail.checked / guardrail.terminated 正交。
// ══════════════════════════════════════════════

/** Rollback 触发源分类，限定 Metrics 聚合维度 */
export type RollbackTrigger = 'manual' | 'automated_guardrail' | 'deployment_failure'

/**
 * 共享的 Config Snapshot Payload 接口。
 * 用于 guardrail.config.initialized / guardrail.config.activated / guardrail.config.rollback。
 * eventSchemaVersion 嵌入 payload JSON 而非 Event 信封，
 * 这样无需改 DB schema 即可支持 payload schema evolution。
 */
export interface GuardrailConfigSnapshotPayload {
  /** 策略配置实例 Identity */
  version: string
  /** Payload schema 版本（旧事件可能缺失此字段 → 默认 1） */
  eventSchemaVersion: number
  /** 完整 Policy Config snapshot — Replay 自包含 */
  config: import('./GuardrailTypes').GuardrailPolicyConfig
  /** Config 实际生效时间戳（可能与 Event.timestamp 不同） */
  activatedAt: number
  /** M7.3: 触发该 activation 的 recommendationId（可选，人工activation可能无关联推荐） */
  recommendationId?: string
}

/** guardrail.config.initialized — 首次建立 config state（不计入 activation metrics） */
export type GuardrailConfigInitializedPayload = GuardrailConfigSnapshotPayload

/** guardrail.config.activated — 新版本上线（由 Config Store 投影） */
export type GuardrailConfigActivatedPayload = GuardrailConfigSnapshotPayload

export interface GuardrailConfigRollbackPayload {
  /** 回滚前版本（被废弃的版本） */
  fromVersion: string
  /** 回滚目标版本（恢复到的版本） */
  toVersion: string
  /** 回滚来源分类，仅表示触发原因分类，不表示执行命令 */
  trigger: RollbackTrigger
  /** 回滚原因，人工或系统说明，可选 */
  reason?: string
  /** M7.3: 发起该回滚的 recommendationId（可选），关联回滚到批准该配置的推荐 */
  sourceRecommendationId?: string
}

// ══════════════════════════════════════════════
// Outcome Observation（M6.4 — 反馈回路）
// ══════════════════════════════════════════════

export type Outcome = 'effective' | 'ineffective' | 'inconclusive'

export type OutcomeConfidence = 'high' | 'medium' | 'low'

export type OutcomeSource = 'auto' | 'manual'

export interface OutcomeObservedPayload {
  decisionId: string
  traceId: string
  policyVersion: string
  outcome: Outcome
  confidence: OutcomeConfidence
  source: OutcomeSource
  falsePositive?: boolean
  falseNegative?: boolean
  detail: string
  observedAt: number
}

// ══════════════════════════════════════════════
// Governance Payloads（M7 — 治理操作）
// ══════════════════════════════════════════════

export type RecommendationStatus = 'open' | 'pending_approval' | 'accepted' | 'dismissed' | 'expired'

export interface GuardrailRecommendationCreatedPayload {
  recommendationId: string
  policyId: string
  type: 'threshold_adjust' | 'policy_review' | 'no_change'
  confidence: OutcomeConfidence
  evidence: string[]
  detail: string
  triggeredByOutcomeIds: string[]
}

export interface GuardrailRecommendationApprovedPayload {
  recommendationId: string
  policyId: string
  approver: string
  note?: string
}

export interface GuardrailRecommendationDismissedPayload {
  recommendationId: string
  policyId: string
  reason: string
  dismissedBy: string
}

export interface GuardrailConfigValidationFailedPayload {
  policyId: string
  version?: string
  reason: string
  payload: Record<string, unknown>
}

export interface GuardrailProjectionRebuiltPayload {
  projectionName: string
  status: 'completed' | 'partial' | 'failed'
  durationMs: number
  eventCount: number
  windowCount: number
  errorCount: number
}

export interface GuardrailProjectionErrorPayload {
  projectionName: string
  error: string
  eventCount: number
}

export interface GuardrailHealthCheckPayload {
  status: 'HEALTHY' | 'STALE' | 'DEGRADED' | 'UNAVAILABLE'
  componentCount: number
  degradedComponents: string[]
  detail: string
}

// ══════════════════════════════════════════════
// M7.3 — Policy Lifecycle Governance Payloads
// ══════════════════════════════════════════════

export interface GuardrailApprovalRequestedPayload {
  recommendationId: string
  policyId: string
  requestedBy: string
  reason: string
  requestedAt: number
}

export interface GuardrailApprovalAcceptedPayload {
  recommendationId: string
  policyId: string
  approver: string
  note?: string
  decidedAt: number
}

export interface GuardrailApprovalRejectedPayload {
  recommendationId: string
  policyId: string
  rejectedBy: string
  reason: string
  decidedAt: number
}

export interface GuardrailRecommendationExpiredPayload {
  recommendationId: string
  policyId: string
  reason: string
  expiredAt: number
}

export interface GuardrailConfigTerminatedPayload {
  version: string
  reason: string
  terminatedAt: number
}

// ══════════════════════════════════════════════
// Evolution Governance Payloads（Phase 3C.2）
// ══════════════════════════════════════════════

export interface PolicyDecisionPayload {
  /** Execution mode at decision time */
  mode: 'disabled' | 'shadow' | 'enforce'
  /** Policy verdict */
  action: 'execute' | 'skip' | 'block'
  /** Whether tryFix() was actually called */
  executed: boolean
  /** Problem source that triggered this decision */
  source: string
  /** Problem identifier for traceability */
  problemId: string
  /** Policy version string */
  policyVersion: string
  /** Verdict reason from ExecutionPolicy.evaluate() */
  reason: string
  /** Unix ms when the policy decision was made (may differ from event.timestamp) */
  evaluatedAt: number
}

// ══════════════════════════════════════════════
// Session Memory Payloads（ADR-013 — Phase 1 Observation）
// ══════════════════════════════════════════════

export interface SessionDigestRetrievedPayload {
  /** 被召回的 session ID */
  sessionId: string
  /** 匹配的 compaction ID */
  digestId: string
  /** 综合得分 */
  score: number
  /** 各因子得分 */
  matchedFactors: {
    recency: number
    attention?: number
    frequency: number
    importance: number
  }
  /** 估算 token 数 */
  tokenEstimate: number
  /** 来源 session */
  sourceSessionId: string
}

export interface SessionDigestRetrievedNoopPayload {
  /** 本次检索未匹配到任何 digest */
  matchedCount: 0
  /** 检索的会话 ID */
  sessionId: string
}

export interface MemoryCompactionFailedPayload {
  sessionId: string
  error: string
  messageCount: number
}

// ══════════════════════════════════════════════
// Session Memory Payloads（ADR-013 — Phase 2 Scoring Evaluation）
// ══════════════════════════════════════════════

export interface MemoryRetrievalScoredPayload {
  /** 被检索的 session ID */
  sessionId: string
  /** 目标 session 过滤（可选） */
  specSessionId?: string
  /** 数据库中的 compaction 总数 */
  totalCompactions: number
  /** score > 0 的 compaction 数 */
  scoredCount: number
  /** 本次检索是否传入了 attention entities */
  attentionAvailable: boolean
  /** 评分分布摘要 */
  scoreDistribution: {
    min: number
    max: number
    avg: number
    median: number
  }
  /** Top 3 分数（gap 分析用） */
  topScores: number[]
  /** Token budget */
  tokenBudget: number
  /** 实际使用的 token */
  tokenUtilized: number
  /** 最终返回的 compaction 数 */
  resultCount: number
}

export interface MemoryScoringAttentionGapPayload {
  /** 被检索的 session ID */
  sessionId: string
  /** 使用 attention 分支的分数 */
  attentionScore: number
  /** 使用 fallback 分支的分数 */
  fallbackScore: number
  /** 差距绝对值 */
  gap: number
  /** attention 分支的 matchedFactors */
  attentionFactors: {
    recency: number
    attention: number
    frequency: number
    importance: number
  }
  /** fallback 分支的 matchedFactors */
  fallbackFactors: {
    recency: number
    frequency: number
    importance: number
  }
  /** 活跃 attention entity 数量 */
  attentionEntityCount: number
}

export type EventPayload =
  | ({ type: 'task.started' } & TaskStartedPayload)
  | ({ type: 'task.completed' } & TaskCompletedPayload)
  | ({ type: 'tool.invoked' } & ToolInvokedPayload)
  | ({ type: 'tool.completed' } & ToolCompletedPayload)
  | ({ type: 'model.invoked' } & ModelInvokedPayload)
  | ({ type: 'model.completed' } & ModelCompletedPayload)
  | ({ type: 'user.message' } & UserMessagePayload)
  | ({ type: 'agent.response' } & AgentResponsePayload)
  | ({ type: 'user.action' } & UserActionPayload)
  | ({ type: 'workflow.started' } & WorkflowStartedPayload)
  | ({ type: 'workflow.completed' } & WorkflowCompletedPayload)
  | ({ type: 'guardrail.checked' } & GuardrailCheckedPayload)
  | ({ type: 'guardrail.terminated' } & GuardrailTerminatedPayload)
  | ({ type: 'guardrail.action_delivered' } & GuardrailActionDeliveredPayload)
  | ({ type: 'guardrail.action_delivery_failed' } & GuardrailActionDeliveryFailedPayload)
  | ({ type: 'guardrail.config.initialized' } & GuardrailConfigInitializedPayload)
  | ({ type: 'guardrail.config.activated' } & GuardrailConfigActivatedPayload)
  | ({ type: 'guardrail.config.rollback' } & GuardrailConfigRollbackPayload)
  | ({ type: 'guardrail.outcome.observed' } & OutcomeObservedPayload)
  // M7 — Governance
  | ({ type: 'guardrail.recommendation.created' } & GuardrailRecommendationCreatedPayload)
  | ({ type: 'guardrail.recommendation.approved' } & GuardrailRecommendationApprovedPayload)
  | ({ type: 'guardrail.recommendation.dismissed' } & GuardrailRecommendationDismissedPayload)
  | ({ type: 'guardrail.config.validation_failed' } & GuardrailConfigValidationFailedPayload)
  | ({ type: 'guardrail.projection.rebuilt' } & GuardrailProjectionRebuiltPayload)
  | ({ type: 'guardrail.projection.error' } & GuardrailProjectionErrorPayload)
  | ({ type: 'guardrail.health.check' } & GuardrailHealthCheckPayload)
  // M7.3 — Policy Lifecycle Governance
  | ({ type: 'guardrail.recommendation.approval_requested' } & GuardrailApprovalRequestedPayload)
  | ({ type: 'guardrail.recommendation.approval_accepted' } & GuardrailApprovalAcceptedPayload)
  | ({ type: 'guardrail.recommendation.approval_rejected' } & GuardrailApprovalRejectedPayload)
  | ({ type: 'guardrail.recommendation.expired' } & GuardrailRecommendationExpiredPayload)
  | ({ type: 'guardrail.config.terminated' } & GuardrailConfigTerminatedPayload)
  // Phase 3C.2 — Evolution Governance
  | ({ type: 'evolution.policy.decision' } & PolicyDecisionPayload)
  // ADR-013 — Session Memory
  | ({ type: 'session.digest.retrieved' } & SessionDigestRetrievedPayload)
  | ({ type: 'session.digest.retrieved_noop' } & SessionDigestRetrievedNoopPayload)
  | ({ type: 'memory.compaction.failed' } & MemoryCompactionFailedPayload)
  // ADR-013 Phase 2 — Scoring Quality
  | ({ type: 'memory.retrieval.scored' } & MemoryRetrievalScoredPayload)
  | ({ type: 'memory.scoring.attention_gap' } & MemoryScoringAttentionGapPayload)

// ══════════════════════════════════════════════
// 事件消费者接口（供 Metrics / Fitness / Evolution 使用）
// ══════════════════════════════════════════════

/**
 * 事件流 —— 只读的追加日志视图。
 * Metrics Engine 等消费者通过此接口消费事件。
 */
export interface EventStream {
  /** 订阅事件（从当前游标开始） */
  subscribe(handler: (event: EvaluationEvent) => void): () => void
  /** 按时间范围查询已持久化的事件 */
  query(range: { since: number; until?: number; type?: EventType }): Promise<EvaluationEvent[]>
  /** 按 traceId 查询一条完整链路 */
  getTrace(traceId: string): Promise<EvaluationEvent[]>
}

/**
 * EvaluationRepository — Runtime 与存储之间的契约。
 *
 * 统一了写入（append）、读取（query / getTrace）、实时订阅（subscribe）
 * 和生命周期（init / shutdown），替代 EvaluationStoreEngine + EventStream 双接口。
 *
 * 所有存储实现（SQLite / PostgreSQL / DuckDB / OpenTelemetry）只需实现此接口，
 * Runtime 无需感知具体实现。
 */
export interface EvaluationRepository extends EventStream {
  /** 追加一条事件（不可变，追加日志） */
  append(event: EvaluationEvent): void
  /** 初始化存储（建表、建立连接等） */
  init(): Promise<void>
  /** 优雅关闭 */
  shutdown(): Promise<void>
  /** R2-A: 基于 seq 的游标查询。用于 Replay / Projection / Audit 的有界迭代 */
  queryBySeq(afterSeq: number, limit?: number): Promise<EvaluationEvent[]>
  /** R2-A: 返回当前最大 seq 值（用于 checkpoint） */
  getCurrentSeq(): number
}

// ══════════════════════════════════════════════
// Time Window — Metrics / Fitness 的通用时间范围
// ══════════════════════════════════════════════

export interface TimeWindow {
  since: number
  until: number
}

// ══════════════════════════════════════════════
// EventIterator — MetricsEngine 与存储之间的抽象层
//
// MetricsEngine 只通过此接口消费事件，不依赖 EvaluationRepository
// 或任何存储实现。未来支持 Replay / Streaming / Offline Analysis
// 只需替换 EventIterator 实现。
// ══════════════════════════════════════════════

export interface EventIterator {
  /** 获取时间窗口内的事件（可选按类型过滤） */
  getEvents(window: TimeWindow, options?: { type?: EventType }): Promise<EvaluationEvent[]>
}

// ══════════════════════════════════════════════
// MetricSnapshot — Metrics Engine 的稳定输出
//
// 只包含基础指标（Primitive Metrics），无复合指标。
// 复合指标是 Fitness 的职责。
//
// Metric 描述系统，Fitness 评价系统。
// ══════════════════════════════════════════════

export interface MetricSnapshot {
  /** 计算窗口 */
  window: TimeWindow
  /** 采集时间 */
  capturedAt: number
  /** 流量 —— 请求量、完成量 */
  traffic: TrafficMetrics
  /** 质量 —— 完成率、成功率 */
  quality: QualityMetrics
  /** 延迟 —— 响应时间分布 */
  latency: LatencyMetrics
  /** 成本 —— Token 消耗 */
  cost: CostMetrics
}

export interface TrafficMetrics {
  /** 模型调用总次数 */
  totalCalls: number
  /** 成功完成数（不含超时/错误） */
  completedCalls: number
  /** 明确失败数（超时/网络错误/速率限制） */
  failedCalls: number
}

export interface QualityMetrics {
  /** 完成率 = completed / total（0-1） */
  completionRate: number
  /** 每次调用平均输出 token */
  avgOutputTokens: number
}

export interface LatencyMetrics {
  /** 平均耗时 ms */
  avgMs: number
  /** 中位数耗时 ms */
  p50Ms: number
  /** 95 分位耗时 ms */
  p95Ms: number
  /** 最大耗时 ms */
  maxMs: number
}

export interface CostMetrics {
  /** 总输入 token */
  totalInputTokens: number
  /** 总输出 token */
  totalOutputTokens: number
  /** 总 token = input + output */
  totalTokens: number
}

// ══════════════════════════════════════════════
// MetricsEngine 接口
//
// 统一入口：compute(window) → MetricSnapshot
// 非 getLatency() / getTokenUsage() / ...
//
// 原因：
// 1. 同一时间窗口一致性（所有指标来自同一批事件）
// 2. 避免重复扫描 Event（一次迭代计算所有指标）
// 3. 后续方便缓存 + 增量计算（以窗口为单位）
// ══════════════════════════════════════════════

export interface MetricsEngine {
  /** 计算指定时间窗口的所有指标 */
  compute(window: TimeWindow): Promise<MetricSnapshot>
}
