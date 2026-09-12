# M6.1 Analytics Contract — Design Review

## Context

M4–M5 完成了 Evaluation 的 infrastructure layer：

| Phase | Deliverable |
|-------|-------------|
| M4.1–M4.6 | Event sourcing, Config projection, Schema evolution, Replay durability |
| M5.1–M5.4 | Runtime boundary, Integration verification, Decision query API, Reliability hardening |

M5 交付时 state of guardrail events:

```typescript
// types.ts current:
GuardrailCheckedPayload {
  turn: number
  decision: 'continue' | 'warning' | 'terminate'
  reason: string
}

GuardrailTerminatedPayload {
  turn: number
  totalTurns: number
  reason: string
}
```

M6 阶段关注点从 correctness 转向 operational intelligence。但在设计 Metrics projection 之前，需要冻结 Analytics 层的三个前置合约。

---

## S1 — Analytics Event Boundary

### 候选

A: 全量 `EvaluationEvent` 作为 Analytics truth source
B: 仅 `guardrail.*` 事件集

### 冻结决策 — 全量 Event Log 作为 Truth Source

**Analytics Projection 读 EvaluationStore，不读 DecisionStore。**

原因：
- Event log 是不可变事实流，DecisionStore 是 runtime optimization
- Analytics 不应依赖存活状态（DecisionStore 可能 degrade 为 empty）
- 未来可能需要结合 `model.invoked` / `tool.completed` 等非 guardrail 事件做 Effectiveness 分析

**实现原则**：
- Analytics projection 的输入 = `EvaluationStore.query()` 结果
- Analytics projection 不直接依赖 `GuardrailDecisionStore` 或 `Pipeline`
- `guardrail.*` 事件集在 Projection 层过滤，不在 EventType 命名约定层级限制

### 影响
- `EvaluationStore` 的 query 能力已足够（timestamp range + type filter + limit）
- M6.2 Metrics Projection 只读不写
- 不修改 `ChatExecutor` / `GuardrailPipeline`

---

## S2 — Guardrail Event Schema

### 现状缺口

当前 `guardrail.checked` / `guardrail.terminated` payload 缺少 decision 关联字段：

| 字段 | checked | terminated | 需要？ |
|------|---------|------------|--------|
| `turn` | ✅ | ✅ | |
| `decision` / `action` | ✅ (decision) | ❌ | |
| `reason` | ✅ | ✅ | |
| `totalTurns` | ❌ | ✅ | |
| `decisionId` | ❌ | ❌ | **是 — 关联 Decision** |
| `traceId` | ❌ | ❌ | **是 — 关联 Trace** |
| `policyVersion` | ❌ | ❌ | **是 — Policy 版本基线** |
| `signals` | ❌ | ❌ | **是（可选）— Signal 级指标** |

### 冻结决策 — 扩展 Event Schema

**`GuardrailCheckedPayload` 扩展：**

```typescript
export interface GuardrailCheckedPayload {
  turn: number
  decision: 'continue' | 'warning' | 'terminate'
  reason: string

  // M6.1 Analytics 追加字段：
  decisionId: string    // 引用 GuardrailDecision
  traceId: string       // 引用 Trace
  policyVersion: string  // Policy 版本基线（用于版本同比）
  signals?: SignalState[]  // 可选：Signal 级状态快照
}
```

**`GuardrailTerminatedPayload` 扩展：**

```typescript
export interface GuardrailTerminatedPayload {
  turn: number
  totalTurns: number
  reason: string

  // M6.1 Analytics 追加字段：
  decisionId: string
  traceId: string
  policyVersion: string
}
```

### 实现策略

- `GuardrailPipeline.emitGuardrailEvents()` 已有 `PipelineResult` 和 `traceId` 上下文
- `PipelineResult` 包含 `decisionId`、`runtimeAction`、`decision`
- `decision.policyVersion` 已在 Decision 对象中
- `decision.signals` 可选挂载（序列化为 `SignalState[]`）

**不需要新增 DB migration** — payload 作为 JSON 写入 `evaluation_events` 表的 `payload` 列，schema 由 `eventSchemaVersion` 管控（M4.5 已实现）。

### Schema Version 策略

