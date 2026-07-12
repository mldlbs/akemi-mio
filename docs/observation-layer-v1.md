# Observation Layer — Architecture Baseline v1

> 冻结于 2026-07-04。除非发现设计缺陷，不修改现有接口；只允许新增事件类型或 Instrumentation。

## 架构总览

```
Runtime (LlmService / ToolExecutor / ...)
    │   emit(type, payload)
    ▼
EvaluationEmitter ──── 写入入口，补充公共字段（id/timestamp/traceId/source）
    │   append(event)
    ▼
EvaluationRepository ── 契约接口（append / query / getTrace / subscribe / init / shutdown）
    │
    ├── EvaluationStore (SQLite) ── 生产实现，batch flush
    │
    ▼
EventIterator ────────── 只读事件流抽象（getEvents）
    │
    ▼
MetricsEngine ────────── compute(window) → MetricSnapshot
```

## 冻结协议

### Event 外壳

```typescript
interface EvaluationEvent {
  id: string           // UUIDv4
  timestamp: number    // Unix ms
  traceId: string      // 全链路追踪 ID
  sessionId: string
  source: string       // 模块名
  type: EventType
  payload: EventPayload
  parentEventId?: string
}
```

### EventType

`task.started` | `task.completed` | `tool.invoked` | `tool.completed` | `model.invoked` | `model.completed` | `user.message` | `agent.response` | `user.action` | `workflow.started` | `workflow.completed`

### 约束

- Event 只记录"发生了什么"，不记录"意味着什么"
- 追加日志，不可变，永不修改或删除
- type + payload 构成不可逆事实

## 冻结契约

### EvaluationRepository (extends EventStream)

| 方法 | 职责 |
|------|------|
| `append(event)` | 追加事件 |
| `query(range)` | 按时间/类型查询 |
| `getTrace(traceId)` | 按 trace 查询 |
| `subscribe(handler)` | 实时订阅 |
| `init()` | 初始化存储 |
| `shutdown()` | 优雅关闭 |

### EventIterator

| 方法 | 职责 |
|------|------|
| `getEvents(window, options?)` | 获取时间窗口内的事件 |

### MetricsEngine

| 方法 | 职责 |
|------|------|
| `compute(window)` | 返回 `MetricSnapshot`，一次扫描完成所有计算 |

### MetricSnapshot

| 域 | 字段 |
|----|------|
| `traffic` | totalCalls / completedCalls / failedCalls |
| `quality` | completionRate / avgOutputTokens |
| `latency` | avgMs / p50Ms / p95Ms / maxMs |
| `cost` | totalInputTokens / totalOutputTokens / totalTokens |

Snapshot 不含任何复合指标（Capability Density / Productivity 等属 Fitness）。

## 已验证范围

| 路径 | 状态 |
|------|------|
| `LlmService.chatWithTools()` → `_chatWithToolsStream()` | ✅ model.invoked + model.completed |
| Emit → Store → SQLite | ✅ |
| Trace replay (`getTrace`) | ✅ |
| Metrics compute 空窗口 | ✅ |
| Metrics compute 真实数据 | ✅ (1 条 trace: 102k in / 17 out / 4.4s) |
| Shutdown flush | ✅ |

## 未覆盖范围

| 路径 | 优先级 |
|------|--------|
| `chatJson()` / `chatJsonWithCode()` | 下一阶段 |
| `classifyIntent()` | 低（非代码模型调用） |
| Tool Instrumentation | 高阶 |
| Workflow Instrumentation | 高阶 |
| Task Instrumentation | 高阶 |
| User Action Instrumentation | 高阶 |
| Fitness Engine | 依赖真实 Metrics |
| Evolution | 依赖 Fitness |

## 数据观测记录

启动验证后首个有效样本：

- InputTokens: 102,362
- OutputTokens: 17
- Duration: 4,388 ms
- Completion: success

## Observation Validation Exit Criteria

达到以下条件前，不进入下一阶段（chatJson Instrumentation / Tool / Fitness）。

| 项目 | 退出标准 |
|------|---------|
| 数据量 | ≥100 次真实 LLM 调用（可根据实际调用频率调整） |
| 完整性 | `model.invoked` 与 `model.completed` 配对率 ≥99.9% |
| 数据质量 | Token、Latency 与 SDK 返回一致 |
| 稳定性 | 连续运行期间无事件丢失、无 Flush 异常 |
| Metrics | 连续多个窗口计算结果稳定且可重现 |
| 性能 | Evaluation 对请求性能影响保持在可接受范围 |

## 文件索引

| 文件 | 职责 |
|------|------|
| [types.ts](src/main/core/evaluation/types.ts) | Event 协议、Repository/Iterator/Metrics 接口 |
| [EvaluationStore.ts](src/main/core/evaluation/EvaluationStore.ts) | SQLite 存储实现 |
| [EvaluationEmitter.ts](src/main/core/evaluation/EvaluationEmitter.ts) | 写入入口 |
| [RepositoryEventIterator.ts](src/main/core/evaluation/RepositoryEventIterator.ts) | Repository → EventIterator 适配器 |
| [MetricsEngine.ts](src/main/core/evaluation/MetricsEngine.ts) | 计算引擎 |
| [LlmService.ts](src/main/llm/LlmService.ts) | 当前唯一 Instrumentation 点（chatWithTools） |
| [evaluation_events.ts](src/main/db/schema/evaluation_events.ts) | Drizzle ORM 表定义 |
| [migration.ts](src/main/db/migration.ts) | 迁移 v27 |
| [__test_verify_evaluation__.ts](src/main/core/evaluation/__test_verify_evaluation__.ts) | 链路验证（6/6） |
| [__test_verify_metrics__.ts](src/main/core/evaluation/__test_verify_metrics__.ts) | Metrics 验证（19/19） |
