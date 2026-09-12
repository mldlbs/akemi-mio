# M6.4 Policy Feedback Loop Design Review

> **Phase:** ADR-004 M6.4
> **Status:** Design Review
> **Date:** 2026-07-10
> **Entry Gates:** M6.3 ✅ — Dashboard/API Gate Pass
> **Upstream Freezes:**
> - M4.3/M4.5 Config Lifecycle — ConfigStore is Event Projection, not a controller
> - M6.1 Analytics Contract — EvaluationEvent is truth source
> - M6.3 Observation Boundary — API is read-only, no ConfigStore mutation

---

## F1 — Feedback Signal Source

### 当前缺口

GuardrailPipeline 目前：
```
evaluate(input) → decision
                     ↓
                  GuardrailDecisionStore
```
决策产生了，但**决策是否正确无从得知**。反馈回路需要一个新的信号。

### Allowed Sources

```
OutcomeSignal (新事件类型, 通过 EvaluationEmitter 写入)
      ↓
EvaluationStore (truth source)
      ↓
Feedback Analyzer (只读查询)
      ↓
Recommendation (终止于推荐)

不允许的路径:
  MetricsStore → ConfigStore                   ✗ 违反 M6.3
  EvaluationEvent → ConfigStore                 ✗ 违反 M4.4 (ConfigStore 只消费 config event)
  DecisionStore → OutcomeSignal                 ✗ DecisionStore 无 outcome 信息
```

### Decision

**冻结: Feedback 的事实源是 `guardrail.outcome.observed` 事件。** 这是一个新 EvaluationEvent type，写入 EvaluationStore。Feedback Analyzer 通过 EvaluationStore.query() 读取。

### 为什么不是 Metrics Projection

| 来源 | 是否可用 | 原因 |
|------|----------|------|
| MetricsStore (aggregation) | ✗ | 聚合丢失了 per-decision 的 outcome 对应关系 |
| EvaluationEvent (全量) | ✓ | 可以扩展事件类型，保持单一 truth source |
| DecisionStore | ✗ | 只记录决策本身，无 outcome 字段 |

---

## F2 — OutcomeSignal Contract

### 事件定义

```typescript
// 新 EvaluationEvent type
type EventType += 'guardrail.outcome.observed'

interface OutcomeSignalPayload {
  type: 'guardrail.outcome.observed'
  payload: {
    // 关联的决策
    decisionId: string
    traceId: string
    policyVersion: string   // 决策时的 policy 版本

    // Outcome 评估
    outcome: 'effective' | 'ineffective' | 'inconclusive'
    confidence: 'high' | 'medium' | 'low'

    // 错误类型（当 outcome 为 ineffective 时建议填写）
    falsePositive?: boolean   // 警告/终止了不需要干预的情况
    falseNegative?: boolean   // 应当干预但未干预的情况

    // 上下文
    observedAt: number
    source: 'auto' | 'manual'   // 自动检测还是人工标注
    detail: string              // 自然语言描述
  }
}
```

### Outcome 语义

| Outcome | 含义 | 示例 |
|---------|------|------|
| `effective` | 决策在当时场景下是合适的 | terminate 后用户调整了行为，对话恢复 |
| `ineffective` | 决策不合适或被证明错误 | warning 被忽视，问题复现；terminate 打断了正常对话 |
| `inconclusive` | 无法判断效果 | 决策后对话结束，无后续上下文 |

### Source 角色

| Source | 生产者 | 时序 |
|--------|--------|------|
| `auto` | ProgressObserver/GuardrailProgressAnalyzer | 实时（decision 后 N 轮自动判断） |
| `manual` | Dashboard UI / 管理 API（M6.4+） | 任意时间点 |

### 写入路径

```
GuardrailPipeline
    ↓
GuardrailDecisionStore  (现有路径，保留)
    ↓
ProgressObserver
    ↓ (新增)
OutcomeAnalyzer  (新)
    ↓
EvaluationEmitter.emit('guardrail.outcome.observed', payload)
    ↓
EvaluationStore
```

> **Decision: OutcomeAnalyzer 是可选组件。** 首版不实现自动 outcome 检测，只定义事件 schema，写入阶段 defer 到 implementation 时决定是否实现自动源。

---

## F3 — Recommendation Boundary

### 强制边界

```
允许的路径:

  OutcomeSignal
      ↓
  FeedbackAnalyzer
      ↓
  Recommendation (artifact)
      ↓
  Human Review
      ↓
  Manual Config Activation (通过现有 activateConfig() 生命周期)

严格禁止的路径:

  FeedbackAnalyzer → ConfigStore.activateConfig()    ✗
  FeedbackAnalyzer → Policy (直接修改)                ✗
  Metrics Pipeline → ConfigStore                      ✗ (M6.3 冻结)
```

### Recommendation 定义

```typescript
interface GuardrailRecommendation {
  id: string
  createdAt: number
  // 建议类型
  type: 'threshold_adjust' | 'policy_review' | 'no_change'

  // 证据
  evidence: {
    decisionIds: string[]        // 相关的决策
    ineffectiveCount: number     // 无效决策数
    totalDecisions: number       // 总决策数
    ineffectiveRate: number      // 无效率
    primaryIssue: string         // 主要问题描述
  }

  // 建议（不包含可执行 config，只包含人类可读的建议）
  suggestion: string

  // 置信度
  confidence: 'high' | 'medium' | 'low'

  // 状态
  status: 'open' | 'accepted' | 'dismissed'
  resolvedAt?: number
}
```

### Recommendation 在系统中的位置

