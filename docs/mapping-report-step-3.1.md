# Protocol Mapping Report — M3 Step 3.1

> **目标：** 确认当前代码是否忠实映射已冻结的 ADR-003 Protocol。
>
> **方法：** 将 ADR-003 与 `progress.ts` 中定义的每一条协议项映射到具体代码位置，标记实现状态。
>
> **原则：** 只记录事实和偏差，不修改代码，不提出实现优化。

---

## 1. Protocol 边界 — 当前代码结构

### 已冻结的协议资产

| 资产 | 位置 | 状态 |
|------|------|------|
| ProgressSnapshot 定义 | `src/main/core/evaluation/progress.ts:117-137` | ✅ 已冻结 |
| ProgressAnalyzer 接口 | `src/main/core/evaluation/progress.ts:192-204` | ✅ 已冻结 |
| ProgressConsumer 接口 | `src/main/core/evaluation/progress.ts:227-229` | ✅ 已冻结 |
| ProgressSignal (v2 目标) | `src/main/core/evaluation/progress.ts:156-173` | ✅ 已冻结 |
| Producer Contract | ADR-003 §Producer Lifecycle Contract | ✅ 已冻结 |

### 当前实现文件

| 文件 | 角色 | 与协议的关系 |
|------|------|-------------|
| `GuardrailProgressAnalyzer.ts` | ProgressAnalyzer 实现 | ✅ 实现方 |
| `GuardrailPipeline.ts` | Analyzer + Policy 适配器 | ⚠️ 承担了部分 ProgressObserver 职责 |
| `GuardrailPolicy.ts` | ProgressConsumer 之一 (Guardrail) | ✅ 消费者 |
| `GuardrailTypes.ts` | Guardrail 专有类型 + re-export | ✅ 协议合规 |
| `ChatExecutor.ts` | Runtime 调用方 | ⚠️ 直接调用了 GuardrailPipeline |
| `AppRuntime.ts` | 启动编排 | ⚠️ 组装 GuardrailPipeline |
| `EvaluationEmitter.ts` | 事件写入 | ⚠️ 是 Event Producer，不是 ProgressObserver |
| `EvaluationStore.ts` | 事件存储 | ✅ 实现 EvaluationRepository |
| `ProgressGuardrail.ts` | 独立轮次级停滞检测 | ❓ 非协议的一部分 |

---

## 2. Protocol Mapping

### ADR-1: ProgressSnapshot 语义边界

| Protocol Item | 要求 | Code Location | Status | Evidence |
|-------------|------|---------------|--------|----------|
| P-01 | ProgressSnapshot 不包含 score/health/shouldXxx | `progress.ts:117-137` | ✅ 合规 | 无 score/health/shouldXxx 字段 |
| P-02 | ProgressSnapshot 只包含直接从 EvaluationEvent 推导的事实 | `progress.ts:117-137` | ✅ 合规 | 所有字段均可从 Event 推导 |
| P-03 | Snapshot 不可变 | `progress.ts:117-137` | ✅ 合规 | 纯 interface，readonly 按需 |

### ADR-2: 依赖方向

| Protocol Item | 要求 | Code Location | Status | Evidence |
|-------------|------|---------------|--------|----------|
| P-04 | progress.ts 不 import Guardrail | `progress.ts:38` | ✅ 合规 | 唯一的 import 是 `types.ts` |
| P-05 | progress.ts 不 import Runtime | 同 P-04 | ✅ 合规 | — |
| P-06 | progress.ts 不 import ChatExecutor | 同 P-04 | ✅ 合规 | — |
| P-07 | GuardrailTypes.ts 引用 progress.ts（不反向） | `GuardrailTypes.ts:19` | ✅ 合规 | import from `./progress` |
| P-08 | GuardrailProgressAnalyzer 引用 progress.ts | `GuardrailProgressAnalyzer.ts:13-19` | ✅ 合规 | 引用接口定义 |

### ADR-3: 生产契约

