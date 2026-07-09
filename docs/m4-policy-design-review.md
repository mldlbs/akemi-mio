# M4 Policy Design Review

**Status:** Draft  
**Date:** 2026-07-09  
**Precondition:** M3 Closed ✅  
**Next:** Decision Contract Freeze → Consumer Implementation

---

## 问题 1：Policy 输入是什么？

### 当前基线

```typescript
// GuardrailPolicy.ts — L26
evaluate(snapshot: ProgressSnapshot): GuardrailDecision
```

Policy 当前只消费 `ProgressSnapshot`。`PolicyConfig` 在构造函数注入，不在 `evaluate()` 参数中。

### 问题

构造函数注入 config 意味着：

```typescript
const policy = new DefaultGuardrailPolicy(config)
policy.evaluate(snapshot)  // 隐式使用 config
```

Replay 时无法从 `evaluate()` 签名确定 config，必须依赖测试或调用方保证 config 一致。这正是 I-1 中 `ReplayInput` 必须包含 `policyConfig` 的原因。

### 建议：evaluate() 签名改为显式传入 config

```typescript
interface GuardrailPolicy {
  evaluate(
    snapshot: ProgressSnapshot,
    config: GuardrailPolicyConfig
  ): GuardrailDecision
}
```

这样：
- Replay 输入 **完全从参数确定**，不依赖构造函数或环境
- `evaluate()` 成为真正纯函数
- 不同 config 可同时对比，无需构造多个 policy 实例

### 检查清单

| 问题 | 当前状态 | 审查结论 |
|------|---------|---------|
| 是否只消费 Snapshot？ | ✅ 是 | — |
| 是否允许读取 EvaluationEvent？ | ❌ 禁止 | M2/M3 语义分层要求 Policy 不得绕过 Snapshot |
| 是否允许访问 Runtime context？ | ❌ 禁止 | 违反 DI-2（Pipeline 不解析 Decision，Runtime 不读取 Decision） |

---

## 问题 2：Policy 是否纯函数？

### 当前基线

```typescript
// GuardrailPolicy.ts — L15-L24
class DefaultGuardrailPolicy {
  private config: GuardrailPolicyConfig

  constructor(config?: Partial<GuardrailPolicyConfig>) {
    this.config = { ... }
  }

  evaluate(snapshot: ProgressSnapshot): GuardrailDecision {
    // 仅读取 snapshot + this.config
    // 返回值中包含 Date.now() — decidedAt
    ...
  }
}
```

### 非确定性来源

`evaluate()` 中唯一的非确定性来源是 `decidedAt = Date.now()`。`action` / `signals` / `reason` 完全由 `snapshot + config` 决定。

### 建议

| 类别 | 允许 | 禁止 |
|------|------|------|
| 配置 | 静态阈值、版本化规则 | 运行时查询配置中心 |
| 时间 | 使用 config 中的参考时间 | `Date.now()` / `performance.now()` |
| 随机 | — | `Math.random()`、概率采样 |
| 外部 I/O | — | API 调用、DB 查询 |
| Runtime 状态 | — | `ChatExecutor`、`SessionContext` |

### 关键约束

> **Policy 不能成为 Runtime 的隐式依赖源。**

如果未来需要动态阈值（如根据时段调整），应使用版本化 PolicyConfig：

```text
PolicyConfig(v2)
       ↓
evaluate(snapshot, config)
       ↓
Decision
```

而不是：

```text
evaluate()
       ↓
查询最新配置  ← 违反纯函数，Replay 输出依赖于"最新"定义
```

---

## 问题 3：Decision 是否可 Replay？

### 当前基线

```typescript
interface GuardrailDecision {
  action: GuardrailAction
  reason: string
  decidedAt: number    // ← 已知非确定性，I-1 已隔离
  traceId: string
  signals: SignalState[]
  snapshot: ProgressSnapshot
}
```

### 核心 Invariant

```
same Snapshot + same PolicyConfigVersion → same Decision (排除 decidedAt)
```

### 建议：冻结 DecisionIdentity

