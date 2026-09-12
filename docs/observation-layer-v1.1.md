# Observation Layer v1.1 — Bridge Integration

> 基线冻结日期：2026-07-04
> 分支：`feat/evaluation-bridge`

## 与 v1 相比新增

- **ToolEventBridge**：EventBus `agent.tool.*` → EvaluationEmitter 的适配器层
- **LlmService instrumentation**：`chatWithTools()` 路径的 `model.invoked` / `model.completed` 事件
- **MetricsEngine 定时任务**：10 分钟窗口基础指标计算（注册在 AppRuntime TaskRunner）

## 为什么 model.invoked 后移

v1 在 `chatWithTools()` 入口立即发射 `model.invoked`，导致 `INVALID_REQUEST` / `ABORTED` 等**未实际发出 HTTP 请求**的路径产生孤儿 invoked 事件。

v1.1 将 `model.invoked` 后移到 `try` 块内、`_doFetch()` 之前：

```
Observation 只记录真实发生的事实（Fact），而非曾经打算发生的意图（Intent）
```

## Scope

| 组件 | 纳入 |
|---|---|
| EventBus → ToolEventBridge → EvaluationEmitter → EvaluationStore | ✅ |
| `chatWithTools()` model.invoked / model.completed | ✅ |
| MetricsEngine 基础指标（traffic/quality/latency/cost） | ✅ |
| EvaluationStore SQLite 持久化 + batch flush | ✅ |

## Explicitly Out of Scope

- `chatJson()` / `chatText()` / `chatVision()` 的 model 事件（不携带 tools，风格不同）
- `classifyIntent()` 的 instrumentation
- Workflow / Conversation / User Action 的 Observation
- 新指标（复合指标属于 Fitness Engine）
- Dashboard / UI

## Verified Invariants

| 断言 | 验证方式 |
|---|---|
| Bridge 不承担 Domain Logic（纯 Adapter） | 代码审查：无聚合状态、无推断业务、无生命周期修正 |
| Kernel 不依赖 Runtime（EvaluationEmitter/Store/Metrics 无 Runtime 引用） | 代码审查：import 链不含 Runtime/bootstrap |
| Metrics 为纯函数计算 | `MetricsEngineImpl.compute(window)` 只依赖 `EventIterator` 接口 |
| Observation 记录 Fact 而非 Intent | `model.invoked` 后移到 HTTP 请求前 |
| Event 可重放（Store 为 append-only 追加日志） | 架构定义，未测试 |
| Tool → Evaluation 无反向依赖 | 代码审查：Bridge 仅 import EventBus + EvaluationEmitter |

## 全链路验证

```
EventBus.emit('agent.tool.*')
  → ToolEventBridge
    → EvaluationEmitter
      → EvaluationStore (SQLite flush)
        → RepositoryEventIterator
          → MetricsEngineImpl.compute()
```

4 个集成测试覆盖该链路，11 个单元测试覆盖 Bridge 层。

## 架构位置

```
Core Domain（Tool / Workflow）— 已冻结
    ↓ EventBus
Observation Kernel（EvaluationRepository / Store / Metrics）— 已冻结
    ↑ Bridge（ToolEventBridge）— v1.1 已冻结
        ↑ LlmService instrumentation
```

下一阶段不建议扩展 Observation，应等待真实运行数据驱动，或转向新的独立主题（如 Conversation Domain）。
