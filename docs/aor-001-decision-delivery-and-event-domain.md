# Architecture Observation Report 001

> **Phase:** M3 Step 3.3 — Consumer Independence Mapping
> **Date:** 2026-07-08
> **Status:** O-1 → ADR-004 ✅ Resolved; O-2 → 🔄 Narrowed (see O-2 Review below)
> **Source:** Step 3.3 Mapping 发现两个超出 ADR-003 Baseline 的架构空白

---

## O-1: Decision Delivery Contract 未定义

### Observation

Step 3.3 Mapping 确认 Consumer Independence（I-3）的 Contract 维度全部可追溯至 ADR-003。然而，Mapping 同时也暴露了一个 ADR-003 未定义的路径：

```
ProgressObserver
        │
        ▼
ProgressConsumer.consume(snapshot)
        │
        ▼  ← 此处无定义
   GuardrailDecision → Runtime
```

ADR-003 §ADR-4 冻结了 `consume(snapshot): void | Promise<void>` 接口，明确不定义统一返回值。该设计的意图是「统一入口比统一输出更稳定」。但在实际系统中，Consumer 的产出（GuardrailDecision）必须能到达 Runtime（ChatExecutor），否则 Guardrail 功能无法通过 Observer 路径运作。

### Current Behavior

当前系统通过绕过 Observer 来规避此问题：

```
ChatExecutor.toolLoop()
    → GuardrailPipeline.check()          ← 同步调用，在 toolLoop 内
        → GuardrailProgressAnalyzer.analyze()   ← 直接调用 Producer
        → DefaultGuardrailPolicy.evaluate()     ← 消费 Snapshot
        → RuntimeAction                          ← 返回给 toolLoop
```

整条路径 **不经过 Observer**。GuardrailPipeline 同时承担了 Observer、Consumer、Runtime Adapter 三个角色。

### Missing Contract

| 项目 | 状态 |
|------|------|
| Consumer 产生 Decision 后如何输出？ | ❌ 未定义 |
| Runtime 如何获取 Consumer 的 Decision？ | ❌ 未定义 |
| Consumer 输出是否应标准化（如统一输出接口）？ | ❌ 未定义 |
| Observer 是否应参与 Decision Delivery？ | ❌ 未定义（ADR-003 明确不参与） |

### Impact

没有 Decision Delivery Contract，ADR-003 Step 4（GuardrailPipeline → ProgressConsumer 迁移）无法实施。具体来说：

- GuardrailConsumer.consume(snapshot) 内部可以产生 GuardrailDecision，但没有方法让它到达 Runtime
- 如果强行在 ADR-003 中定义 Delivery 机制，需要修改已冻结的 Consumer 接口或引入新机制
- ChatExecutor 无法从 Observer 路径获取终止指令，必须继续保留同步 Pipeline 路径
- 结果：Observer 路径和 Runtime Hook 路径并存，架构状态是「部分迁移」，不是「已迁移」

### Why Implementation Cannot Continue

Decision Delivery 是一条新的数据流，无论选择何种实现（回调、事件、共享状态、mailbox、queue），都会新增一个 Runtime Contract。ADR-003 未定义该 Contract，因此不能在 Step 3.3 的实现中现场设计。

---

## O-2: Consumer Event Domain 未定义

### Observation

当前 GuardrailPipeline 通过 `EvaluationEmitter` 将以下事件写入 Evaluation Event 流：

- `guardrail.checked`
- `guardrail.terminated`

写入时使用了 `as any` 类型强制转换（GuardrailPipeline.ts:94），表明这些事件类型不在 EvaluationEvent 的 union 定义中。

ADR-003 冻结了 `progress.snapshot` 事件类型，但未定义：

1. Consumer 是否可以写入 Evaluation Event 流？
2. `guardrail.*` 事件属于 Evaluation Event（Producer Fact）还是 Consumer Observation？

### Current Behavior

- `guardrail.checked`：每轮检测记录，内容包含 `{ action, reason }`
- `guardrail.terminated`：终止时记录，内容包含 `{ totalTurns, reason }`
- 这些事件通过 `EvaluationEmitter.emit()` 写入 `EvaluationStore`
- ProgressObserver 订阅了 `EvaluationStore.subscribe()` — 这意味着如果未来 Observer 或 Analyzer 处理 `guardrail.*` 事件，可能形成循环：Consumer 写事件 → Observer 读事件 → 影响下次 Snapshot → 影响 Consumer

