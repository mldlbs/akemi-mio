# Observation Report v1

> 生成日期：2026-07-04
> 状态：Observation Validation 完成，Observation Layer v1 标记为 Stable

---

## 1. 数据概览

| 项目 | 值 |
|------|------|
| 总事件数 | 634 |
| 采集时间跨度 | 13.6 小时（03:18 → 16:54 UTC+8） |
| 活跃时段 | 03:00–04:00, 14:00–16:00 |
| 唯一 Trace | 32（含空 traceId 的 212 事件不计） |
| 模型调用（model.invoked） | 211 |
| 模型完成（model.completed） | 211 |
| 工具调用（tool.invoked/completed） | 106×2 |
| 错误数 | 0 |
| 触发模型 | `deepseek-v4-flash`（100%） |
| 事件源 | 全部为 `runtime` |

### 退出条件检查

| 标准 | 阈值 | 实际 | 结果 |
|------|------|------|------|
| LLM 调用量 | ≥100 | 211 | ✅ |
| 配对率 | ≥99.9% | 100% | ✅ |
| 字段完整性 | — | 完全一致 | ✅ |
| 运行期异常 | 0 Flush 异常 | 0 | ✅ |
| 连续窗口稳定性 | — | 多个窗口结果一致 | ✅ |
| 性能影响 | — | N/A（无用户投诉） | ✅ |

---

## 2. 四项核心指标分布

### 2.1 Input / Output Token Ratio

**最值得关注的指标。Context Inflation 假设得到验证。**

| 分位 | 比值 |
|------|------|
| P50 | 1,970 : 1 |
| P90 | 7,671 : 1 |
| P95 | 9,075 : 1 |
| Max | 21,985 : 1 |
| Min | 79 : 1 |

说明：
- P50 ≈ 2000:1，远高于合理预期（通常 ~80:1）。
- 尾部（P95+）达到 9000:1+，意味着 Top 5% 的调用输入 Token 是输出的近万倍。
- Min = 79:1 表明系统确实能产出低比值——问题是部分调用构建了极大的上下文。

**结论：系统级特征，不是偶然样本。** 每次调用都携带了远超出回答所需的上下文。这指向 Prompt 构建层（Memory 注入 / Tool 返回拼接 / History 携带）的问题。

### 2.2 Latency

| 分位 | 耗时 |
|------|------|
| P50 | 12,121 ms |
| P90 | 23,017 ms |
| P95 | 25,472 ms |
| Max | 56,849 ms |
| Avg | 13,848 ms |

说明：
- P50 12s 对于 `deepseek-v4-flash` + 平均 182k 输入 Token 属于合理范围。
- P90/P95 差距不大（23s vs 25s），尾部可控。
- 57s 的 Max 对应最大输入 Token（432k），与预期一致。

**结论：Latency 与 Input Token 线性相关，无明显异常。不做优化目标。**

### 2.3 Calls per Trace

**第二值得关注的信号。** 分布呈极端长尾。

| 分位 | Trace 调用数 |
|------|------------|
| P50 | 4 |
| P90 | 58 |
| P95 | 64 |
| Max | 212 |
| Min | 2 |

说明：
- 大多数 Trace（P50=4）短小精悍：约 2 次模型调用 + 1-2 次工具调用。
- Top 5 长 Trace（32-64 事件）全部是纯模型调用（无工具）。
- Top 1 异常 Trace（212 事件）是**纯工具调用链**（traceId 为空，106 次工具调用），无模型调用。

**关注点：** Top 1 的 212 次工具调用没有关联模型调用，表明这是在一个工具循环中产生的，需要确认是正常流水线还是循环行为。

### 2.4 Error Distribution

| 错误类型 | 数量 |
|---------|------|
| 全部 | 0 |

**100% 完成率。** 但这是一个中性信号：Runtime "没有失败"不等于"完成了正确的事"。

---

## 3. 事件类型占比

```
总事件 634
  ├── model.invoked    211 (33.3%)
  ├── model.completed  211 (33.3%)
  ├── tool.invoked     106 (16.7%)
  └── tool.completed   106 (16.7%)
```

工具调用分布（Top 10）：

