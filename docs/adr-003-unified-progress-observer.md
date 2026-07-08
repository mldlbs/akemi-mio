# ADR-003：Unified Progress Observer

**Status:** Frozen (Protocol Freeze — 2026-07-08)  
**Date:** 2026-07-08  
**Context:** Phase 1 确认 Guardrail MVP 在 Tool Runtime 内有效。ADR-002 冻结了架构边界。现在需要将 Progress Signal 从 Guardrail 专有协议升级为全系统共享基础设施。

---

## 现状

本 ADR 已完成 Protocol Freeze。当前文档定义了 Progress 子系统的完整架构边界。后续 Step 3+（Event Pipeline Observer 等）为工程实现，不改变本 ADR 中的任何协议定义。

---

## 问题

当前 ProgressSnapshot 定义在 `GuardrailTypes.ts` 中，与 Guardrail 强耦合：

- GuardrailPolicy 消费 ProgressSnapshot，同时拥有其定义
- Fitness Engine 如果要使用进展信号，必须要么引用 GuardrailTypes，要么重算
- 一旦 Frame 层（Reflection / Evolution / Adaptive Policy）也需要进展信息，将出现 N 套独立"进展"定义

**核心矛盾：** Progress 不属于 Guardrail，却锁在 Guardrail 的类型空间中。

**根因：** GuardrailTypes.ts 同时包含了 Infrastructure（ProgressSnapshot）和 Policy（GuardrailDecision、RuntimeAction、阈值）。两者应拆分到不同层。

---

## ADR-1：ProgressSnapshot 的语义边界

### 核心不变量

> **ProgressSnapshot is an immutable observation of runtime behavior, never an interpretation of runtime quality.**

ProgressSnapshot 永远描述"发生了什么"，而不描述"发生得好不好"。

这是 Infrastructure 和 Policy 最根本的分界线。

### 补充语义边界

> **ProgressSnapshot represents observable progress, not semantic correctness.**

ProgressSnapshot 描述的是系统可观察到的推进信号，不描述：
- 回答是否正确
- 推理是否优秀
- Tool 是否选择最佳
- 用户是否满意
- 最终任务是否真正完成（除非事件流中已有对应事实）

即使未来引入 Semantic Evaluator、Fitness Score 或 Reward Model，它们也不会反过
来污染 ProgressSnapshot 的语义边界。

### ProgressSnapshot 回答什么

> "系统当前是否正在产生有效推进？"

由一个不可变事实集合构成，不包含任何评价。

| 字段域 | 语义 | 是事实？ |
|--------|------|----------|
| `toolCalls` | tool.completed 计数 | ✅ |
| `assistantTurns` | agent.response 计数 | ✅ |
| `stateChanges` | 发生状态变化的轮次数 | ✅ |
| `goalProgressEvents` | task.completed + workflow 事件计数 | ✅ |
| `informationGainEvents` | 产生新信息的轮次数 | ✅ |
| `lastProgressTurn` | 最后发生推进的轮次索引 | ✅ |
| `stagnantTurns` | 连续无推进轮次数 | ✅ |
| `traceEvents` | Trace 内事件总数 | ✅ |

所有字段都直接由 EvaluationEvent 推导，不含阈值、不含评分、不含推荐。

### ProgressSnapshot 不回答

- ❌ "这个推进是好是坏" — Fitness 的职责
- ❌ "是否应该终止" — GuardrailPolicy 的职责
- ❌ "是否值得记住" — Memory 的职责
- ❌ "是否应该调整策略" — Adaptive Policy 的职责
- ❌ "Token 消耗是否正常" — Cost Metrics 的职责
- ❌ "进展得分是多少" — 任何时候都不应出现在 Snapshot 中

**所有 `score`、`health`、`shouldXxx` 类字段一律禁止出现在 ProgressSnapshot 中。**

### 违反示例

| 场景 | 问题 | 正确做法 |
|------|------|----------|
| ProgressSnapshot 中加 `progressScore: 0.81` | 混合评价与事实 | 移入 Fitness Consumer |
| ProgressSnapshot 中加 `isHealthy: true` | 阈值化判断属于 Policy | 移入 GuardrailPolicy |
| ProgressSnapshot 中加 `shouldTerminate: false` | 决策不属于 Infrastructure | 移入 RuntimeAction |

