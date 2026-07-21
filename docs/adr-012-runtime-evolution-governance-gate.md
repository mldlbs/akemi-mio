# ADR-012: Runtime Evolution Governance Gate v1

**Status:** Draft
**Date:** 2026-07-21
**Supersedes:** None
**Upstream Dependencies:**
- Phase 3A (ExecutionPolicy Contract) — Frozen
- Phase 3B (Constitution Wiring) — Frozen
- Phase 3C (Pipeline Gate) — Frozen
- Phase 3C+ (Shadow Mode) — Implemented

---

## Context

Phase 3A→C 实现了证据驱动进化管道的治理门机制，但尚未激活。在首次激活前需要冻结治理边界，避免以下风险：

1. **治理门误判** — `ExecutionPolicy.evaluate()` 的默认策略（哪个 source 被 skip/block/execute）未经真实运行数据验证；
2. **自动执行失控** — `level_2_execute` 路径虽然代码存在但无安全策略约束；
3. **反向依赖** — Evaluation/Evidence 系统可能随时间演化出对 Evolution/Runtime 的反向依赖。

### 当前架构

```
evaluation (ReportGenerator)
    ↓
EvidenceBridge (EventBus signal)
    ↓
EvidenceCollector (Problem source='evidence')
    ↓
ProblemQueue
    ↓
ExecutionPolicy (exist but DISABLED)
    ↓
tryFix() / Current legacy path
```

### 治理门状态

| 组件 | 存在 | 激活 | 默认行为 |
|---|---|---|---|
| `ExecutionPolicy.evaluate()` | ✅ | ❌ | Pipeline 不使用 |
| `ProblemQueue.skip()` | ✅ | ❌ | 未调用 |
| `ProblemQueue.block()` | ✅ | ❌ | 未调用 |
| `policy.decision` event | ✅ | ❌ | 不发出 |

---

## Decision

### 1. ExecutionPolicy 默认关闭

`PipelineOrchestrator` 接受 `ExecutionPolicy` 注入，但 AppRuntime 不注入。无 policy 时 `runOnce()` 执行路径与旧版本完全相同。

```ts
// 这是当前状态 — 零行为变化
pipeline = new PipelineOrchestrator(config)
// setExecutionPolicy is NOT called
```

激活条件：必须经过 shadow mode 数据观察期（见 §Activation Gate）。

### 2. Level 2 保持禁用

所有 `level_2_execute` 路径在 Phase 3C 实现中被冻结：

| Source | 原 Phase 3A 等级 | Phase 3C 状态 |
|---|---|---|
| `tsc` | `level_2_execute` | Fall-through（旧路径） |
| `test` | `level_2_execute` | Fall-through（旧路径） |
| `runtime` | `level_2_execute` | Fall-through（旧路径） |
| `lint` | `level_2_execute` | Fall-through（旧路径） |
| `log` | `level_2_execute` | Fall-through（旧路径） |
| `git` | `level_2_execute` | Fall-through（旧路径） |
| `feature` | `level_1_propose` | `block` |
| `tool` | `level_1_propose` | `block` |
| `behavior` | `level_1_propose` | `block` |
| `evidence` | `level_0_record` | `skip` |
| `memory` | `level_0_record` | `skip` |
| `agent` | `level_0_record` | `skip` |

error severity 提升路径（Phase 3A §4）在 Phase 3C 中冻结。任何 source 的 error severity 不再自动提升到 `level_2_execute`。

### 3. Evidence 不直接修改 Runtime

证据驱动进化保持单向数据流：

```
evaluation
    ↓  EventBus signal
EvidenceBridge
    ↓  Report → Problem mapping
EvidenceCollector
    ↓  ProblemQueue
ExecutionPolicy (when active)
    ↓  skip/block
```

禁止出现：

- Evidence 直接调用 Evolution 方法；
- ReportGenerator 依赖 Evolution 模块；
- ExecutionPolicy 访问文件系统或外部服务（已在 Phase 3A 约束）。

### 4. 策略决定有独立记录

`skip` 和 `block` 不混入 `completed`/`failed` 状态集。`policy.decision` 事件提供可回放审计日志。

### 5. ExecutionMode v1

治理门有三种运行模式，通过 `ExecutionPolicy` 构造参数选择：

| Mode | evaluate | emit decision | action 生效 | 修改 queue 状态 |
|---|---|---|---|---|
| `disabled` | ✅ | ✅ | ❌（始终 tryFix） | ❌ |
| `shadow` | ✅ | ✅ | ❌（始终 tryFix） | ❌ |
| `enforce` | ✅ | ✅ | ✅ | ✅ |

**disabled** — 兼容旧行为，用于部署验证。只要 policy 被注入但未准备好生效时使用。
**shadow** — 观测模式。evaluate + emit，但永远不阻断执行。不修改 queue 的 skipped/blocked 状态。
**enforce** — 完整治理。action=skip 调用 `queue.skip()`，action=block 调用 `queue.block()`，action=execute 进入 tryFix。