当前 `guardrail.checked` 和 `guardrail.terminated` 不在 `EVENT_SCHEMA_VERSIONS` 注册表中。M6.1 将这两类加入 registry：

```typescript
// EvaluationEventSchema.ts
EVENT_SCHEMA_VERSIONS: {
  'guardrail.config.initialized': 1,
  'guardrail.config.activated': 1,
  'guardrail.config.rollback': 1,
  'guardrail.checked': 1,         // M6.1: base schema (turn + decision + reason)
  'guardrail.checked.v2': 2,       // future: with decisionId + traceId + policyVersion
  'guardrail.terminated': 1,      // M6.1: base schema
  'guardrail.terminated.v2': 2,   // future: with decisionId + traceId + policyVersion
}
```

### 向后兼容

当前 `guardrail.checked` 事件已在 M4–M5 运行时产生。Analytics projection 需要处理无 `decisionId` / `traceId` / `policyVersion` 的历史事件。

处理策略：
- history 无这些字段 → `null`
- Metrics projection 跳过 `decisionId = null` 的记录（不计入 decision 关联指标）
- projection 层做 null check，不抛异常

---

## S3 — Decision Signal Normalization

### 现状

```typescript
// GuardrailDecisionStore.DecisionRecord
signals: string  // JSON-serialized SignalState[]
```

Runtime 层面信号结构允许任意 `SignalState[]`：

```typescript
SignalState {
  name: string    // 自由字符串
  status: 'healthy' | 'degrading' | 'stalled'
  detail: string  // 自然语言
}
```

### 冻结决策 — 两层分离

**Runtime 层保持灵活：**

- Policy 可自由产生 `SignalState[]`（无 schema 约束）
- 不要求 Policy 现在结构化的所有 signal fields

**Analytics 层拥有稳定 projection：**

```typescript
// Analytics projection 内部结构（非 Event schema）
interface NormalizedSignals {
  stateChange: 'healthy' | 'degrading' | 'stalled' | null
  informationGain: 'healthy' | 'degrading' | 'stalled' | null
  goalProgress: 'healthy' | 'degrading' | 'stalled' | null
}
```

由 projection 层负责 `signals: SignalState[]` → `normalizedSignals: NormalizedSignals` 的转换。若未来 Policy 新增 signal type，只需扩展 `NormalizedSignals`，不修改 Event schema。

### Migration Path

```
M6.2:
    MetricsProjection.build(events: EvaluationEvent[])
        → 解析 guardrail.checked.payload
        → 提取 signals → normalize
        → 写入 MetricsStore

M6.4:
    Policy 可能新增 signal 类型
        → NormalizedSignals 扩展
        → projection 层升级
        → MetricsStore schema evolution
```

---

## Frozen Contract

| S# | Decision | Detail |
|----|----------|--------|
| S1 | Event input boundary | Analytics truth source = EvaluationStore（全量 Event Log）；Projection 层过滤；DecisionStore 不可用作 Analytics input |
| S2 | Guardrail event schema | `guardrail.checked`/`guardrail.terminated` 扩展 `decisionId`/`traceId`/`policyVersion`/`signals`；纳入 `EVENT_SCHEMA_VERSIONS` registry；历史事件 null-check 兼容 |
| S3 | Signal normalization | Runtime 层保持 `SignalState[]` 自由；Analytics 层拥有 `NormalizedSignals` 稳定 schema；projection 层负责转换 |

## M6 Implementation Sequence

```
M6.1 ✅ Analytics Contract Freeze（本文档）
M6.2 ⏸ Metrics Projection — MetricsStore schema + build() + tests
M6.3 ⏸ Evaluation Dashboard/API — IPC handler + Renderer bridge
M6.4 ⏸ Policy Feedback Loop — OutcomeSignal + Config recommendation boundary
```

## Non-Goals (explicitly out of scope for M6.1)

- ❌ MetricsStore schema design（M6.2）
- ❌ Analytics API endpoint（M6.3）
- ❌ Adaptive Policy（M6.4+）
- ❌ Dashboard UI（M6.3+）

## Document Status

- **Review Date:** 2026-07-10
- **Status:** ✅ Frozen
- **Next:** M6.2 Metrics Projection Plan