```
FeedbackAnalyzer (新)
      ↓
GuardrailRecommendationStore (新 — 仅持久化推荐，不包含可执行 config)
      ↓
Query API (新 IPC channel, 只读)
      ↓
Widget/UI 提示
      ↓
Human 手动进入 Config Management → activateConfig()

FeedbackAnalyzer 不:
  - 写入 EvaluationEvent
  - 修改 ConfigStore
  - 修改 Policy
  - 产生 config candidate
```

---

## F4 — Policy Evolution Model

### 选项评估

| Option | 描述 | 建议 |
|--------|------|------|
| **A — 仅推荐 (Recommended)** | Feedback 只产生人类可读的建议 | ✅ M6.4 采用 |
| B — Candidate Config | 建议包含可执行的 config diff | ⏸ defer (属于 Config 的自动 proposal，当前 ALP 不支持) |
| C — 自动优化 | Metrics → Config 闭环 | ❌ 违反 M4.3/M4.5 Config lifecycle，绕过 Event log |

### 为什么不是 B 或 C

**Option B (Candidate Config)** 的缺口：
- 当前没有 Config Proposal 的 Event type
- Config 变更需要 version allocation + Event emission + ConfigStore.applyActivated()
- 生成 candidate config 意味着 FeedbackAnalyzer 需要理解 `GuardrailPolicyConfig` schema，这是新的职责边界
- 可以 defer 到 M6.5+，前提是先定义 Config Proposal Event

**Option C (Auto-optimize)** 的核心矛盾：
- M4.3/M4.5 建立了严格的 Config lifecycle：change → event → projection
- 自动优化会**绕过 Event log**，使 ConfigStore 的状态与 EvaluationEvent 不一致
- 如果需要 auto-optimize，必须在 EvaluationEvent schema 中先定义 config.proposed 事件，且仍然需要 human approve 步骤

### Decision

**M6.4 采用 Option A。** 冻结内容：

```
FeedbackAnalyzer
    ↓ (只产生)
Recommendation (文本 + 证据)
    ↓
Human Review (外部流程)
    ↓
Manual activateConfig() (通过现有生命周期)

- 不产生 candidate Config
- 不自动修改 Policy
- 不引入 Config proposal event type
```

---

## Implementation Plan

### Files to Create

| File | Role |
|------|------|
| `src/main/core/evaluation/GuardrailRecommendationStore.ts` | Recommendation 持久化（in-memory + 可选 JSON 持久化） |
| `src/main/core/evaluation/GuardrailRecommendationStore` 的 schema | (可选 SQLite 表，首版 in-memory) |
| `src/main/core/evaluation/OutcomeSignalPayload.ts` | 新增 Event type 的定义和 schema version 注册 |
| `src/main/core/evaluation/GuardrailFeedbackAnalyzer.ts` | 核心分析逻辑 |

### Files to Modify

| File | Change |
|------|--------|
| `src/main/core/evaluation/types.ts` | 扩展 `EventType` union 加入 `guardrail.outcome.observed` |
| `src/main/core/evaluation/EvaluationEventSchema.ts` | 注册新 event type 的 schema version |
| `src/main/ipc/handlers.ts` | 可选：暴露 Recommendation 查询 |
| `src/main/bootstrap/AppRuntime.ts` | 可选：启动 FeedbackAnalyzer |

### 首版实现范围

1. **OutcomeSignal Event type 定义 + schema 注册** — 冻结 contract
2. **GuardrailFeedbackAnalyzer（只读分析）** — 读取 OutcomeSignal + DecisionStore，统计 effectiveness
3. **GuardrailRecommendationStore（持久化推荐）** — 写入 recommendation artifact
4. **IPC: recommendation query** — 读取已生成的 recommendation
5. **Widget: recommendation card** — 壁纸 widget 显示待处理的 recommendation

首版不实现：
- 自动 OutcomeSignal 生成（source: 'auto'）
- Config candidate 生成
- 独立 Dashboard 页面

### 与现有系统的集成

```
EvaluationEvent (新: guardrail.outcome.observed)
      |
      v
EvaluationStore (现有)
      |
      v
GuardrailFeedbackAnalyzer (新)
      |
      v
GuardrailRecommendationStore (新)
      |
      v
IPC → Renderer Widget

ConfigStore 和 GuardrailPolicy 完全不受影响。
```

---

## Freeze Checklist

### F1 — Feedback Signal Source
- [ ] Truth source = `guardrail.outcome.observed` Event，写入 EvaluationStore
- [ ] FeedbackAnalyzer 只读 EvaluationStore，不扫描 MetricsStore/DecisionStore
- [ ] 不建立 MetricsStore → ConfigStore 路径
- [ ] 不建立 EvaluationEvent → ConfigStore 路径（ConfigStore 只消费 config event）

### F2 — OutcomeSignal Contract
- [ ] Outcome 语义冻结：effective / ineffective / inconclusive
- [ ] Source 角色定义：auto / manual
- [ ] Event type 注册到 EVENT_SCHEMA_VERSIONS
- [ ] 首版不强制自动检测（source: 'auto' 可作为 future work）

### F3 — Recommendation Boundary
- [ ] Feedback 终止于 Recommendation artifact
- [ ] Recommendation 不包含可执行 Config
- [ ] Config activation 必须经过 Human + 现有 Event lifecycle
- [ ] 禁止 FeedbackAnalyzer 修改 ConfigStore/Policy

### F4 — Policy Evolution Model
- [ ] M6.4 采用 Option A（仅推荐）
- [ ] 不引入 Config proposal event type
- [ ] 不修改 GuardrailPolicy interface
- [ ] 不修改 ConfigStore 接口