| Protocol Item | 要求 | Code Location | Status | Evidence |
|-------------|------|---------------|--------|----------|
| P-09 | ProgressAnalyzer 是唯一生产者 | — | ⚠️ **偏离** | GuardrailPipeline 承担了部分 Observer 职责；无 ProgressObserver，Pipeline 直接调用 Analyzer |
| P-10 | compute() 是纯函数 | `GuardrailProgressAnalyzer.ts:313-334` | ⚠️ **偏离** | `observedAt: Date.now()` (`:329`) 引入 wall-clock 依赖，违反 Monotonicity |
| P-11 | analyze() 对同一 traceId 幂等 | `GuardrailProgressAnalyzer.ts:300-303` | ✅ 合规 | 委托给 static compute() |
| P-12 | Producer Contract: Pure Replay | `GuardrailProgressAnalyzer.ts:313-334` | ⚠️ **偏离** | 同上，Date.now() 导致 Replay 输出不一致 |
| P-13 | Producer Contract: 幂等 | `GuardrailProgressAnalyzer.ts:313-334` | ⚠️ **偏离** | observedAt=Date.now() 使得同一输入产生不同输出 |
| P-14 | Producer Contract: 不可变 | `GuardrailProgressAnalyzer.ts:297-334` | ✅ 合规 | 返回新对象，不修改输入 |
| P-15 | Producer Contract: Monotonicity / Replay Consistency / Producer Purity | `GuardrailProgressAnalyzer.ts:313-334` | ❌ **违反** | `observedAt: Date.now()` 让 Runtime wall-clock 影响 Snapshot。协议原文 §Producer Lifecycle Contract 明确将 `Date.now()` 列为违反示例 |

#### P-15 违反性质

P-15 同时违反三个契约维度：

| 维度 | 理由 |
|------|------|
| **Monotonicity** | 协议原文：`compute(E)` 只依赖 E，wall-clock 不影响 Snapshot。`Date.now()` 直接破坏此要求 |
| **Replay Consistency** | 同一批事件在不同时刻执行产生不同 `observedAt`，Replay 输出 ≠ Runtime 输出 |
| **Producer Purity** | `compute()` 不再是无副作用的纯函数，结果隐含对 `Date.now()` 的调用依赖 |
| P-16 | 增量缓存可选，不属于 Analyzer 职责 | `GuardrailPipeline.ts:53` | ⚠️ **偏离** | Pipeline 包含 throttle 状态 `lastCheckedTurn`，但不是 Analyzer 自身 |
| P-17 | Versioned: computeV1/V2 | `GuardrailProgressAnalyzer.ts:313` | ❓ 部分 | static compute() 使用 `PROGRESS_VERSION = 1`，无双版本路径 |

### ADR-4: 消费契约

| Protocol Item | 要求 | Code Location | Status | Evidence |
|-------------|------|---------------|--------|----------|
| P-18 | Consumer 用 consume() 统一入口 | — | ❌ **缺失** | 无 Consumer 实现 consume()；GuardrailPolicy 使用 evaluate() 而非 consume() |
| P-19 | Consumer 不自行扫描 Event | `GuardrailPolicy.ts:26-112` | ✅ 合规 | 只消费 ProgressSnapshot |
| P-20 | Consumer 无状态 | `GuardrailPolicy.ts:15-24` | ✅ 合规 | 仅持有可配置阈值，无跨调用状态 |
| P-21 | Consumer 不依赖其他 Consumer | `GuardrailPolicy.ts:26-112` | ✅ 合规 | 不引用其他 Consumer |
| P-22 | Consumer 异常不影响其他 Consumer | — | ❌ **缺失** | 无错误隔离机制（因为尚无多 Consumer 架构） |

### ADR-5: 交付机制

| Protocol Item | 要求 | Code Location | Status | Evidence |
|-------------|------|---------------|--------|----------|
| P-23 | ProgressObserver 订阅 EventBus | — | ❌ **缺失** | 无 ProgressObserver 文件 |
| P-24 | ProgressObserver 不引用 ChatExecutor | — | ❌ **缺失** | 不存在 |
| P-25 | ProgressObserver 是单例 | — | ❌ **缺失** | 不存在 |
| P-26 | 异步无阻塞 | — | ❌ **缺失** | 不存在 |
| P-27 | 可重放 | — | ❌ **缺失** | 不存在 |
| P-28 | Event Pipeline Observer 替换 Runtime Hook | `ChatExecutor.ts:636-677` | ⚠️ **偏离** | 当前 Runtime 同时调用 ProgressGuardrail (轮次级) 和 GuardrailPipeline (Trace 级) |

### ADR-6: Event Schema

| Protocol Item | 要求 | Code Location | Status | Evidence |
|-------------|------|---------------|--------|----------|
| P-29 | progress.snapshot 事件类型 | `types.ts:46-67` | ❌ **缺失** | EventType 中无 `progress.snapshot` |
| P-30 | Payload 仅含事实字段 | — | ❌ **缺失** | 无对应 payload 定义 |
| P-31 | 事件类型不可逆 | — | ❌ **缺失** | 无此事件类型 |
| P-32 | 向前兼容 | — | ❌ **缺失** | 无此事件类型 |
| P-33 | 不删除字段 | — | ❌ **缺失** | 无此事件类型 |

---

## 3. 汇总

### 状态统计