```typescript
/** Decision Identity — 参与 Replay 等值性的字段 */
interface DecisionIdentity {
  action: GuardrailAction
  reason: string
  signals: SignalState[]
  policyVersion: string
}
```

| 字段 | 属于 Identity？ | 理由 |
|------|----------------|------|
| `action` | ✅ 是 | 核心语义 |
| `reason` | ✅ 是 | 可解释性要求一致 |
| `signals` | ✅ 是 | 信号级状态影响决策 |
| `policyVersion` | ✅ 是 | 明确使用的策略版本 |
| `decidedAt` | ❌ 否 | Runtime metadata |
| `traceId` | ⚠️ 输入依赖 | 从 Snapshot 派生，不是决策本身 |
| `snapshot` | ❌ 否 | 输入，不在输出等值性中 |

### PolicyConfigVersion 纳入 ReplayInput

```typescript
interface PolicyInput {
  snapshot: ProgressSnapshot
  config: GuardrailPolicyConfig
  configVersion: string
}
```

### 验证方法

扩展 I-1 Replay Test Matrix：

| Test | 输入 | 验证 |
|------|------|------|
| R-1 | 同一 snapshot + 同一 config | DecisionIdentity 全等 |
| R-2 | 同一 snapshot + config v1 vs v2 | 允许不一致 |
| R-3 | config 中所有阈值参数化 | 改变任意阈值 → action 符合预期 |

---

## 问题 4：Threshold / Rule / Strategy 边界

### 当前状态

Policy 和 Strategy 都实现在 `DefaultGuardrailPolicy` 中，没有分层。

```typescript
// GuardrailPolicy.ts — 同时承担：
// 1. 阈值定义 (config)
// 2. 信号评估 (evaluateStateChange / evaluateInformationGain / evaluateGoalProgress)
// 3. 决策聚合 (stalled > degrading > healthy)
```

### 建议拆分

```
M4 (Current ADR Scope):
───────────────────────────────────────
Policy Layer
  ├── SignalEvaluator      (纯函数：snapshot → SignalState[])
  ├── DecisionAggregator   (纯函数：SignalState[] → Decision)
  └── PolicyConfig         (版本化阈值定义)
───────────────────────────────────────

M5 (Future):
───────────────────────────────────────
Adaptive Strategy Layer
  ├── OutcomeObserver      (观察 Decision 结果)
  ├── ConfigProposer       (生成候选 PolicyConfig)
  └── StrategyValidator    (验证新 Config 不违反 Invariant)
───────────────────────────────────────
```

### 边界规则

| 项目 | M4 Policy | M5 Strategy |
|------|-----------|-------------|
| 输入 | snapshot + config | Decision + outcome |
| 输出 | Decision | CandidateConfig |
| 状态 | 无状态纯函数 | 允许持有观察状态 |
| Replay 要求 | 同输入→同输出 | 不要求（含观察状态） |
| 修改频率 | 冻结后低频调整 | 可演化 |

### 为什么要拆

1. **Replay boundary 明确**：Policy 是 Replayable，Strategy 不是
2. **测试复杂度分离**：Policy 可单元测试，Strategy 需要模拟环境
3. **演化节奏解耦**：Policy Versioning 独立于 Strategy Evolution

---

## 审查结论

### 必须冻结（M4 First Freeze）

```text
Policy Contract Freeze:
  evaluate(snapshot: ProgressSnapshot, config: PolicyConfig): GuardrailDecision

Decision Identity:
  action + reason + signals + policyVersion

禁止 Policy 访问:
  - EvaluationEvent[]
  - Runtime context
  - External I/O
  - Date.now() / random
```

### 不在此范围（保持未冻结）

```text
- Consumer implementations
- Guardrail event taxonomy (O-2)
- Adaptive Strategy (M5)
- Retry / Replan / Escalate action 类型
```

### 下一步

1. **确认 Review 结论** → 确定 M4 冻结范围
2. **Decision Contract Freeze** → 更新类型定义、签名
3. **Consumer 实现** → 在冻结的 Contract 上构建

---

**Reviewer:** —  
**Status:** 等待确认后进入 Contract Freeze
