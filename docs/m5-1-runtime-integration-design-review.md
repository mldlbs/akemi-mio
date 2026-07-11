# M5.1 Runtime Integration — Design Review

## Context

M4.1–M4.6 构成了完整的 Evaluation 基座：

- Event sourcing 与 projection 管道就绪
- Config schema evolution 已支持（eventSchemaVersion + migration layer）
- Replay durability 已实现（composite index、pagination、Decision 持久化、Observer startup catch-up）

M4 阶段只解决了数据的"写路径"（produce → store → replay），"读路径"（Runtime 如何消费 Evaluation 输出）尚未冻结。

当前实现中已有 runtime 相关的散装代码：

- `GuardrailPipeline.check()` 返回 `PipelineResult | null`
- `GuardrailDecisionStore.record()` fire-and-forget
- `GuardrailPipeline` 在 `AppRuntime.ts` 中创建但未被 `ChatExecutor` 引用
- `buildResult` 中的 `runtimeAction` 暂无 consumer

M5.1 不交付可运行代码，只冻结四个设计边界。M5.2 及之后才进入实现。

---

## Q1 — Decision Persistence Boundary

### 现状

```
Policy.evaluate()
    ↓
PipelineResult
    ↓
DecisionStore.write()    ← fire-and-forget，不 await
```

当前 `GuardrailPipeline.check()` 第 157 行：
```typescript
this.decisionStore?.record(decisionId, this.latestDecision, runtimeAction, traceId, currentTurn)
```
无 `await`，不阻塞决策返回。

### 冻结决策 — Decision-first

**Decision 产生不依赖 persistence success。**

```
Policy success
    ↓
return PipelineResult          ← 即时返回，storage 未确认
    ↓
async persist DecisionRecord   ← 不阻塞主路径
```

| 属性 | 取值 |
|------|------|
| Decision 可用时刻 | Policy.evaluate 完成即刻 |
| Decision 持久化时刻 | 异步，不保证 check() 返回前完成 |
| crash 时丢 Decision | 可接受（Observer catchup 兜底） |
| storage 不可用 | 不降级 Policy 行为 |

**原则**: `GuardrailDecisionStore` 是 audit durability，不是 policy execution dependency。

### 影响

- `GuardrailPipeline.check()` 保持 `decisionStore?.record()` fire-and-forget，不改为 await
- 测试不验证 record 返回值
- M5.4 Runtime Reliability 中考虑存储故障时是否补充重试机制

---

## Q2 — DecisionStore Query Contract

### 现状

`GuardrailDecisionStore` 当前只有一个查询方法 `getByTrace(traceId)`。

### 冻结决策 — 最小查询集

M5.3 Decision Query API 只暴露：

| 查询 | 签名 | 用途 |
|------|------|------|
| 单条决策查询 | `getDecision(decisionId): DecisionRecord \| null` | replay 验证、debug |
| Trace 查询 | `listByTrace(traceId): DecisionRecord[]` | trace 完整决策链 |

**不暴露**（这些属于 Analytics/Metrics 层，不在 M5 scope 内）：

- ❌ 按 `policyVersion` 查询
- ❌ 时间范围扫描
- ❌ 聚合查询（count、action 分布）
- ❌ 分页（trace 级别数据量可控，不需分页）

### `getDecision(decisionId)` 补充

当前 `GuardrailDecisionStore` 缺少 `getDecision()` 单条查询。M5.3 实现时需要在 `guardrail_decisions` 表上按 `decision_id` 主键查询。

---

## Q3 — Observer Catchup Boundary

### 现状

`ProgressObserver` 的 `replayWindowMs` 和 `GuardrailConfigStore` 的 `loadFromEvents()` 都从 `EvaluationStore` 读取事件，但语义不同：

| 组件 | 事件选择 | 窗口 |
|------|----------|------|
| ConfigStore.loadFromEvents() | 仅 config 事件 | 全量（无时间过滤） |
| Observer.start() catchup | 所有事件 | 最后 N 秒 |

### 冻结决策 — 两个窗口独立

```
ConfigStore:
    full event history replay
    scope: guardrail.config.* events only
    purpose: 重建运行时 Config state

Observer:
    bounded decision recovery window
    scope: all event types (用于 ProgressSnapshot 重建)
    purpose: crash recovery 补全未完成的 trace 决策
```