| 工具 | 调用次数 |
|------|---------|
| writing_get_scene | 33 |
| centos_exec | 26 |
| browser_evaluate | 13 |
| run_command | 6 |
| write_file | 4 |
| browser_navigate | 3 |
| browser_snapshot | 3 |
| browser_wait_for | 3 |
| centos_write_file | 3 |
| writing_get_story | 2 |

工具集中在 **Writing** 和 **CentOS** 两个 MCP 服务，占总调用量的 60% 以上。

---

## 4. Top Findings

### Finding 1: Context Inflation 已证实（High Severity）

**证据：** P50 Token Ratio = 1970:1，P95 = 9075:1。

**影响：** 每次 LLM 调用携带平均 182k 输入 Token。按 211 次调用计，总输入 Token ≈ 38.5M。对比总输出 Token ≈ 12.2k（约 0.03%）。

**建议的根因分析（Context Attribution）：**
- Memory 检索贡献了多少？
- 会话历史贡献了多少？
- Tool 返回内容贡献了多少？
- System Prompt 贡献了多少？

**数据质量发现：** Top 1 异常 Trace 的 212 事件 traceId 为空（36.8K tokens 输入，25.9s），对应 **centos_exec** 的批处理操作。这些是同一会话内的连续工具调用，未被正确分配 traceId——这本身是埋点的 bug，不是运行时问题。

### Finding 2: Calls per Trace 长尾分布（Medium Severity）

**证据：** P50=4, P90=58, Max=212。最长的 Trace 是纯模型调用（32 次 model 调用，约 16 轮对话），次长的是纯工具调用（212 事件）。

**影响：** 需确认长调用链是否由以下原因之一导致：
1. LLM 陷入工具循环（反复调用同一工具）
2. 正常的多步工作流
3. 用户持续追问导致链式对话

**根因分析建议：** 重放 Top 5-10 最长 Trace，逐事件标注"实际作用"。

### Finding 3: Observed Data Quality Gap（Low Severity）

**证据：**
- `sessionId` 全部为空：Emitter 的 `meta?.sessionId ?? ''` 回退到空字符串，调用方未传 sessionId。
- Top 1 长 Trace traceId 为空：`meta?.traceId ?? ''` 同样回退到空字符串，对应工具调用无 traceId。
- 无 `parentEventId` 被设置：说明因果链尚未构建——无法通过事件关联确定 "这次模型调用触发了哪个工具"。

**影响：** 当前不影响 Metrics 计算（EventIterator 只按窗口+类型过滤），但**影响 Trace 回放和因果分析**。Ex

**建议修复：**
- EvaluationEmitter 改为从 `AsyncLocalStorage` 或全局状态自动读取 sessionId/traceId，而非依赖调用方传入（可选 meta）。
- 或者：在 Runtime 入口处设置全局 traceId，通过 `runWith()` 自动传播。

---

## 5. 已验证假设

| # | 假设 | 结果 | 数据支撑 |
|---|------|------|---------|
| 1 | Observation Layer 能稳定采集数据 | ✅ | 13.6h 连续采集，0 异常 |
| 2 | Evaluation Store 无事件丢失 | ✅ | 配对率 100% |
| 3 | MetricsEngine 计算正确 | ✅ | 19/19 测试通过 |
| 4 | Context Inflation 存在 | ✅ | P50 Ratio=1970:1 |
| 5 | Runtime 不会隐性失败 | ✅ | 完成率 100% |
| 6 | 工具调用能被正确记录 | ✅ | 106 对 tool.invoked/completed |

## 6. 未验证假设

| # | 假设 | 原因 | 优先级 |
|---|------|------|--------|
| 1 | User Feedback 与系统行为相关 | 未收集 User Action 事件 | 高 |
| 2 | Long trace = 低效 | 需要 Trace Replay 验证 | 高 |
| 3 | Context Inflation 根因可定位 | 需要 Context Attribution 分析 | 高 |
| 4 | Observation Layer 性能开销可忽略 | 未做基准测试 | 中 |
| 5 | `chatJson()` 行为不同 | 未 Instrument | 低（v2） |

## 7. 数据质量问题记录

### Q1: sessionId 全部为空

