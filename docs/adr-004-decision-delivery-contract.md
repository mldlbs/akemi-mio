# ADR-004：Decision Delivery Contract

**Status:** ✅ Accepted — Frozen
**Date:** 2026-07-08
**Supersedes:** None
**Superseded by:** None
**References:**
- [AOR-001](docs/aor-001-decision-delivery-and-event-domain.md) — O-1: Decision Delivery Contract, O-2: Consumer Event Domain
- [ADR Scope Review 001](docs/adr-scope-review-001.md) — 判定 O-2 Deferred，仅 O-1 进入 ADR
- [Decision Research 004](docs/decision-research-004.md) — Decision Space 事实收集
- [Decision Research 004 Review](docs/decision-research-004-review.md) — D-1~D-4 Closure Review
- ADR-003 — 已冻结的 Progress Observer Protocol

---

## Context

ADR-003 定义了 `ProgressConsumer.consume(snapshot): void | Promise<void>` 接口。该设计选择"统一入口比统一输出更稳定"，明确不定义 Consumer 的输出类型。GuardrailPolicy 作为 Consumer 产生 `GuardrailDecision`，但该 Decision 没有定义的路径到达 Runtime。

当前系统通过绕过 Observer 规避此问题：

```
ChatExecutor.toolLoop()
    → GuardrailPipeline.check()
        → GuardrailProgressAnalyzer.analyze()   ← 直接调用 Producer
        → DefaultGuardrailPolicy.evaluate()
        → RuntimeAction                          ← 返回给 toolLoop
```

GuardrailPipeline 同时承担了 Runtime Adapter、Consumer、Observer 三个角色。该路径不经过 ProgressObserver，导致：

1. Observer 虽运行但零 Consumer（AppRuntime.ts:281-283）
2. GuardrailPipeline 直接调用 Producer API（`analyze()`），违反了 Consumer Independence 的契约边界
3. I-3 (Consumer Independence) 被阻塞，无法在生产路径验证

**根因：** ADR-003 冻结了 `consume()` 的输入契约，但未定义其输出路径。Consumer 产生 Decision 后无法合法到达 Runtime。

---

## Decision Scope

本 ADR 仅回答一个问题：

> **Consumer 产生 GuardrailDecision 后，如何合法地交付给 Runtime？**

本 ADR **不**回答：

- Consumer Event Domain（O-2）— 由 ADR-004 的结果重新评估
- Event Schema 演化
- Replay Protocol 变更
- ProgressSnapshot Schema 变更

---

## Decision Drivers

### 硬性需求（必须满足）

| # | Driver | 来源 | 优先 |
|---|--------|------|------|
| D1 | Decision 必须在下一个 LLM 调用前到达 | ChatExecutor 同步 await | P0 |
| D2 | TERMINATE 必须当前轮次到达 | 无 buffer，无 deferral | P0 |
| D3 | WARNING 可以延迟到达 | 仅日志，非控制流 | P3 |
| D4 | Decision 错误不能中断 toolLoop | catch → return null | P0 |
| D5 | Consumer 不依赖 Producer Internal API | ADR-003 C-5 | P0 |
| D6 | 单 trace 一次性 routing | ChatExecutor 单例 | P1 |

### 架构需求

| # | Driver | 优先 |
|---|--------|------|
| D7 | 最小化 consume() 签名变化 | P1 |
| D8 | Pipeline 不直接依赖 Observer | P1 |
| D9 | Runtime 只消费 RuntimeAction，不直接消费 GuardrailDecision | P2 |

---

## Constraints

本文档复述所有约束来源，不新增约束。

### 来自 ADR-003 的冻结约束

1. `consume(snapshot): void | Promise<void>` 签名 — §ADR-4
2. Consumer 无状态 — §ADR-4
3. Consumer 不依赖其他 Consumer — §ADR-4
4. ProgressObserver 不参与 Decision Delivery — §ADR-5
5. ProgressObserver 不引用 ChatExecutor — §ADR-5

### 来自 Governance Axioms

6. Architecture 冻结后不修改协议 — Axiom 2
7. 任何违反必须回到 Observation — Axiom 3

### 来自代码实现

