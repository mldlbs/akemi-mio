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
// Event 外壳
// ══════════════════════════════════════════════

export interface EvaluationEvent {
  /** 全局唯一事件 ID（UUIDv4） */
  id: string
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
  | 'guardrail.config.activated'
  | 'guardrail.config.rollback'

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

export interface GuardrailConfigActivatedPayload {
  /** 新上线的版本 Identity */
  version: string
  /** Config 实际生效时间戳（可能与 Event.timestamp 不同） */
  activatedAt: number
}

export interface GuardrailConfigRollbackPayload {
  /** 回滚前版本（被废弃的版本） */
  fromVersion: string
  /** 回滚目标版本（恢复到的版本） */
  toVersion: string
  /** 回滚来源分类，仅表示触发原因分类，不表示执行命令 */
  trigger: RollbackTrigger
  /** 回滚原因，人工或系统说明，可选 */
  reason?: string
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
  | ({ type: 'guardrail.config.activated' } & GuardrailConfigActivatedPayload)
  | ({ type: 'guardrail.config.rollback' } & GuardrailConfigRollbackPayload)

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
