# M7 Governance / Operational Maturity Design Review

> **Phase:** ADR-004 M7
> **Status:** Design Review
> **Date:** 2026-07-10
> **Entry Gates:** M6.4 ✅ — Policy Feedback Loop Gate Pass
> **Upstream Freezes:**
> - M4.3/M4.5 Config Lifecycle — ConfigStore is Event Projection, not a controller
> - M6.3 Observation Boundary — API is read-only, no ConfigStore mutation
> - M6.4 F3 — Recommendation terminates at artifact (text + evidence, no executable config)

---

## G0 — Governance Boundaries

### 核心原则

Governance 层**不修改** M4-M6 的 runtime 能力边界。它的职责是：

```
M4-M6 (建设期):  能做 → 可观测 → 可恢复 → 可分析 → 可反馈
M7 (治理期):     知道"正在发生什么" → 知道"历史上发生了什么"
                  → 知道"这样是否安全" → 能证明"我是对的"
```

### 禁止穿越的边界

| 方向 | 不允许 | 原因 |
|------|--------|------|
| Governance → Runtime | Governance 层不注入/修改 Config | Config 只通过 ConfigStore 消费 config event |
| Governance → ConfigStore | Governance 不直接调用 activate/rollback | 违反 M4.4 |
| Governance → DecisionStore | Governance 不修改决策结果 | DecisionStore 是 runtime 产物 |
| Governance → EvaluationEvent | Governance 不写入 EvaluationEvent | Event 只由 runtime 产生 |

Governance 是**观察者 + 约束者**，不是执行者。

---

## M7.1 — Contract Evolution Governance

### 当前缺口

`EvaluationEventSchema.ts` 有 `EVENT_SCHEMA_VERSIONS` registry + `migrateConfigPayload()`，但：

**已有：**
- 3 个 config event type 在 schema version registry 中（version 1）
- `migrateConfigPayload()` 在 replay 路径上做 backfill
- eventSchemaVersion 嵌入 payload JSON，不改 DB schema

**缺失：**
- 只有 3 个 config event type 被管理，其他 18 种 event type 无 schema version
- Ev 信封本身没有 schemaVersion 字段 → 消费者不知道 payload 版本
- 无删除策略（schema version 只增不减）
- 无 breaking change gate（谁来判定一个变更是否 breaking？）

### G1.1 — Envelope Schema Version

**冻结：EvaluationEvent 信封增加 `schemaVersion` 字段，可选，默认 1。**

```typescript
export interface EvaluationEvent {
  id: string
  timestamp: number
  traceId: string
  sessionId: string
  source: string
  type: EventType
  payload: EventPayload
+ schemaVersion?: number  // 全局 schema 版本，新增
  parentEventId?: string
}
```

- `schemaVersion` = 整个 Event 结构的版本号（非 per-type）
- Payload 内部的 `eventSchemaVersion` 保留（per-type 精细化版本控制）
- 缺省 = 1，向后兼容

**不进入 Design Review 范围：**
- 不定义 `schemaVersion` 的 migration registry（M7.1 Implementation 决定）
- 不要求现有事件填充 schemaVersion（仅新事件可选）

### G1.2 — Schema Retention Policy

**冻结：Config event 的 schema version 永不下线。其他 event type 无版本管理，未来需要时逐 type 加入 registry。**

```
Schema Version 生命周期:
  Created ─→ Active (默认)
               ↓ (新版本发布)
            Deprecated (可读, 不可写)
               ↓ (满足 retention)
            Removed (不可读, 不可写)
```

- Config event 版本永不下线（保留全部历史版本）
- 非 config event type 加入 registry 时才启动版本控制
- Removed 只发生在 event type 整体废弃时（见 M7.4）

**边界：** Version Deprecated → Removed 的 retention 周期由 Operational Governance 定义（M7.2），不在 Contract Evolution 中决定。

### G1.3 — Breaking Change Gate

**冻结：以下变更被视为 breaking，必须升级 schema version + 保留旧 migration：**

| 变更 | 是否 Breaking | 动作 |
|------|--------------|------|
| 新增 optional 字段 | No | 加 DEFAULT backfill |
| 新增 required 字段 | **Yes** | schemaVersion++ + migration case |
| 删除字段 | **Yes** | schemaVersion++ + migration 保留旧字段映射 |
| 修改字段类型 | **Yes** | schemaVersion++ + migration 处理新旧互转 |
| 修改语义（如字段含义变化） | **Yes** | schemaVersion++ + 新字段名 |
| 新增 event type | No | 注册新 type，不影响旧事件 |