8. Decision 必须在下个 LLM 调用前生效 — `ChatExecutor.ts:671`
9. 无 buffer 机制 — `ChatExecutor.ts:674-678`
10. 错误 fallback = null（skip） — `GuardrailPipeline.ts:75-78`

---

## Screened Out Options

以下方案在 Decision Research 中已完成分析，因明确违反 Governance 或 Baseline，或对当前架构过度设计，不进入最终比较。

### Pattern F: 修改 consume() 返回类型

- **描述：** `consume(snapshot): GuardrailDecision | void`
- **筛选理由：** 直接违反 ADR-003 §ADR-4 已冻结契约。该决策是 ADR-003 的核心设计选择（统一入口比统一输出更稳定），不能在 M3 实施期间单方面撤销。

### Pattern D: Shared State / Mailbox

- **描述：** Consumer 将 Decision 写入共享可变位置，Pipeline 轮询读取。
- **筛选理由：** 引入共享可变状态，违反 Consumer 隔离原则。增加测试复杂度和不可预测性。

### Pattern E: Queue / Channel

- **描述：** Consumer → Queue → Pipeline 异步消息传递。
- **筛选理由：** 当前系统为单 trace、单 Consumer 架构。Queue 机制带来的异步解耦在当前的简单拓扑中没有收益，反而引入 buffer、backpressure、至少一次交付等不必要的复杂度。如果未来出现多 Runtime、多 Consumer 并发场景，可重新评估。

---

## Considered Options

### Option A: Callback Parameter

- **机制：** Consumer 构造时接收一个 `(decision: GuardrailDecision) => void` 回调。consume() 内部评估后调用回调。Pipeline 实例化 Consumer 时注册该回调。
- **consume() 签名：** 不变（回调通过构造函数注入）
- **同步性：** ✅ 同步
- **C-5 合规：** ✅
- **改动量：** 小 — GuardrailConsumer 构造函数 + Pipeline wiring

```
class GuardrailProgressConsumer implements ProgressConsumer {
    constructor(
        private policy: GuardrailPolicy,
        private onDecision: (d: GuardrailDecision) => void
    ) {}
    async consume(snapshot: ProgressSnapshot): Promise<void> {
        const decision = this.policy.evaluate(snapshot)
        this.onDecision(decision)
    }
}
```

### Option B: Output Interface

- **机制：** 定义 `DecisionOutput<T>` 接口。Consumer 构造时注入该接口的实现。Pipeline 实现该接口作为 Adapter。
- **consume() 签名：** 不变
- **同步性：** ✅ 同步
- **C-5 合规：** ✅
- **改动量：** 中 — 新增接口定义 + 2 个实现 + wiring

```
interface DecisionOutput<T> {
    write(decision: T): void
}
```

### Option C: EventBus 事件

- **机制：** Consumer 以 EventBus 事件发布 Decision。Pipeline（或 ChatExecutor）订阅该事件。
- **consume() 签名：** 不变
- **同步性：** ❌ 异步
- **C-5 合规：** ✅ 但需确认 EventBus 是否属于 Producer 域
- **改动量：** 大 — 新增事件类型 + 订阅/路由 + buffer 机制

---

## 方案比较

| 维度 | Option A: Callback | Option B: Output Interface | Option C: EventBus |
|------|-------------------|---------------------------|-------------------|
| **D1: 同步交付** | ✅ 同步回调 | ✅ 同步写入 | ❌ 异步事件 |
| **D2: TERMINATE 及时性** | ✅ 当前轮次 | ✅ 当前轮次 | ❌ 需要 buffer |
| **D3: WARNING 延迟** | ✅ 同步，即时 | ✅ 同步，即时 | ✅ 可异步（仅日志不敏感） |
| **D4: 错误隔离** | ✅ try/catch 包裹 | ✅ try/catch 包裹 | ✅ 订阅方错误隔离 |
| **D5: C-5 合规** | ✅ | ✅ | ⚠️ 取决于 EventBus 域 |
| **D6: 单 trace routing** | ✅ 绑在实例上 | ✅ 绑在实例上 | ❌ 需要 routing key |
| **D7: consume() 签名** | ✅ 不变 | ✅ 不变 | ✅ 不变 |
| **D8: Pipeline 独立** | ✅ Pipeline 接收回调 | ✅ Pipeline 实现接口 | ❌ Pipeline 需要订阅 |
| **D9: RuntimeAction** | ✅ Pipeline 做 mapping | ✅ Pipeline 做 mapping | ❌ ChatExecutor 需订阅 |
| **改动量** | 小 | 中 | 大 |
| **可测试性** | ✅ 高 | ✅ 高 | ⚠️ 需要 EventBus mock |

