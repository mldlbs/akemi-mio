# Decision Research 004 — Decision Delivery Contract

> **Phase:** ADR-004 Phase 0: Decision Research
> **Date:** 2026-07-08
> **Status:** ✅ Facts Collected — Pending ADR-004 Writing
> **References:**
> - [AOR-001](docs/aor-001-decision-delivery-and-event-domain.md)
> - [ADR Scope Review 001](docs/adr-scope-review-001.md)
> - ADR-003 (已冻结 Protocol)

---

**本文件不包含任何决策。** 它只记录事实、约束和候选模式，供 ADR-004 使用。

---

## R-1: Decision Lifecycle

### Decision 数据定义

```
GuardrailDecision {
  action:      GuardrailAction   // 'continue' | 'warning' | 'terminate'
  reason:      string
  decidedAt:   number            // timestamp
  traceId:     string
  signals:     SignalState[]     // 每信号状态 + detail
  snapshot:    ProgressSnapshot  // 产生决策的原始快照
}
→ toRuntimeAction() →
RuntimeAction  // 'CONTINUE' | 'WARNING' | 'TERMINATE'
```

来源：`src/main/core/evaluation/GuardrailTypes.ts:53-65`

### Decision 各字段的消费者

| 字段 | 被谁消费 | 用途 |
|------|---------|------|
| `action` | `toRuntimeAction()` → ChatExecutor | **控制流**：CONTINUE/WARNING/TERMINATE |
| `reason` | ChatExecutor | **日志**：`chat_guardrail_kernel_terminate` / `chat_guardrail_kernel_warning` |
| `signals` | GuardrailPipeline.emitGuardrailEvents() | **Event 输出**：写入 EvaluationEmitter |
| `snapshot` | GuardrailPipeline.emitGuardrailEvents() | **Event 输出**：`guardrail.terminated` payload |
| `decidedAt`, `traceId` | 无人消费（traceId 由 ChatExecutor 本地持有） | — |

来源：`src/main/agent/ChatExecutor.ts:669-687`, `src/main/core/evaluation/GuardrailPipeline.ts:89-117`

### Decision 时间线（一个 toolLoop 内）

```
toolLoop(rid)
    ↓
guardrailPipeline.reset()           ← turn -1
    ↓
for (i=0; i<MAX_TURNS; i++)
    ↓
  ...
    ↓
  if (throttle allowed)
    await guardrailPipeline.check(rid, i)   ← turn i
      ↓
      GuardrailProgressAnalyzer.analyze()
      → GuardrailPolicy.evaluate(snapshot)
      → toRuntimeAction()
      → emitGuardrailEvents()
      → return PipelineResult
    ↓
    switch (runtimeAction)
      TERMINATE → ctx.guardrailStop = true
      WARNING   → log
      CONTINUE  → no-op
    ↓
  ...
    ↓
  下次迭代时判断 guardrailStop
```

关键特征：
- **同步阻塞**：ChatExecutor await check() 完成才继续
- **无超时**：无 timeout wrapper、无 fallback（error → return null → skip）
- **无并发**：单 trace、单线程、单 RunContext
- **check 频率**：minTurnsBeforeCheck=5, checkIntervalTurns=5 → 每 5 轮触发一次

来源：`src/main/agent/ChatExecutor.ts:670-687`, `src/main/core/evaluation/GuardrailPipeline.ts:66-87`

### 终止路径

```
TERMINATE 到达
    ↓
ctx.guardrailStop = true
    ↓
for 循环继续当前迭代（执行当前 LLM 回复）
    ↓
下次迭代开始
    ↓
if (ctx.guardrailStop)
    return finalReply    ← 放行当前 LLM 回复后退出
```

注意：如果 TERMINATE 到达后 LLM 产生了 tool_calls，这些 tool 会被执行一次（消耗 token），直到下次迭代才退出。这不是 bug，而是当前实现的一个行为特性。

来源：`src/main/agent/ChatExecutor.ts:552-556, 674-678`

---

## R-2: Delivery Pattern 候选

### Pattern A: Direct Callback

**机制：** Consumer 的 `consume()` 接收一个 `(decision: GuardrailDecision) => void` 回调。Consumer 在 evaluate 完成后调用回调。Pipeline 注册该回调。

```
Pipeline 注册回调 → Consumer
Consumer.consume(snapshot)
    → policy.evaluate(snapshot)
    → callback(decision)
    → Pipeline 接收 Decision
```

| 维度 | 评价 |
|------|------|
| 同步？ | ✅ 同步 |
| 修改 `consume()` 签名？ | ⚠️ 需要添加第二个参数或通过构造函数注入 |
| C-5 合规？ | ✅ Consumer 不调用 Producer API |
| Observer 参与？ | ❌ 否 |
| 现有代码改动量 | 小 |