当前不存在此循环风险（Analyzer 按 traceId 和事件类型过滤），但架构层面无任何防护。

### Missing Contract

| 项目 | 状态 |
|------|------|
| Evaluation Event Stream 是否允许承载 Consumer 观测输出？ | ❌ 未定义 |
| `guardrail.*` 的事件域归属 | ❌ 未定义 |
| Consumer 输出事件是否需要独立 Channel？ | ❌ 未定义 |
| Consumer 写入 Event Stream 是否应受限制？ | ❌ 未定义 |
| 如何防止 Consumer Observation 污染 Producer Fact？ | ❌ 未定义 |

### Impact

如果不定义 Event Domain：

- 未来 Consumer 输出事件与 Producer Fact 在同一流中混合，无法区分
- Replay 系统无法判断哪些事件是可重放的 Producer Fact，哪些是 Consumer 副作用
- 审计/分析工具无法区分「系统发生了 X」和「系统认为 X 有问题」
- 当多个 Consumer（Fitness、Reflection、Evolution）加入后，Event 流将混合多类观测输出

### Why Implementation Cannot Continue

Event Domain 是一个协议空白（Protocol Gap），不是实现问题。填补空白需要明确的架构决策（是否拆分流、如何划分域），不能在实现过程中隐含决定。

---

## Relationship Between O-1 and O-2

O-2 最初被认为是 O-1 的派生症状：Decision 无定义承载方式 → 借用 Evaluation Event → 出现 Event Domain 冲突。ADR Scope Review 基于此判定 O-2 可 deferred。

### O-2 Review (ADR-004 冻结后)

**Status:** 🔄 Narrowed — Not Fully Resolved

**已解决的部分：** ADR-004 Decision Delivery Contract 完成：
- Consumer 不再通过 Evaluation Event 流传递 Decision
- Decision Delivery 已有独立的 callback 通路（Consumer → Pipeline）

**仍开放的问题：** Audit Event Ownership
`guardrail.checked` / `guardrail.terminated` 仍由 Pipeline 通过 `EvaluationEmitter` 写入 Evaluation Event 流。这不是 ADR-004 的遗漏（Pipeline 持有 `currentTurn` 和 `EvaluationEmitter`，符合其职责），但架构上未定义：

- `guardrail.*` 是否应继续属于 Evaluation Event Stream？
- 还是应迁移至独立的 Audit / Decision Event Channel？
- 如果是独立 Channel，谁负责实现？

**根因重新评估：** O-2 不是 O-1 的纯派生症状。Decision Delivery 与 Audit Event Ownership 是两个独立架构问题。ADR-004 解决了前者，后者保留。

### 下一步

在 M3 中，此问题不阻塞 I-3 验证。Pipeline 保留 `emitGuardrailEvents()` 是临时性安排，非架构决策。如果未来引入 Fitness / Reflection Consumer 需要结构化 Audit 输出，应重新评估 Audit Event Channel。

---

## 关于 ADR Scope Review 的反思

ADR Scope Review 判定 "O-2 可能是 O-1 的症状"，这一判断被部分验证为真（Decision Channel 独立后，Consumer 不污染 Evaluation Stream），但未完全验证（Audit Event 的归属是一个独立的架构问题）。Scope Review 的正确率约 60%。

---

## 附件

| 项目 | 位置 |
|------|------|
| ADR-003 (已冻结 Protocol) | `docs/adr-003-unified-progress-observer.md` |
| Step 3.2 Verification Record | `docs/program-execution.md` §Verification Record |
| GuardrailPipeline 实现 | `src/main/core/evaluation/GuardrailPipeline.ts` |
| ProgressObserver 实现 | `src/main/core/evaluation/ProgressObserver.ts` |
| progress.ts (ProgressConsumer 接口定义) | `src/main/core/evaluation/progress.ts` |
| GuardrailTypes (GuardrailDecision 定义) | `src/main/core/evaluation/GuardrailTypes.ts` |
| GuardrailProgressAnalyzer (Producer 实现) | `src/main/core/evaluation/GuardrailProgressAnalyzer.ts` |
