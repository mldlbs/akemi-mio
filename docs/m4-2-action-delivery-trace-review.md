# M4.2 Action Delivery Trace Design Review

**Status:** Review  
**Precondition:** M4.1 Contract Production Verification ✅  
**Next:** Freeze schema → Implement producer → Verification tests

---

## 0. 当前状态（事实基线）

Pipeline 当前已有 `emitGuardrailEvents()`，生产 `guardrail.checked` 和 `guardrail.terminated` 两个事件类型。

```text
Pipeline.check()
  ├─ emitGuardrailEvents()         ← 现在：先写 event
  │   ├─ guardrail.checked         ✓ 每次 check
  │   └─ guardrail.terminated      ○ 仅在 TERMINATE 时
  └─ return PipelineResult
       └─ ChatExecutor switch      ← 真正 delivery 在这里
```

## 1. Trace 的生产位置

**结论：Trace 不应在 Pipeline 内产生，应在 Runtime（ChatExecutor）delivery 确认后产生。**

```
Pipeline.check()
  └─ return PipelineResult
       └─ ChatExecutor switch
            ├─ TERMINATE → ctx.guardrailStop = true
            │              └─ emit guardrail.delivered    ← 新位置
            ├─ WARNING   → log                            ← 可选的 lightweight trace
            └─ CONTINUE  → no-op                          ← 不产生 delivery event
```

理由：

| 因素 | Pipeline 内（当前） | ChatExecutor（建议） |
|------|-------------------|-------------------|
| 交付保序性 | event 在生产前，无法确认实际被消费 | event 在生产后，且确认被处理 |
| 职责边界 | Pipeline 是 Decision→RuntimeAction 适配器，不负责投递确认 | ChatExecutor 是实际消费者，负责确认交付 |
| Error 覆盖率 | emit 在 return 前，若 ChatExecutor 中途 return，event 已写但未交付 | emit 在 switch 内，只有真正到达的分支才产生 event |
| 非侵入性 | Pipeline 需要持 emitter 引用（已存在） | ChatExecutor 已持有 eventBus，无需新依赖 |

**边界冻结：**

- Decision 层事件（`guardrail.checked` / `guardrail.terminated`）由 Pipeline 保留生产，属于 Policy 层事实
- Delivery 层事件（`guardrail.action_delivered`）由 ChatExecutor 在生产，属于 Runtime 层事实
- ChatExecutor 在 switch 各分支内通过 eventBus 写入 delivery event
- Pipeline 不在 decision 事件中使用 `deliveryStatus` — 那是 delivery 层的职责

## 2. Trace 记录对象 — 两层分离

**结论：Decision Events 和 Delivery Facts 是两层不同的事实，不应合并。**

当前只有一个 `guardrail.terminated`，但它实际上混合了两层语义：
- "Policy 决定终止"（决策层事实）
- "Runtime 已执行终止"（交付层事实）

拆分为：

```
Pipeline layer:
  guardrail.checked        ← 检测记录（保留）
  guardrail.terminated     ← 决策结果（保留，明确为 Policy 层事实）

Runtime delivery layer:
  guardrail.action_delivered  ← 交付事实（新增）
```

### 2a. Decision 层（Pipeline 产出，保留已有事件）

| 事件 | 生产者 | 语义 | Replay 依赖 |
|------|--------|------|-------------|
| `guardrail.checked` | Pipeline | 每次 check 记录 | ❌ |
| `guardrail.terminated` | Pipeline | Policy 决定终止 | ❌ |

`guardrail.terminated` 表达的是 **Policy 决策结果**："系统决定终止（但尚未执行）"。它不是交付事实，不需要 deliveryStatus。

### 2b. Delivery 层（ChatExecutor 产出，新事件）

Delivery 层包含两个独立的事件类型，不使用状态字段模拟事件分类：

```typescript
/** guardrail.action_delivered — Policy 决策已被 Runtime 成功执行 */
interface GuardrailActionDeliveredPayload {
  type: 'guardrail.action_delivered'
  /** 决策 ID，与 GuardrailDecision 关联 */
  decisionId: string
  /** 关联 traceId */
  traceId: string
  /** 实际生效的 RuntimeAction */
  actionType: 'TERMINATE' | 'WARNING' | 'CONTINUE'
  /** Policy 版本 */
  policyVersion: string
  /** 投递时间戳 */
  timestamp: number
}

/** guardrail.action_delivery_failed — Policy 决策未能被 Runtime 执行 */
interface GuardrailActionDeliveryFailedPayload {
  type: 'guardrail.action_delivery_failed'
  /** 决策 ID，与 GuardrailDecision 关联 */
  decisionId: string
  /** 关联 traceId */
  traceId: string
  /** Policy 期望的 RuntimeAction */
  intendedAction: 'TERMINATE' | 'WARNING' | 'CONTINUE'
  /** Policy 版本 */
  policyVersion: string
  /** 投递时间戳 */
  timestamp: number
  /** 失败原因 */
  errorCode: string
}
```

**Decision Identity 引用规则：** Delivery Event 必须通过 `decisionId` 引用 `GuardrailDecision`，不允许嵌入 Snapshot、PolicyInput、evaluationSignals 等 Policy 计算输入。Snapshot 属于 Evaluation 层事实，Delivery Trace 属于 Runtime 层事实，混合会破坏 Replay 边界。