---

## ADR-2：依赖方向

### 全局依赖约束

```text
EvaluationEvent
        │
        ▼
ProgressAnalyzer
        │
        ▼
ProgressSnapshot
        │
        ├─────────────┐
        ▼             ▼
   Guardrail       Fitness
        ▼             ▼
   Reflection     Evolution
```

### 约束

- **Progress 不 import Guardrail**
- **Progress 不 import Runtime**
- **Progress 不 import ChatExecutor**
- **Progress 只依赖 EvaluationEvent**

`progress.ts` 是纯协议文件，它的 import 链必须只有 `types.ts`（EvaluationEvent）。

---

## ADR-3：生产契约

### ProgressAnalyzer 是唯一生产者

```typescript
// 生产者接口（Phase 2 冻结）
interface ProgressAnalyzer {
  /** 从事件流按 traceId 计算当前进展 */
  analyze(traceId: string): Promise<ProgressSnapshot>

  /** 纯函数：直接传入 EvaluationEvent[] 计算 */
  compute(traceId: string, events: EvaluationEvent[]): ProgressSnapshot
}
```

### 约束

1. **一次 Trace，一次计算** — ProgressAnalyzer.analyze(traceId) 对同一 traceId 幂等。
2. **不依赖运行时状态** — compute() 是纯函数，输入 Events → 输出 Snapshot，不持有任何状态。
3. **版本化** — 当 Signal 算法变更时，新版本用新的 compute() 方法（如 computeV2），旧版本保留。Event 流中的 progress.snapshot 记录版本号。

### Producer Lifecycle Contract

ProgressSnapshot 的生产者生命周期必须遵循以下契约。该契约是 Event Pipeline Observer（Step 3）和离线 Replay 的共同基础。

| 项目 | 契约 | 理由 |
|------|------|------|
| **输入** | `EvaluationEvent[]`（全 Trace 事件） | 保证幂等，避免增量不一致 |
| **输出** | `ProgressSnapshot` | 不可变值对象 |
| **更新方式** | **Pure Replay** — 每次传入全量事件重新计算 | 保证幂等 + 可重放 |
| **幂等** | 必须：`compute(traceId, events)` = `compute(traceId, events)` | 同一批事件产生相同 Snapshot |
| **增量缓存** | ProgressObserver 可做，不属于 Analyzer 职责 | 保持 Analyzer 纯函数 |
| **Snapshot 是否可变** | 不可变（readonly） | 避免 Consumer 副作用 |
| **Replay 是否唯一来源** | 是 | 不依赖运行时内存状态 |
| **Monotonicity** | `compute(E)` 只依赖 E。Runtime 状态、wall-clock、缓存、Consumer 行为不影响 Snapshot | 保证 Replay = Runtime |

### Monotonicity 的数学定义

```
ProgressSnapshot = f(EvaluationEvent[])

Runtime state, wall-clock time, caches, consumer behavior → MUST NOT
influence ProgressSnapshot.
```

这意味着：

| 场景 | 违反？ | 说明 |
|------|--------|------|
| compute() 中读取 `Date.now()` | ✅ 违反 | 时间流逝改变 Snapshot |
| compute() 使用 Observer 内存缓存 | ✅ 违反 | 缓存状态不同 → 结果不同 |
| compute() 依赖 Consumer 上次输出 | ✅ 违反 | Consumer 行为反作用于 Producer |
| compute() 读取全局配置（非 Event 内） | ✅ 违反 | 配置变化 → Replay 不一致 |
| compute() 只扫描传入的 events 数组 | ❌ 合规 | 输入决定输出 |
| compute() 使用 events 中的 timestamp 排序 | ❌ 合规 | timestamp 来自 Event 字段，非 wall-clock |

### 为什么必须 Pure Replay

选择 Pure Replay 而非增量更新，约束如下：

**增量更新的问题：**
```
event₁ → snapshot₁
event₂ → snapshot₂（基于 snapshot₁ 增量计算）
event₃ → snapshot₃（基于 snapshot₂ 增量计算）
```
- 任意中间 snapshot 损坏 → 后续全部偏移
- Observer 重启后无法从 Event 流重建当前状态（必须依赖 Checkpoint）
- 离线 Replay 需要重放全部 Event，但增量逻辑假设"已见过某些状态"

