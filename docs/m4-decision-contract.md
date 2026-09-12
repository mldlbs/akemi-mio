# M4 Decision Contract

**Status:** Frozen  
**Date:** 2026-07-09  
**Precondition:** M3 Closed ✅, Policy Contract Freeze ✅, Consumer Boundary Review ✅  
**Next:** Consumer Implementation

---

## 1. 冻结范围

### Policy Layer

```typescript
interface PolicyInput {
  snapshot: ProgressSnapshot
  config: GuardrailPolicyConfig
}

interface GuardrailPolicy {
  evaluate(input: PolicyInput): GuardrailDecision
}
```

| 项目 | 冻结状态 |
|------|---------|
| `PolicyInput` 结构 | ✅ Frozen |
| `evaluate(input)` 签名 | ✅ Frozen |
| `PolicyConfig.version` 字段存在 | ✅ Frozen |
| Rule 实现逻辑 | ❌ Not frozen |
| Threshold 数值 | ❌ Not frozen |

### Decision Layer

```typescript
interface DecisionIdentity {
  action: GuardrailAction
  signals: SignalState[]
  policyVersion: string
}

interface GuardrailDecision {
  action: GuardrailAction
  reason: string
  decidedAt: number
  traceId: string
  signals: SignalState[]
  snapshot: ProgressSnapshot
  policyVersion: string
}
```

| 项目 | 冻结状态 |
|------|---------|
| `DecisionIdentity` 语义（action + signals + policyVersion） | ✅ Frozen |
| `GuardrailDecision` 完整结构 | ✅ Frozen |
| `reason` 在 replay equality 中的角色 | ❌ Excluded（展示字段） |
| `decidedAt` 在 replay equality 中的角色 | ❌ Excluded（runtime metadata） |

### Consumer Layer

```typescript
interface ProgressConsumer {
  consume(snapshot: ProgressSnapshot): void | Promise<void>
}
```

| 项目 | 冻结状态 |
|------|---------|
| `consume(snapshot)` 签名 | ✅ Frozen |
| Consumer 输入 = Snapshot only | ✅ Frozen |
| Consumer 禁止修改 Snapshot / Config / Observer | ✅ Frozen |
| Consumer 顺序无关 | ✅ Frozen |
| Consumer 异常不阻断其他 Consumer | ✅ Frozen |
| Consumer 实现逻辑 | ❌ Not frozen |

### Replay Contract

```
same Snapshot + same PolicyConfig.version + same Policy implementation
→ same DecisionIdentity
```

| 项目 | 冻结状态 |
|------|---------|
| ReplayInput = { events, policyConfig } | ✅ Frozen |
| Replay Determinism Boundary | ✅ Documented in I-1 |
| DecisionIdentity 参与 replay equality | ✅ Frozen |

---

## 2. 不在此范围（M5 / 未来）

- Adaptive Strategy（配置 Proposal / 结果观察 / 验证）
- Retry / Replan / Escalate Action 类型扩展
- Consumer 健康管理 / 熔断
- `guardrail.*` Audit Event schema（O-2）

---

## 3. 验证记录

| Invariant | 验证 | 状态 |
|-----------|------|------|
| 同一 events + config → 同一 DecisionIdentity | I-1 (12 tests) | ✅ |
| `evaluate()` 是纯函数 | V-1 (4 tests) | ✅ |
| Consumer 隔离 | V-4 (2 tests) | ✅ |
| 全量 regression | 98/98 tests | ✅ |

---

## 4. 变更记录

| Date | Change |
|------|--------|
| 2026-07-09 | 初始版本。从 Policy Design Review + Consumer Boundary Review + ADR-003 合并为单一 Contract Document。 |