**职责分离矩阵：**

| 事件 | 生产者 | 所属层 | 用途 | Replay 依赖 |
|------|--------|--------|------|-------------|
| `guardrail.checked` | Pipeline | Decision | 检测记录，频率分析 | ❌ |
| `guardrail.terminated` | Pipeline | Decision | Policy 终止决策 | ❌ |
| `guardrail.action_delivered` | ChatExecutor | Delivery | 投递确认 | ❌ |
| `guardrail.action_delivery_failed` | ChatExecutor | Delivery | 投递失败记录 | ❌ |

**不在此范围：**

- ❌ `decisionId` 的生成策略（Policy 当前没有 stable ID，这是 M4.3+）
- ❌ Fitness / Reflection 消费字段

## 3. Trace 的可靠性

**冻结语义定义：**

| 属性 | 值 | 理由 |
|------|-----|------|
| 生成时机 | delivery **后** | event 是"已发生事实"的记录，不是"预测" |
| Failed delivery | ✅ 产生 `deliveryStatus: 'failed'` 的 event | 允许 Runtime 区分"未检测"和"检测了但未交付" |
| Append-only | ✅ 沿用 EvaluationStore.append() | 同一约束 |
| Replay 依赖 | ❌ 不依赖 | T-4 已证明 `guardrail.*` 事件不会影响 `compute()` |

**四类 delivery 路径：**

| Runtime path | 产出事件 | actionType / intendedAction | 语义 |
|-------------|----------|---------------------------|------|
| switch 进入 TERMINATE 分支 | `guardrail.action_delivered` | `TERMINATE` | 终止指令已交付 Runtime |
| switch 进入 WARNING 分支 | `guardrail.action_delivered` | `WARNING` | 警告已记录 |
| switch 进入 CONTINUE 分支 | `guardrail.action_delivered` | `CONTINUE` | 继续指令已确认（可选产生 event） |
| switch 内异常 / 中途 return | `guardrail.action_delivery_failed` | `TERMINATE`(intended) | termination 决策未被执行 |

**注意：** `action_delivery_failed` 场景只在 `guardrail.terminated`（决策已产生）但没有对应 `guardrail.action_delivered { actionType: 'TERMINATE' }` 时才有意义。如果 Pipeline 返回的是 `CONTINUE` 但 ChatExecutor 挂了，这属于进程级故障，不是 Action Delivery Trace 的职责范围。

**注意：** `failed` 场景只在 `guardrail.terminated`（决策已产生）但没有对应 `guardrail.action_delivered { status: 'delivered' }` 时才有意义。如果 Pipeline 返回的是 `CONTINUE` 但 ChatExecutor 挂了，这属于进程级故障，不是 Action Delivery Trace 的职责范围。

## 4. 实施步骤

```
1. Design Freeze        ← 本文档
   ├─ 确认两层分离：Decision 层（checked/terminated）保留，Delivery 层（action_delivered）新增
   ├─ 确认生产位置：Delivery 层在 ChatExecutor switch 内
   ├─ 确认 schema：guardrail.action_delivered (traceId, runtimeAction, policyVersion, status: delivered|failed)
   └─ 确认可靠性语义：delivery 后产生，failed 也记录；delivered 和 failed 是互斥状态

2. Schema Freeze
   ├─ types.ts 添加 EventType 'guardrail.action_delivered'
   ├─ types.ts 添加 GuardrailActionDeliveredPayload
   └─ guardrail.terminated 保留为决策事实，不标记废弃

3. Producer 实现
   ├─ ChatExecutor switch 内 emit guardrail.action_delivered
   └─ Pipeline 保留现有 emitGuardrailEvents() 作为 decision 层（D-5）

4. Verification Tests
   ├─ guardrail.action_delivered 在 delivery 后写入
   ├─ guardrail.action_delivery_failed 在投递异常时写入
   ├─ new guardrail.* 事件不影响 compute()（T-4 扩展）
   └─ Decision 层（checked/terminated）与 Delivery 层（action_delivered/action_delivery_failed）互不干扰
```

## 5. 不在此范围

- `decisionId` 的全局唯一性（当前用 randomUUID + traceId 合成，无需额外基础设施）
- PolicyConfig 版本化（M4.3）
- Action Delivery 的观察者模式（Fitness/Reflection 是独立 Consumer，不应旁路订阅 delivery）

---

**决策冻结清单：**

| # | 决策 | 状态 |
|---|------|------|
| D-1 | Delivery Trace 在 ChatExecutor switch 内产生，不在 Pipeline | ✅ |
| D-2 | Decision 层（`guardrail.checked`/`guardrail.terminated`）保留为 Policy 层事实 | ✅ |
| D-3 | Delivery 层新事件类型 `guardrail.action_delivered`，与 Decision 层职责分离 | ✅ |
| D-4 | `delivered` 和 `failed` 是互斥状态，不是同一事件实例的生命周期 | ✅ |
| D-5 | Delivery 后生成 event，failed 也记录 | ✅ |
| D-6 | Pipeline 保留现有 `emitGuardrailEvents()`（decision 层），作为兼容层保留 | ✅ |
| D-7 | 不引入 Fitness / Reflection 消费字段 | ✅ |