---

## Decision

### Decision Statement

> **ADR-004 仅定义 Guardrail Decision 的交付契约，不定义统一 Consumer Output 协议。**

GuardrailConsumer 通过构造函数注入的 callback 将 `GuardrailDecision` 交付给 Runtime Adapter（GuardrailPipeline）。其他 Consumer（Fitness、Reflection 等）目前不存在，未来出现时不强制使用相同机制。

### Architecture Invariants（冻结）

以下三条为本 ADR 的永久约束：

| # | Invariant | 含义 | 违反示例 |
|---|-----------|------|----------|
| DI-1 | `consume()` 接口保持不变 | 不修改 `consume(snapshot): void \| Promise<void>` 签名 | 增加返回值类型、增加必选参数 |
| DI-2 | Pipeline 不解析 Guardrail Decision | Pipeline 只做 `toRuntimeAction()` 映射，不读取 `decision.signals`、`decision.snapshot` | Pipeline 根据 signals 做分支逻辑 |
| DI-3 | Decision 必须在同一 Trace 内同步交付 | 从 Consumer.evaluate() → RuntimeAction 的路径不允许异步脱耦 | 使用 EventBus 发布 Decision，由 ChatExecutor 异步订阅 |

### 推荐方案

**Option A: Callback Parameter。**

理由（按优先级排序）：

1. **保持 ADR-003 接口契约不变。** `consume()` 签名不修改，ADR-003 冻结决定保持完整。这是最高优先级约束。
2. **Pipeline 不承担 Consumer 输出协议解析。** Pipeline 接收已完成的 `GuardrailDecision`，只做 `toRuntimeAction()` 映射。Pipeline 不读取 `decision.signals`、`decision.snapshot`，不承担 Consumer 输出协议的解析职责。
3. **满足同步交付与当前轮次约束。** Callback 在 `consume()` 内部同步调用，保证 Decision 在当前轮次到达 Pipeline，不引入 buffer 或 deferral 机制。
4. **实现复杂度最低。** 仅修改 GuardrailConsumer 构造函数和 Pipeline wiring，不新增接口或抽象层。

### Option B 的处理

Option B（Output Interface）**Deferred**。其语义等价于 Callback，仅增加一层抽象。当前无系统需要多个 Consumer 标准化输出协议。当以下条件出现时重新评估：

- 存在至少 2 个产生结构化输出的 Consumer（如 Guardrail + Fitness）
- 且需要统一的 Decision Audit / Logging 拦截层

### Option C 的处理

Option C（EventBus）不推荐。异步特性与 DI-3 直接冲突，且需要引入 buffer + deferral 机制解决及时性问题。当前架构无此需求。

---

## Consequences

### Positive

1. ✅ **Consumer Independence（I-3）恢复验证路径。** GuardrailConsumer 成为第一个真实 ProgressConsumer，C-1~C-5 可在生产路径验证。
2. ✅ **consume() 接口不变。** ADR-003 的"统一入口"决策保持完整，不因 Guardrail 的需求修改冻结协议。
3. ✅ **Pipeline 不承担 Consumer 输出协议解析。** Pipeline 只做 `toRuntimeAction()` 映射，不读取 GuardrailDecision 内部结构。
4. ✅ **DI-3（同步交付）保证。** Callback 在 consume() 内部同步调用，不改变当前 Runtime 的时序语义。
5. ✅ **新增架构层最少。** 不新增抽象接口、Event 通道或共享状态。

### Negative

1. ⚠️ 单 trace routing 是隐式的（通过 Consumer 实例绑定），如果未来支持并发多 trace，需要改为显式 routing
2. ⚠️ Callback 参数数量随 Consumer 输出类型增长 — 如果有 N 种 Consumer 输出，需要 N 种回调签名

### Mitigations

- 并发多 trace：届时升级到 DecisionOutput 模式（接口不变，注入改为 channel-aware 实现）
- 回调签名扩散：当前只有一种 Consumer 输出。多类型出现时升级到 Option B