Breaking change 必须有对应的 migration function 才能发布。

---

## M7.2 — Operational Governance

### 当前缺口

**已有：**
- `GuardrailMetricsProjection` — `build()` / `rebuild()` / `compute()`
- `GuardrailMetricsStore` — idempotent upsert, query, getLatest
- `GuardrailMetricsQueryService` — 三层状态 READY / REBUILDING / UNAVAILABLE
- `GuardrailDecisionStore` — 3 次重试 + fallback

**缺失：**
- 无 Projection 健康检查（"上次更新是否过时？"）
- 无 Replay Verification 调度（"上次全量还原是否成功？"）
- 无 Durability SLA 定义（"最多丢失多少数据？"）
- 无 Degraded Mode 可见性（"现在系统处于什么降级状态？"）

### G2.1 — Projection Health Check

**冻结：Projection 需要暴露 `healthCheck()` 接口，返回：**

```typescript
interface ProjectionHealth {
  status: 'HEALTHY' | 'STALE' | 'DEGRADED' | 'UNAVAILABLE'
  lastUpdateTimestamp: number | null
  stalenessMs: number | null        // 当前时间 - lastUpdateTimestamp
  stalenessThresholdMs: number      // 阈值，超时 = STALE
  totalWindows: number
  errorCount: number
}
```

- HEALTHY: lastUpdateTimestamp 在阈值内
- STALE: 超过阈值但仍有数据
- DEGRADED: 部分窗口数据不完整
- UNAVAILABLE: 无数据或 store 不可用

**不进入 Design Review 范围：**
- 不定义 `stalenessThresholdMs` 具体值（M7.2 Implementation 决定）
- 不设计告警推送机制（保留 healthCheck 接口，推送由外部系统实现）

### G2.2 — Replay Verification Schedule

**冻结：系统定期执行 Replay Verification，验证全量 Event Log → Projection 的一致性。**

```typescript
interface ReplayVerificationResult {
  id: string
  timestamp: number
  status: 'PASS' | 'FAIL' | 'WARN'
  durationMs: number
  eventCount: number
  mismatches: Array<{
    window: string
    expectedCount: number
    actualCount: number
    delta: number
  }>
  lastVerifiedEventId: string | null
}
```

- Replay Verification 是只读操作，不影响 runtime
- PASS: 所有窗口 match
- FAIL: 存在 mismatch（需要调查）
- WARN: 非关键差异（如时序偏移在窗口边界）

**不进入 Design Review 范围：**
- 不定义执行频率（M7.2 Implementation 决定，建议 <= 6h）
- 不定义自动修复流程（FAIL 产生告警，修复由人判断）

### G2.3 — Durability SLA

**冻结：当前系统的 Durability 保证定义为：**

| 组件 | 写入语义 | Durability 保证 | 恢复方式 |
|------|---------|-----------------|---------|
| EvaluationStore (SQLite) | append-only INSERT | 持久化，事务提交即落地 | N/A |
| GuardrailDecisionStore (内存+SQLite) | 先写内存，异步刷盘 | 最多丢失 ~200ms 窗口 | 重启重建 |
| GuardrailMetricsStore (SQLite) | INSERT OR REPLACE | 持久化 | rebuild() |
| OutcomeStore (查询 EvaluationEvent) | 无独立存储 | 依赖 EvaluationStore | query() |
| GuardrailRecommendationStore | 纯内存 | 重启丢失 | 无持久化 |

- **已知缺口：** RecommendationStore 无持久化，重启丢失所有推荐。（M7.3 解决）
- **可接受缺口：** DecisionStore 200ms 窗口丢失（符合 99.9% SLI 目标）
- **不接受：** EvaluationStore 不能有任何事件丢失（Event 设计保证追加+事务）

### G2.4 — Degraded Mode Visibility

**冻结：EvaluationMetricsQueryService 的 `ProjectionState` 升级为全系统的 `SystemDegradationStatus`：**

```typescript
interface SystemDegradationStatus {
  level: 'NORMAL' | 'DEGRADED' | 'PARTIAL' | 'DOWN'
  components: Array<{
    name: string
    status: 'UP' | 'DEGRADED' | 'DOWN'
    detail: string
    lastChecked: number
  }>
}
```