### Pattern B: Consumer 持有输出引用

**机制：** Consumer 构造时注入一个 `DecisionOutput` 接口，consume() 内部通过该接口输出 Decision。Pipeline 实现该接口。

```
class GuardrailConsumer {
    constructor(output: DecisionOutput)
    consume(snapshot):
        decision = policy.evaluate(snapshot)
        this.output.write(decision)
}
```

| 维度 | 评价 |
|------|------|
| 同步？ | ✅ 可同步 |
| 修改 `consume()` 签名？ | ❌ 不修改（注入在构造函数） |
| C-5 合规？ | ✅ Consumer 不调 Producer API |
| Observer 参与？ | ❌ 否 |
| 现有代码改动量 | 中 |

### Pattern C: EventBus 事件

**机制：** Consumer 将 Decision 作为 EventBus 事件发布。Pipeline（或 ChatExecutor）订阅该事件。

| 维度 | 评价 |
|------|------|
| 同步？ | ❌ 异步 |
| 修改 `consume()` 签名？ | ❌ 不修改 |
| C-5 合规？ | ✅ |
| Observer 参与？ | ❌ |
| 需要 buffer 机制？ | ✅ 需要（toolLoop 在等待 Decision 期间不能空跑） |
| 现有代码改动量 | 大 |

### Pattern D: Shared State / Mailbox

**机制：** Consumer 将 Decision 写入一个共享位置。Pipeline 轮询或触发读取。

| 维度 | 评价 |
|------|------|
| 同步性 | 取决于实现 |
| 耦合 | ⚠️ 引入共享可变状态 |
| 测试难度 | ⚠️ 需要 mock 共享状态 |
| C-5 合规？ | ⚠️ 取决于共享位置是否属于 Producer 域 |

### Pattern E: Queue / Channel

**机制：** Consumer → Queue → Pipeline。Message passing 模式。

| 维度 | 评价 |
|------|------|
| 适用场景 | 多生产者、多消费者、异步处理 |
| 当前系统复杂度 | ❌ 过度设计（当前单 trace、单 Consumer） |
| 现有代码改动量 | 大 |

### Pattern F: 修改 consume() 返回类型

**机制：** 将 `consume(snapshot): void` 改为 `consume(snapshot): GuardrailDecision | void`。GuardrailConsumer 返回 Decision，其他 Consumer 继续返回 void。

```
class GuardrailProgressConsumer implements ProgressConsumer {
    consume(snapshot): GuardrailDecision {
        return this.policy.evaluate(snapshot)
    }
}
```

| 维度 | 评价 |
|------|------|
| 同步？ | ✅ 同步 |
| 修改 `consume()` 签名？ | ❌ **违反 ADR-003 §ADR-4**：该决策明确 `consume()` 不定义统一返回值 |
| C-5 合规？ | ✅ Consumer 不调 Producer API |
| Observer 参与？ | ❌ 否，Observer 仍只做分发 |
| 现有代码改动量 | 最小 |
| Governance 路径 | 🔴 需要先修改已冻结的 ADR-003 §ADR-4 决策 |

**注意：** Pattern F 技术上可行且改动量最小，但直接与 ADR-003 已冻结的契约冲突。是否可接受取决于 ADR-004 是否能重新评估该冻结决策。ADR-004 应在 Considered Options 中记录此模式及其被拒绝的理由。

---

## R-3: Runtime Requirements

### 硬性约束

| # | 约束 | 来源 | 证据 |
|---|------|------|------|
| REQ-1 | Decision 到达后，下一个 LLM 调用前必须生效 | ChatExecutor 同步 await | `ChatExecutor.ts:671` |
| REQ-2 | TERMINATE 必须在当前轮次到达，不迟于下轮开始 | 无 buffer | `ChatExecutor.ts:552-556` |
| REQ-3 | WARNING 可以延迟（仅日志） | 非控制流 | `ChatExecutor.ts:679-681` |
| REQ-4 | Decision 错误不能中断 toolLoop | 当前 catch → return null | `GuardrailPipeline.ts:75-78` |

### 软性约束

| # | 约束 | 含义 | 优先级 |
|---|------|------|--------|
| REQ-5 | 最小化 consume() 签名变化 | 保持 ADR-003 的契约稳定 | 中 |
| REQ-6 | Pipeline 不直接依赖 Observer | 两层解耦 | 中 |
| REQ-7 | Runtime 只消费 RuntimeAction，不直接消费 GuardrailDecision | 现有架构 | 低（已实现） |
| REQ-8 | 单 trace 一次性 routing（无并发 routing） | ChatExecutor 为单例 | 信息性 |

### 性能特征