---

## Migration Plan

### Migration Order

```
Step A: GuardrailConsumer 实现（增加 callback 能力，不启用）
    ↓
Step B: Pipeline 重构（注入 callback，移除 analyzer 引用）
    ↓
Step C: AppRuntime wiring（注册至 ProgressObserver，集成测试）
    ↓
    Verification Gate: I-3 C-1~C-5 验证全部 Pass
    ↓
Step D: 删除临时兼容代码
```

原则：**删除兼容层必须是最后一步。** 保留旧路径直到验证完成，确保回滚时只需切换 back，而不是重新合并。

### Step A: GuardrailConsumer 实现

```
新建 src/main/core/evaluation/progress-consumers/GuardrailProgressConsumer.ts

class GuardrailProgressConsumer implements ProgressConsumer {
    constructor(policy: GuardrailPolicy, onDecision: (d: GuardrailDecision) => void)
    async consume(snapshot): Promise<void>
}
```

保留 GuardrailPolicy 纯函数不动。Consumer 是 Adapter。

### Step B: Pipeline 功能迁移

```
修改 GuardrailPipeline.ts:
  ─ 新增 onDecision callback：注册到 GuardrailConsumer
  ─ Pipeline 从 callback 接收 Decision，做 toRuntimeAction() 映射
  ─ 保留旧 analyze() 路径作为兼容层（Step D 删除）
  ─ 保留：throttle (A), toRuntimeAction (D), return (F), reset (G)
```

**职责：** 功能迁移。新的数据流生效，旧代码保留为兼容层。

### Step C: AppRuntime wiring

```
修改 AppRuntime.ts:
  ─ Pipeline 不再需要 store 和 analyzer
  ─ Pipeline 的 Decision 来源改为从 Consumer callback 注入
  ─ ProgressObserver 注册 GuardrailConsumer
```

### Step D: 死代码清理

```
GuardrailPipeline 删除：
  ─ GuardrailProgressAnalyzer import 和引用
  ─ old analyze() 调用路径（Step B 保留的兼容代码）
```

**保留（非 Consumer 职责）：**
- `emitGuardrailEvents()` — Pipeline 持有的 `EvaluationEmitter` + `currentTurn` 信息可继续承担此职责。Consumer 不持有 `EvaluationEmitter`。

**职责：** 死代码清理。删除 Step B 保留的兼容层。没有逻辑变更，纯删除。

> **注意：** `guardrail.*` 事件的 Audit Event Ownership 不在 ADR-004 范围内。保留 Pipeline 的 emit 是临时性安排，非架构决策。Audit Event Channel 是否独立由后续 Observation 决定。

---

## Verification Impact

### I-3 (Consumer Independence) — 恢复路径

ADR-004 冻结后，C-1~C-5 均可验证：

| Contract | 验证方式 | 预期通过条件 |
|----------|----------|-------------|
| C-1: Read-only Snapshot | `GuardrailConsumer.consume(snapshot)` 执行前后输入 snapshot 所有可观察字段值保持不变。通过深度等价断言验证。 | ✅ |
| C-2: Failure Isolation | GuardrailConsumer 抛出 → Observer 其他 Consumer 不受影响 | ✅ |
| C-3: Delivery Order Independence | Consumer 注册顺序 [A,B] vs [B,A] → 相同的 Snapshot 和 Delivery | ✅ |
| C-4: Delivery Cardinality Independence | 0/1/N Consumer → 相同的 Snapshot | ✅ |
| C-5: Producer Independence | Callback 不调用 Producer API; Consumer 不持有 Analyzer/Store 引用 | ✅ |

### I-1 / I-4 — 影响

不受影响。I-1（系统级 Replay）和 I-4（Zero Regression）的验证不依赖 Decision Delivery 机制。

---

## Out of Scope

本 ADR 不定义：

- **Consumer Event Domain（O-2）** — 由 ADR-004 结果重新评估
- **Event Schema 演化**
- **Replay Protocol 变更**
- **ProgressSnapshot Schema 变更**
- **非 Guardrail Consumer 的输出契约**（Fitness / Reflection / Evolution — 它们当前不存在，未来可能使用相同机制，但不在本 ADR 设计）