| 状态 | 计数 | 说明 |
|------|------|------|
| ✅ 合规 | 15 | 协议被忠实实现 |
| ⚠️ 偏离 | 6 | 实现有偏差但不破坏协议 |
| ❌ 违反 | 1 | P-15: Monotonicity 因 Date.now() 被违反 |
| ❌ 缺失 | 9 | 协议定义但未实现（主要为 ProgressObserver 和 Event Schema） |
| ❓ 部分 | 1 | P-17: 版本化仅部分实现 |

### 关键发现

1. **P-15（协议违反）** — `GuardrailProgressAnalyzer.compute()` 第 329 行调用 `Date.now()`。协议原文 §Producer Lifecycle Contract 明确禁止 `compute()` 中读取 `Date.now()`（违反示例表第 1 行）。同时违反三个契约维度：

   | 维度 | 理由 |
   |------|------|
   | **Monotonicity** | 协议原文：`compute(E)` 只依赖 E，wall-clock 不影响 Snapshot |
   | **Replay Consistency** | 同一批事件在不同时刻执行产生不同 `observedAt`，Replay 输出 ≠ Runtime 输出 |
   | **Producer Purity** | `compute()` 不再是无副作用的纯函数，结果隐含对 `Date.now()` 的调用依赖 |

2. **缺少 ProgressObserver** — ADR-5 的全部 6 项要求（P-23 到 P-28）均未实现。目前 GuardrailPipeline 充当了隐式的 Observer，但它包含了 throttle 状态（`lastCheckedTurn`），且直接运行在 ChatExecutor 的同步调用链中。

3. **Consumer 接口未适配** — GuardrailPolicy 使用 `evaluate()` 而非协议定义的 `consume()`。P-18 要求所有 Consumer 实现 `consume(ProgressSnapshot)`，当前尚未迁移。

4. **progress.snapshot 事件未定义** — ADR-6 的全部要求尚未实现。EventType 中无此类型。

### Replay Consistency 初步评估

**当前状态：不可验证。**

原因：
- `observedAt: Date.now()` 使得纯 Replay 必然产生不同输出
- 即使忽略 observedAt，Pipeline 中的 throttle 状态（`lastCheckedTurn`）也是内存状态，Replay 无法复现
- Event Schema 尚未包含 progress.snapshot 类型，无法从 Event 流重建 Observer 输出

**修复路径：**
1. compute() 中移除 Date.now()，`observedAt` 应由 Observer 层设置
2. 建立 ProgressObserver + Consumer 架构后，Replay 才可验证

---

## 4. Protocol Violation Review

### 违反项判定

| 违反 | 性质 | 严重程度 |
|------|------|----------|
| P-15: `Date.now()` 在 compute() 中 | Monotonicity / Replay Consistency / Producer Purity 同时违反 | **Critical** — 阻止 Replay Consistency 验证通过 |

P-15 属于 **实现偏离协议**，而非协议定义错误。

- 协议原文（§Producer Lifecycle Contract / Monotonicity / 违反示例表）**明确禁止** `compute()` 中读取 `Date.now()`
- 无模棱两可的解释空间
- 无需 ADR Revisit

### 处理决策

> **修实现，不修协议。** 将 `observedAt` 上移到 Observer 层（Snapshot 分发时由 Observer 附加），从 `compute()` 中移除 `Date.now()` 调用。

这是一种**边界修正（Boundary Fix）**，不是协议修改。与 Governance Freeze 一致：
- 不修改 Protocol 定义
- 不修改 `ProgressSnapshot` 接口
- 不修改依赖方向
- 不新增 Shared Abstraction

### Resolution Plan（进入 Step 3.2 前执行）

| 步骤 | 内容 | 影响范围 |
|------|------|----------|
| F-01 | `GuardrailProgressAnalyzer.compute()` 第 329 行移除 `observedAt: Date.now()`。将 `observedAt` 设为 0 | 仅该文件 |
| F-02 | 更新测试：确认 `compute(events)` 对同一输入返回完全相同的结果 | 测试文件 |
| F-03 | 全库 grep 确认无其他代码依赖 `snapshot.observedAt` 的 wall-clock 语义 | 验证 |

F-01 ~ F-03 完成后，P-15 视为已解决。

---

## 5. Step 3.2 进入条件

当前状态满足以下条件：

| 条件 | 状态 |
|------|------|
| Protocol Mapping 完成 | ✅ |
| Protocol Violation Review 完成 | ✅ |
| 违反项性质明确（实现问题，非协议问题） | ✅ |
| Resolution Plan 定义 | ✅ |
| P-15 边界修正已执行 | ⏳ **待执行 F-01 ~ F-03** |

> **Gate:** P-15 边界修正（F-01 ~ F-03）完成后，进入 Step 3.2（Producer Purity 验证）。