**两个窗口互不影响**。

- Config replay 没有窗口限制 — 必须回放全部 config 事件以保证 version chain 完整
- Observer replay 有窗口限制 — 只关心重启时可能遗漏的活跃 trace
- 不引入 "ConfigStore catchup window" 概念
- `replayWindowMs` 默认值 60s 冻结为 M5 默认值，配置来源在 M5.2 ChatExecutor Wiring 时确定

### 实现现状验证

当前代码：

- `GuardrailConfigStore.loadFromEvents()` → 遍历所有 event，无时间过滤
- `ProgressObserver.start()` → `store.query({ since: now - this.replayWindowMs })`，有时间窗口

与冻结决策一致，无需修改。

---

## Q4 — Runtime Failure Model

### 现状

当前实现中 failure mode 未统一声明，混合了两种策略：

| 路径 | 当前行为 | 实际模式 |
|------|----------|----------|
| `Policy.evaluate()` 异常 | 向上传播，不 catch | fail closed ✅ |
| `Pipeline.check()` Decision 缺失 | `latestDecision` null → return null | fail open（skip）✅ |
| `DecisionStore.record()` 失败 | catch → log WARN | degraded / fail open ✅ |
| `Observer.start()` catchup 失败 | catch → log WARN | best effort ✅ |

### 冻结决策

| 组件 | Failure Mode | 理由 |
|------|-------------|------|
| `Policy.evaluate` | **fail closed** | Policy 是安全核心，不能静默跳过 |
| `Pipeline.check()` decision 生成 | **fail closed** | 决策完整性依赖 Policy |
| `Pipeline.check()` throttle skip | **fail open** | throttle 是优化，跳过不丢语义 |
| `DecisionStore.write` | **degraded / fail open** | storage 不可用不降级 policy 行为 |
| `Observer.start()` catchup | **best effort** | 丢失 catchup 不影响 live processing |
| `GuardrailPipeline` 构造时 emitter/decisionStore 为 optional | **degraded / fail open** | emit/persist 能力缺失不阻断 pipeline |

**核心原则**: Guardrail 正确性不能依赖 durability subsystem。

### 与现有测试的验证

| 测试 | 覆盖的模式 |
|------|-----------|
| Producer boundary (T-7) | 构造时无 emitter/store 不抛 |
| GuardrailDecisionStore "失败 WARN 不抛" | degraded / fail open |
| Observer "catchup 失败不影响 live" | best effort |
| Pipeline throttle (T-3) | throttle skip = fail open |
| Pipeline 无 callback Decision 返回 null | fail open（skip = 放行）|

T-7 需要补充 assertion：Pipeline 在 Policy 抛异常时的行为（fail closed 验证）。标注为 M5.4 实施项。

---

## M5 实施顺序

```
M5.1  Runtime Integration Design Review（本文档）
    ↓
M5.2  ChatExecutor Integration Verification
      - Pipeline 注入与 wiring ✅（此前架构集成已完成）
      - Tool loop check ✅
      - runtimeAction handling ✅
      - Delivery trace ✅
      - Integration tests ⏸（当前缺口）
      - replayWindowMs 配置化 → 延后至 M5.4
    ↓
M5.3  Decision Query API
      - getDecision(decisionId) 补充
      - listByTrace(traceId) 保持
      - replay/debug 查询支持
    ↓
M5.4  Runtime Reliability
      - Policy.evaluate 异常测试补充（T-7）
      - DecisionStore 写入重试？fail open 确认不变
      - Observer catchup 可靠性加固
      - replayWindowMs 配置化
```

## Non-Goals (explicitly out of scope for M5)

- ❌ Event retention / TTL / 归档（运维议题）
- ❌ Migration lifecycle 政策文件（运维议题）
- ❌ Analytics / Metrics API（Metrics 层）
- ❌ Multi-trace 并发 Pipeline（当前 I-1 假设单 trace）
- ❌ Decision Stream 语义（当前 I-2 假设 Final Decision Only）
- ❌ Config UI / 手动调整

---

## Document Status

- **Review Date:** 2026-07-10
- **Status:** ✅ Frozen
- **Next:** 编写 M5.2 ChatExecutor Wiring Plan