- NORMAL: 所有组件正常
- DEGRADED: 非关键组件降级（如 RecommendationStore 不可用）
- PARTIAL: 关键组件降级但可用（如 Projection stale）
- DOWN: 关键组件不可用（如 EvaluationStore 不可用）

**不进入 Design Review 范围：**
- 不设计 UI 展示方式（M7 Governance UI 不在 Scope 内）
- 不定义自动降级恢复流程

---

## M7.3 — Policy Lifecycle Governance

### 当前缺口

**已有：**
- `GuardrailConfigStore` — Event projection, activate/rollback replay
- `GuardrailFeedbackAnalyzer` — 生成 Recommendation
- `GuardrailRecommendationStore` — 纯内存 list/get/updateStatus

**缺失：**
- Recommendation 没有持久化（重启丢失）
- 无 Approval 流程（推荐 → 审批 → 激活）
- Config 所有权和激活权限不明确
- Rollback 无自动化触发机制

### G3.1 — Recommendation Persistence

**冻结：guardrail.outcome.observed 事件 schema 扩展，增加 recommendationId 关联字段。**

目前 OutcomePayload:
```typescript
interface OutcomePayload {
  decisionId: string
  policyId: string
  signals: SignalState[]
  outcome: OutcomeSignal       // effective | ineffective | inconclusive
  source: 'auto' | 'manual'
}
```

扩展后：
```typescript
interface OutcomePayload {
  decisionId: string
  policyId: string
  signals: SignalState[]
  outcome: OutcomeSignal
  source: 'auto' | 'manual'
+ recommendationId?: string     // 如果该 outcome 触发了推荐，填写推荐 ID
}
```

Recommendation 本身通过 `guardrail.recommendation.created` 新事件持久化到 EvaluationStore。

**不需要新的独立存储。** Recommendation 是全量 Event Log 的可查询子集。

### G3.2 — Approval Flow Boundary

**冻结：Recommendation 状态机为：**

```
Created (open)
  ↓
Accepted ──→ ConfigStore.activateConfig() ⚠️ 见下
  ↓
Dismissed
```

**⚠️ 关键决策：ConfigStore.activateConfig() 不由 Governance 层调用。**

```
Recommendation
      ↓ 人工审批通过
Approval Record (guardrail.recommendation.approved 事件)
      ↓ 人工操作（独立控制面）
ConfigStore.activateConfig(newConfig)
      ↓
guardrail.config.activated 事件
```

理由：
- M7.3 不引入自动 Config 变更
- Approval → Activation 之间允许人工间隔（冷却期）
- Approval 和 Activation 是两件独立的事（谁批准 ≠ 谁执行）

### G3.3 — Activation / Rollback Authority

**冻结：Config 的变更权限矩阵为：**

| 操作 | 谁可以 | 审计要求 | 冷却期 |
|------|--------|---------|--------|
| Config Activate | 系统初始化自动 | Event + 初始化时间戳 | N/A |
| Config Activate | 人工运维 | Event + 人工确认记录 | 无 |
| Config Rollback | 人工运维 | Event + 回滚原因 + 影响评估 | 5 分钟冷却 |
| Recommendation Accept | 人工运维 | Event + 证据链引用 | 无 |

**不进入 Design Review 范围：**
- 不定义"人工运维"的具体身份认证方式（外部 IAM 集成）
- 不定义冷却期的可配置性

### G3.4 — No Automated Optimization

**冻结：M7.3 保持 M6.4 F4 的决策：推荐终止于推荐，不自动执行。**

```
M6.4 决定:     Recommendation → artifact (文本 + 证据)
M7.3 决定:     Recommendation → Event → Approval → (人工) → Activation

不改变的:      Recommendation → ConfigStore (自动)   ✗ 禁止
```

---

## M7.4 — Audit Completeness

### 当前缺口

**已有：**
- 21 种 EventType 覆盖 task/tool/model/user/agent/workflow/guardrail 生命周期
- 5 种 guardrail config lifecycle events（initialized / activated / rollback / checked / terminated）
- 2 种 delivery trace events（action_delivered / action_delivery_failed）
- 1 种 outcome event（guardrail.outcome.observed）