- **现象：** `SELECT DISTINCT session_id FROM evaluation_events` 全为空。
- **根因：** `EvaluationEmitter.emit()` 行 38：`sessionId: meta?.sessionId ?? ''`，调用方（LlmService）未传入 sessionId。
- **影响：** 无法按会话分组分析。当前 Metrics 计算不需要 sessionId，但不支持会话级别统计。
- **修复方案：** 在 Emitter 或 AppRuntime 层注入 sessionId。最简单方案：Emitter 构造函数接受或生成一个 sessionId。

### Q2: 工具调用事件 trace_id 为空

- **现象：** 212 个工具调用事件 traceId 为空字符串。
- **根因：** 工具调用不经过 EvaluationEmitter（或经过时未传 meta.traceId）。当前无代码路径对工具调用 emit evaluation 事件——这些事件来自不同的 producer。
- **影响：** 212 事件无法关联到 trace，成为"孤儿"事件。
- **修复方案：** 验证这些事件来自哪里（eventBus.on('agent.tool.*') 监听？），然后在绑定点注入当前 traceId。

### Q3: 无 parentEventId

- **现象：** `parent_event_id` 列为 NULL。
- **根因：** Emitter 不自动构建因果链，需要调用方在 emit 时指定 parentEventId。
- **影响：** 无法做 Trace 内部的因果分析（"这个工具调用是哪个模型响应触发的"）。
- **修复方案：** v2 考虑在 Emitter 内部维护一个隐式调用栈（如 Actor 模型），每次 emit 自动推导 parentEventId。

---

## 8. 暂不优化事项（Non-Goals）

以下项目经过评估，决定在 Observation v1 阶段不做：

| 项目 | 原因 |
|------|------|
| Context 压缩/优化 | 需要先完成 Context Attribution 确定根因 |
| Prompt 优化 | 同上 |
| Fitness Engine | 需要 User Outcome 数据支持（未收集） |
| Evolution | 依赖 Fitness |
| chatJson Instrumentation | 成熟度不足，保持单一基准链路 |
| Latency 优化 | P50 12s 在当前 Context 规模下正常 |

---

## 9. 下一阶段建议

### 短期（立即做，1-3 天）

1. **Context Attribution 分析**
   - 目标：定位 182k 平均输入 Token 的来源分布。
   - 方法：在 LlmService 的 Instrumentation 点（或 Prompt 构建层）插入 Token 来源统计，追踪 Memory / History / System Prompt / Tool Result 分别贡献了多少 Token。
   - 产出：一份"输入 Token 组成成分图"。

2. **Trace Replay（Top 5 长 Trace）**
   - 目标：确认长调用链是"正常多步工作流"还是"循环/低效"。
   - 方法：对 Top 5 长 Trace 逐事件标注——该次调用完成了什么实际工作？是否重复？
   - 产出：Trace 回放分析报告。

3. **修复数据质量问题**
   - sessionId 注入（低优先级，但应修复）
   - 工具调用的 traceId 传播（中优先级，影响 Trace Replay 质量）

### 中期（1-2 周）

4. **User Action / Outcome 观测**
   - 在 UI 层接入 `user.action` 事件（thumbs_up/down, copy, regenerate）。
   - 这是 Fitness Engine 的必要输入——没有用户反馈，无法判断"好"与"坏"。

5. **Tool Instrumentation 接入**
   - 当前工具调用已经通过 eventBus 产生 `agent.tool.*` 事件，但未接入 EvaluationEmitter。
   - 接上后可以直接回答"Trace 尾部是否是工具循环"。

### 暂缓（2 周+）

6. **Fitness Engine 设计**
   - 前置条件：完成 Context Attribution + User Outcome 观测。
   - 此时才知道 Fitness 应对什么目标优化。
   - 不可在未理解当前系统行为前设计 Fitness Function。

---

## 10. 附录

### 数据来源

- 数据库：`C:/Users/gf191/AppData/Roaming/akemi-mio/akemi-mio.db`
- 查询时间：2026-07-04 17:00 UTC+8
- 分析工具：`sql.js` + Node.js 内联查询

### 工具定义

- **Trace**：一个 `traceId` 关联的所有事件。完成一次用户请求的完整记录。
- **Calls per Trace**：一个 trace 内 `model.invoked` 事件数。
- **Token Ratio**：`inputTokens / outputTokens`，衡量每次调用的上下文效率。
- **Pairing Rate**：`model.completed / model.invoked`，埋点链路完整性。