| 指标 | 值 | 说明 |
|------|----|------|
| check 最大频率 | 每 5 turn | `checkIntervalTurns = 5` |
| check 最小启动尺寸 | 5 turn | `minTurnsBeforeCheck = 5` |
| 一个 trace 内最多 check 次数 | ~60 次 | `MAX_TURNS / checkIntervalTurns = 300/5` |
| 每次 check 的延迟组成 | DB flush + SQL 查询 + 3 个信号计算 + policy evaluate | 取决于 trace 大小 |

---

## R-4: Governance Constraints

### ADR-003 冻结的约束

| 约束 | 来源 ADR-003 |
|------|-------------|
| `consume(snapshot): void \| Promise<void>` 签名不可修改 | §ADR-4 |
| Consumer 不定义 Signal | §ADR-4 |
| Consumer 无状态 | §ADR-4 |
| Consumer 不依赖其他 Consumer | §ADR-4 |
| Observer 不参与 Decision Delivery | §ADR-5: "Observer's responsibility stops at distributing Snapshot" |
| ProgressObserver 不引用 ChatExecutor | §ADR-5 |

### Governance Axioms 约束

| 约束 | 来源 |
|------|------|
| Architecture 冻结后不修改协议 | Axiom 2 |
| 任何违反必须回到 Observation | Axiom 3 |
| 新增 Contract 需要 ADR，不能在实现中隐含决定 | Axiom 1-3 |
| Governance Freeze Rule: M3 期间不主动扩展治理 | Governance Freeze Rule |

### Pattern 兼容性矩阵

| Pattern | ADR-003 compliant? | Axioms compliant? | 需要修改 consume()? | C-5 compliant? |
|---------|-------------------|-------------------|---------------------|----------------|
| **A: Callback** | ⚠️ 需要判断 callback 参数是否属于 `consume()` 签名变化 | ✅ 通过 ADR-004 可合规 | ⚠️ 是，或通过构造注入 | ✅ |
| **B: Output Interface** | ✅ consume() 不变 | ✅ 通过 ADR-004 可合规 | ❌ 不修改 | ✅ |
| **C: EventBus** | ✅ consume() 不变 | ✅ 通过 ADR-004 可合规 | ❌ 不修改 | ⚠️ 需要确认 EventBus 是否属于 Producer 域 |
| **D: Shared State** | ⚠️ 引入共享可变状态的风险 | ⚠️ 需要 ADR 评估 | ❌ 不修改 | ⚠️ 取决于实现 |
| **E: Queue** | ✅ 但过度设计 | ✅ | ❌ 不修改 | ✅ |
| **F: Return Type** | ❌ 违反 ADR-003 §ADR-4 冻结决策 | ❌ 需要先撤销 ADR-003 的冻结决策 | ✅ 修改返回类型 | ✅ |

---

## 开放问题（待 ADR-004 决定）

以下问题 Decision Research 不回答，留给 ADR-004：

| # | 问题 | 约束参考 |
|---|------|----------|
| Q-1 | Decision Delivery 是否应统一为 ProgressConsumer 的通用输出机制，还是 Guardrail 专有？ | REQ-4, REQ-5 |
| Q-2 | 如果采用 Callback/Output，是否应标准化 Decision 输出接口（如 `DecisionOutput<T>`）？ | REQ-5, REQ-8 |
| Q-3 | 异步方案是否值得引入 buffer/deferral 机制？ | REQ-1, REQ-2 |
| Q-4 | `decision.reason` 作为一个 string 是否应标准化为结构化类型？ | 当前仅做日志，R-3 ChatExecutor 不消费 signals/snapshot |
| Q-5 | Consumer 产生 Decision 后，是否需要 emit 对应 Event？如需要，Event Domain 归属哪里？ | O-2, ADR Scope Review 001 |

---

## 附件（代码引用）

| 位置 | 内容 |
|------|------|
| `ChatExecutor.ts:669-687` | Decision 消费点（switch-case） |
| `ChatExecutor.ts:552-556` | guardrailStop 退出路径 |
| `ChatExecutor.ts:490` | pipeline.reset() |
| `GuardrailTypes.ts:53-65` | GuardrailDecision 完整接口 |
| `GuardrailTypes.ts:26-51` | GuardrailAction / RuntimeAction / toRuntimeAction |
| `GuardrailPipeline.ts:66-87` | check() 完整逻辑 |
| `GuardrailPipeline.ts:89-117` | emitGuardrailEvents() |
| `GuardrailPipeline.ts:41-43` | 默认 throttle 配置 |
| `EvaluationEmitter.ts` | write-only Event 入口 |
| `progress.ts:227-229` | ProgressConsumer.consume() 接口 |
| `runstate.ts:75` | RunContext.guardrailStop 字段 |