**Pure Replay 的性质：**
```
analyze(traceId) → getTrace(traceId) → compute(traceId, events)
```
- 同一 traceId 永远返回相同结果（events 未变时）
- Observer 崩溃后恢复只需从最新 event 开始
- 离线分析直接复用 compute()
- 无状态同步问题

### Producer Contract 的适用范围

| 场景 | 使用 | 契约适用 |
|------|------|----------|
| 实时 Observer | ProgressObserver 订阅 EventBus | Pure Replay on Turn boundary |
| 离线分析 | scripts/analysis/* | 全量 Replay |
| Memory Replay | 历史事件回溯 | 全量 Replay |
| History Rebuild | 迁移或恢复 | 全量 Replay |
| 增量缓存 | ProgressObserver 实现层（非 Analyzer 层） | 可选优化，不违背契约 |

---

## ADR-4：消费契约

### Consumer 接口

```typescript
// 消费者接口（Phase 2 冻结）
interface ProgressConsumer {
  /** 消费一个 ProgressSnapshot */
  consume(snapshot: ProgressSnapshot): void | Promise<void>
}
```

接口统一不定义返回值，因为不同 Consumer 的输出类型不同：
- Guardrail → GuardrailDecision（写入 Event 流或直接返回 Runtime）
- Fitness → Score（写入 MetricSnapshot）
- Reflection → Insight（写入 Event 流或 Memory）
- Evolution → Action（写入 Event 流）

**统一入口比统一输出更稳定。** Consumer 的具体输出由各自的类型定义，不在 Progress 协议层约束。

### 约束

1. **Consumer 不定义 Signal** — 只消费 ProgressSnapshot 中的字段，不自行扫描 Event 计算"进展"。
2. **Consumer 无状态** — consume() 不持有跨调用状态。
3. **Consumer 不依赖其他 Consumer** — GuardrailPolicy 不读取 Fitness 结果，反之亦然。
4. **Consumer 可独立禁用** — 任何 Consumer 抛出异常不影响其他 Consumer 的执行。@progress-observer 负责错误隔离。

### 当前 Consumer 映射

| Consumer | 当前类型 | Phase 2 状态 |
|----------|----------|--------------|
| GuardrailPolicy | GuardrailTypes.ts → GuardrailDecision | ✅ 保留，改为实现 ProgressConsumer |
| Fitness Engine | 尚无 | 🔄 未来，需实现 ProgressConsumer |
| Reflection Frame | 尚无 | 🔄 未来，需实现 ProgressConsumer |
| Adaptive Policy | 尚无 | 🔄 未来，需实现 ProgressConsumer |
| Evolution | 尚无 | 🔄 未来，需实现 ProgressConsumer |

---

## ADR-5：交付机制

### 从 Runtime Hook 到 Event Pipeline Observer

**Current (Phase 1 — Runtime Hook)：**

```
ChatExecutor.toolLoop()
    → GuardrailPipeline.check()
        → ProgressAnalyzer.analyze(traceId)
        → GuardrailPolicy.evaluate(snapshot)
        → RuntimeAction
```

**Target (Phase 2 — Event Pipeline Observer)：**

```
EvaluationRepository.append(event)
    → [EventBus 发布]
        → ProgressObserver (订阅 evaluation.event)
            → ProgressAnalyzer.compute(traceId, events)
            → Parallel 分发到所有 ProgressConsumer
                → GuardrailPolicy → RuntimeAction
                → Fitness Engine → MetricSnapshot
                → Reflection → Insight