**缺失的事件：**
- ❌ 无 `guardrail.recommendation.created`（推荐生命周期）
- ❌ 无 `guardrail.recommendation.approved`
- ❌ 无 `guardrail.recommendation.dismissed`
- ❌ 无 `guardrail.config.validation_failed`
- ❌ 无 `guardrail.projection.rebuild`（重建记录）
- ❌ 无 `guardrail.projection.error`

### G4.1 — New Event Types

**冻结：新增以下 EventType 覆盖 control-plane action：**

```typescript
export type EventType =
  // ... 现有 21 种 ...

+ // ── Governance（治理操作）
+ | 'guardrail.recommendation.created'
+ | 'guardrail.recommendation.approved'
+ | 'guardrail.recommendation.dismissed'
+ | 'guardrail.config.validation_failed'
+ | 'guardrail.projection.rebuilt'
+ | 'guardrail.projection.error'

+ // ── Audit（系统操作审计）
+ | 'guardrail.health.check'
```

### G4.2 — Audit Completeness Verification

**冻结：以下问题必须能通过 Event 日志回答：**

| 问题 | 所需事件链 |
|------|-----------|
| "为什么这个 Policy 现在生效？" | initialized → activated → (可能的 rollback → activated) |
| "谁批准了这次变更？" | recommendation.created → recommendation.approved → config.activated |
| "上次全量重建是否成功？" | projection.rebuilt（包含 status / duration / eventCount）|
| "Config 是否被拒绝过？" | validation_failed（包含 reason / payload）|
| "这个 recommendation 为什么被驳回？" | recommendation.created → recommendation.dismissed（dismissed 包含 reason）|

**边界要求：**
- 每个 Event 必须有 traceId（不要求 parentEventId，但推荐链完整）
- 每个 Event 写入 EvaluationStore 后才执行对应动作（写后执行，非执行后写）
- 非关键 Event（如 projection.rebuilt）失败也不阻止重建（best-effort appended）

**不进入 Design Review 范围：**
- 不要求现有数据补全事件（M7.4 起新产生的事件遵循）
- 不要求 Event 的即时一致性（EvaluationStore append 是同步事务）

### G4.3 — Event 类型废弃流程

**冻结：Event type 废弃遵循以下流程：**

```
1. 确定该 type 不再被任何消费者使用（Consumer Registry 中无引用）
2. 标记 deprecated（Event 仍然可读，新代码不生产）
3. 等待 retention period（M7.2 定义）
4. 移除 type 定义（不再生产；旧数据在 EvaluationStore 中保留 raw JSON）
```

- 移除 type 定义 ≠ 删除 EvaluationStore 中的旧事件
- 旧事件保留 raw JSON 以保证历史可重建

---

## G5 — M7 实现顺序

### Phase 1 — M7.1 + M7.4（基础设施）

1. ✅ `EvaluationEvent.schemaVersion` 字段（G1.1）
2. ✅ 新增 7 种 EventType（G4.1）
3. ✅ `EVENT_SCHEMA_VERSIONS` 注册完整 governance event type
4. ✅ `CONFIG_EVENT_TYPES` 与 `GOVERNANCE_EVENT_TYPES` 分离

### Phase 2 — M7.3（Policy Lifecycle）

1. 🟡 Recommendation Event → EvaluationStore（G3.1 + G4.1 — seed only, not gated）
2. 🟡 Approval 状态机 + Event Type（seed only）
3. ⏸ Validation Failed Event 集成到 ConfigStore

### Phase 3 — M7.2（Operational）

1. ✅ Projection Health Check 接口（G2.1）
2. ✅ Replay Verification（G2.2）
3. ✅ SystemDegradationStatus（G2.4）
4. ⏸ Durability SLA 基线文档（G2.3）

### 实现约束

- `GuardrailHealthService` 不拥有 control-plane 权限（不触发 repair / activate / rollback）
- `verifyProjectionConsistency()` 严格只读（不修改 EvaluationStore / MetricsStore / ConfigStore）
- 默认 staleness threshold = 2h（可在构造时覆盖）
- Legacy event 向后兼容（undefined schemaVersion → 1）

### 测试覆盖目标

- ✅ M7.1: schemaVersion migration + GOVERNANCE_EVENT_TYPES 注册 (11 tests)
- ✅ M7.2: healthCheck 四种聚合状态 + replay verification PASS/FAIL/WARN (9 tests)
- ⏸ M7.3: recommendation event chain (pending formal gate)
- ⏸ M7.4: audit trail 完整性验证 (pending)
