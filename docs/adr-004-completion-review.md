# ADR-004 Completion Review

**Review Date:** 2026-07-09
**Status:** ✅ Closed

---

## Review Items

| Item | Status | Evidence |
|------|--------|----------|
| ADR Decision 全部实现 | ✅ | Option A (Callback Parameter) 完整实现：`GuardrailProgressConsumer` + `Pipeline.onGuardrailDecision()` + `AppRuntime` wiring |
| Migration Step A–D 全部完成 | ✅ | Step A (Consumer), Step B/C (Pipeline + wiring), Step D (兼容层删除) |
| Verification 全部通过 | ✅ | I-2 (Producer Purity) ✅, I-3 (Consumer Independence C-1~C-5) ✅, I-4 (Zero Regression 86/86) ✅ |
| 架构 Invariant 已记录 | ✅ | DI-1~DI-3（ADR 层面），I-1 (Pipeline=单Trace), I-2 (Final Decision Only) — 代码注释 |

---

## 遗留技术债

### Open Architecture Observation

**O-2: Audit Event Ownership**
- **Status:** Narrowed
- **Reason:** Decision Delivery 已完成解耦。`guardrail.*` Audit Event 的归属仍未决定。
- **Current assignment:** Pipeline 临时持有 `emitGuardrailEvents()`（通过 `EvaluationEmitter` 注入）。
- **Impact:** 不影响当前 Runtime 行为。不阻塞后续开发。未来如调整 Event Domain，应重新开启 Observation。
- **Path to resolve:** 新 Observation → Research → ADR（不可修改 ADR-004）。

---

## 决策链回顾

```
AOR-001 (Observation: Decision Delivery + Event Domain)
    ↓
ADR Scope Review 001 (Scope: O-1 only, O-2 Deferred)
    ↓
Decision Research 004 (Decision Space: Patterns A–F)
    ↓
Closure Review (Space closed, 6 patterns screened)
    ↓
ADR-004 Frozen (Option A: Callback Parameter)
    ↓
Migration Step A (GuardrailConsumer)
    ↓
Migration Step B/C (Pipeline callback + AppRuntime wiring)
    ↓
Migration Step D (兼容层删除)
    ↓
Verification (I-2 ✅ I-3 ✅ I-4 ✅)
    ↓
[CLOSED]
```

---

## 后续方向

本 ADR 生命周期已结束。后续工作不应再修改 ADR-004：

- **M3 I-1 (Replay Consistency):** 新的 Invariant 验证，不依赖本 ADR
- **O-2 (Audit Event Ownership):** 需要新 Observation → Research → ADR 独立流程

一条 ADR 只解决一个决策问题。冻结后不承担后续设计演化。