```

### 迁移条件（从 ADR-002）

- [ ] Chat Runtime 扩展需要 Progress Signal 独立于 toolLoop
- [ ] Adaptive Policy 需要历史重放能力
- [x] **已满足：** Coverage Domain（Chat Runtime）需要 Progress Observer 脱离 Runtime Hook

### 架构约束

1. **Progress Observer 不引用 ChatExecutor** — 不 import ChatExecutor、toolLoop 等 Runtime 细节。
2. **Progress Observer 是单例** — 整个进程一个实例，所有 Runtime 共享。
3. **异步无阻塞** — ProgressObserver 的事件处理不阻塞 EventBus 的生产者。
4. **可重放** — 同一批 Event → 同一组 ProgressSnapshot（纯函数保证）。

---

## ADR-6：Event Schema 扩展

### 新增事件类型：`progress.snapshot`

```typescript
interface ProgressSnapshotPayload {
  traceId: string
  version: number          // Signal 生产算法版本
  computedAt: number       // Unix ms
  snapshot: {
    toolCalls: number
    assistantTurns: number
    stateChanges: number
    goalProgressEvents: number
    informationGainEvents: number
    lastProgressTurn: number      // -1 if never
    stagnantTurns: number
    traceEvents: number
  }
}
```

Payload 中只包含事实字段，不包含任何阈值化、评分或决策字段。

**禁止字段（举例，不限于）：** `action`、`decision`、`score`、`health`、`recommendation`、`policy`。

### 变更原则

1. **事件类型不可逆** — 一旦 `progress.snapshot` 加入 EventType，永久保留。
2. **向前兼容** — 新增 Signal 字段时只能可选（optional），旧 Consumer 忽略即可。
3. **不删除字段** — 废弃字段标记 `@deprecated`，至少保留两个版本。

---

## ADR-7：Non-goals

Unified Progress Observer 明确不负责：

- **终止决策** — GuardrailPolicy 负责，Observer 只提供数据
- **评分** — Fitness Engine 负责
- **Token/成本分析** — MetricsEngine 负责
- **事件存储** — EvaluationRepository 负责
- **重试/恢复** — Runtime 负责
- **用户偏好学习** — Memory/Meta 层负责

---

## 文件计划（Phase 2 实现时创建）

| 文件 | 职责 | 类型 |
|------|------|------|
| `src/main/core/evaluation/progress.ts` | ProgressSnapshot、ProgressAnalyzer、ProgressConsumer 协议定义 | **新建** |
| `src/main/core/evaluation/ProgressObserver.ts` | 订阅 EventBus，分发到所有 Consumer | **新建** |
| `src/main/core/evaluation/progress-consumers/` | Guardrail、Fitness、Reflection 等 Consumer 实现 | 后续 |
| `GuardrailTypes.ts` → 重构 | 删除 ProgressSnapshot 定义，从 progress.ts import | **重构** |

---

## 迁移方案

| 步骤 | 内容 | 产出 |
|------|------|------|
| 1 | 新建 `progress.ts`，定义 ProgressSnapshot + ProgressAnalyzer + ProgressConsumer | 协议冻结 |
| 2 | GuardrailTypes.ts 删除重复定义，引用 progress.ts | 无行为变化 |
| 2.5 | 冻结 Producer Contract（Pure Replay，幂等，不可变） | ADR-003 §Producer Lifecycle Contract |
| 3 | 新建 ProgressObserver（EventBus 订阅模式） | 新能力 |
| 4 | GuardrailPipeline 改为 ProgressConsumer 实现 | 架构迁移 |
| 5 | 打开 Chat Runtime 事件路径 | Coverage Domain 扩展 |

步骤 1-2.5 = 协议冻结阶段。步骤 3-5 按需执行，不在本 ADR 范围内。

---

## 冻结的决策摘要

| ADR | 决策 | 生效 |
|-----|------|------|
| ProgressSnapshot 语义 | 事实描述，不做判断。不包含 score/health/shouldXxx | 永久 |
| 依赖方向 | Progress 只依赖 EvaluationEvent，不 import Guardrail/Runtime | 永久 |
| 生产契约 | ProgressAnalyzer 是唯一生产者，纯函数，Pure Replay，版本化 | 永久 |
| Producer Contract | 输入全量 EvaluationEvent[]，Pure Replay，幂等，不可变，Monotonicity，非 Analyzer 不做增量 | 永久 |
| 消费契约 | Consumer 用 `consume()`，无统一返回值，无状态，彼此独立 | 永久 |
| 交付机制 | Event Pipeline Observer，不引用 Runtime | Phase 2 |
| Event Schema | 新增 progress.snapshot，payload 仅含事实字段 | Phase 2 |
| Non-goals | 7 项明确排除 | 永久 |

---

## 参考文献

- ADR-002：Guardrail Architecture（Phase 1 冻结）
- `GuardrailTypes.ts`：当前 ProgressSnapshot 定义
- `GuardrailProgressAnalyzer.ts`：当前 ProgressAnalyzer 实现
- `docs/project-status.md`：Program Baseline v1
- Observation v1.2 Report