### 6. Shadow mode 不污染 queue 状态

shadow 模式下 `decision.executed=true`，但 `queue.skip()`/`queue.block()` 不被调用。避免出现 "policy says block，实际执行成功，queue 状态却显示 blocked" 的审计数据污染。

### 7. decision event 扩展

```ts
interface PolicyDecisionEvent {
  problemId: string
  source: string
  action: VerdictAction
  mode: ExecutionMode    // 决策时的模式
  executed: boolean      // 实际是否被执行（shadow/disabled=true, enforce skip/block=false）
  reason: string
  policyVersion: string
  timestamp: number
}
```

---

## Consequences

### Positive

1. **可回滚** — 激活治理门只需一行 `pipeline.setExecutionPolicy(new ExecutionPolicy())`，无 schema 迁移；
2. **可观测** — `policy.decision` event 提供了激活前的数据基础；
3. **可验证** — 所有 Phase 3C contract tests 在无 policy 时保持旧行为；
4. **无反向依赖** — Evaluation/Evidence 层不 import Evolution/ExecutionPolicy。

### Negative

1. **治理门未生效** — 新 source（evidence/memory/agent）的治理能力存在但未启用；
2. **Level 2 无数据** — 禁用意味着无法收集 legacy source（tsc/test）的执行频率数据；
3. **策略未经验证** — 默认的 source→level 映射表是设计假设，不是经验数据。

### Mitigations

1. 设计 `ExecutionPolicy` 的 shadow mode（只记录决策，不阻断执行），但不在 ADR-012 范围内实现；
2. Phase 3D 决策前必须收集至少 1 次完整 Evolution 周期的 policy decision 数据；
3. Legacy source（tsc/test/runtime）的行为通过现有 `tryFix()` 路径由已有监控覆盖。

---

## Activation Gate

### 治理门激活条件

首次从 shadow 切换到 enforce 必须满足以下条件：

```
[✅] Shadow mode 已在 AppRuntime 中激活
[ ] 至少 1 次完整 evolution.cycle.completed 周期
[ ] shadow decisions ≥ 100（小样本无统计意义）
[ ] policy.decision 事件中：
      execute 比例 ≥ 60%（表明策略不完全阻断有效进化）
      skip 比例 ≤ 20%（表明策略未过度过滤）
      block 比例 = 0（Level 1 不启用）
[ ] 至少 1 个新 source（evidence/memory/agent）被观察到产生 Problem
[ ] 无违反 ADR-012 §3 的代码提交（Evidence 反向依赖 Evolution）
```

不满足任何条件时不得切换。Shadow mode 已实现，无需额外实现。

### Shadow mode 退出条件

```
[ ] ≥ 1 次完整 Evolution 周期完成
[ ] shadow decisions ≥ 100
[ ] execute ≥ 60%
[ ] skip ≤ 20%
[ ] block = 0
```

满足后可在 AppRuntime 中将 `mode: 'shadow'` 改为 `mode: 'enforce'`。

---

## Implementation Status

### Code (frozen)

| File | Content | Status |
|---|---|---|
| `ExecutionPolicy.ts` | Action contract + Level 2 freeze + ExecutionMode + PolicyDecisionEvent.mode/executed | ✅ Committed |
| `ProblemQueue.ts` | Skipped/blocked tracking + persistence | ✅ Committed |
| `PipelineOrchestrator.ts` | Injectable gate + mode-based routing (disabled/shadow/enforce) | ✅ Committed |
| `index.ts` | Type exports incl. ExecutionMode | ✅ Committed |

### Wiring (active in shadow mode)

| Wiring point | Status | Mode |
|---|---|---|
| `AppRuntime → setExecutionPolicy(new ExecutionPolicy({ mode: 'shadow' }))` | ✅ Active | shadow |

Before Shadow Mode (Phase 3C baseline), AppRuntime did NOT call `setExecutionPolicy()`. With Shadow Mode, the policy is present but does not block execution.

### Tests

| Test file | Coverage | Status |
|---|---|---|
| `Phase3BConstitutionWiring.test.ts` | ProposalValidator → ConstitutionEngine | ✅ 9 tests |
| `Phase3CPipelineGate.test.ts` | skip/block/execute routing + event schema + disabled/shadow/enforce + queue non-pollution | ✅ 22 tests |
| `ExecutionPolicy.test.ts` | Action contract, Level 2 freeze, ExecutionMode constructor | ✅ 23 tests |

---

## References

- [Phase 3C Design Note](design/phase3c-pipeline-gate.md)
- [Phase 3 Audit](design/phase3-execution-policy-audit.md)
- [M5 Evidence-Driven Evolution](release-m5-evidence-driven-evolution.md)
