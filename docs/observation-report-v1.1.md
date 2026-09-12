# Observation Report v1.1

**日期：** 2026-07-05  
**样本窗口：** 2026-07-05 01:22 ~ 15:48 UTC（约 14.5 小时）  
**数据集：** Observation v1.1 Dataset（不含 v1.0 历史基线）

---

## 1. 数据概览

| 指标 | v1.1 Dataset | v1.0 Dataset（参考） |
|---|---|---|
| 事件总数 | 1,925 | 692 |
| 完整 Trace | 131 | — |
| 混合 LLM+Tool Trace | 53 (40.5%) | — |
| 仅 LLM Trace | 78 (59.5%) | — |
| 仅 Tool Trace | 0 | — |
| 空 traceId 事件 | 0 | 240 |
| 空 sessionId 事件 | 0 | 692 |

事件类型分布：
```
tool.invoked     525 (27.3%)
tool.completed   522 (27.1%)
model.invoked    444 (23.1%)
model.completed  434 (22.5%)
```

---

## 2. Calls per Trace

| | P50 | P90 | P95 | Max | Mean |
|---|---|---|---|---|---|
| LLM 调用/Trace | 1 | 6 | 10 | 36 | 2.79 |
| Tool 调用/Trace | 0 | 12 | 22 | 87 | 4.01 |

Trace 大小分布：
```
P50:  2 events
P90:  38 events
P95:  66 events
Max: 188 events (req_521795_1)
Mean: 14.7 events
```

**观察：** 分布极度右偏。50% 的 Trace 仅含 2 个事件（单次 LLM 调用，无工具），但长尾中最大 Trace 含 188 事件。P50 为 2 说明过半请求是简单对话，但复杂任务（P90 以上）显著拉高了均值。

---

## 3. Context Attribution（tokenBreakdown）

覆盖率：**100%**（444/444 model.invoked 均含有 tokenBreakdown）

### Per-Category 分布

| 类别 | P50 | P90 | P95 | Max | 总量占比 |
|---|---|---|---|---|---|
| **history** | 91,621 | 128,529 | 129,280 | 129,340 | **68.4%** |
| **tools** | 11,199 | 32,222 | 33,589 | 46,275 | 10.5% |
| **user** | 13,825 | 18,392 | 18,867 | 19,594 | 10.0% |
| **system** | 7,912 | 7,948 | 7,948 | 7,955 | 5.9% |
| **retrieval** | 884 | 1,307 | 4,251 | 252,400 | 4.7% |
| **runtime** | 235 | 1,357 | 1,393 | 1,456 | 0.4% |
| **memory** | 170 | 210 | 210 | 210 | 0.1% |

### Total tokens per request

```
P50:  139,616
P90:  170,495
P95:  174,031
Max:  382,391
Min:  8,673
```

**核心发现：** History 占据 68.4% 的总上下文，是 Context Inflation 的首要贡献者。tools（10.5%）和 user（10.0%）次之。retrieval 的 Max 值异常高（252,400），暗示存在极端检索场景。

---

## 4. Token 使用模式

| 指标 | P50 | P90 | Max | Min |
|---|---|---|---|---|
| Input Tokens | 129,114 | 204,220 | 361,569 | 6,240 |
| Output Tokens | 61 | 373 | 6,438 | 7 |
| Input/Output Ratio | **1,661.8** | 6,365.9 | 29,478 | — |

**Context Inflation 确认：** Input/Output Ratio P50 为 1,661.8:1。每生成 1 个 token 平均消耗 1,662 个输入 token。这与 history 占据 68.4% 的发现一致 — 对话历史的持续累积是主因。

---

## 5. 时间分布

数据集中在三个时段：
- **01:00-04:00**（高峰期 395 events/h @ 01:00）
- **11:00-12:00**（高峰期 700 events/h @ 12:00）
- **15:00**（321 events/h）

事件率与用户活跃时间一致，无异常突发。Tool 调用比例在高峰时段保持在 50-71%，模型使用平稳。

---

## 6. Trace 完整性验证

| 检查项 | 结果 |
|---|---|
| sessionId 非空 | ✅ 100% |
| traceId 非空（tool.*） | ✅ 100% |
| traceId 非空（model.*） | ✅ 100% |
| tokenBreakdown 存在 | ✅ 100% |
| 无 orphan 事件 | ✅ 0 |
| LLM↔Tool 关联可用 | ✅ 53 Traces |

**结论：** Observation v1.1 数据模型稳定，协议修复全部验证通过，可冻结 Observation Kernel。

---

## 7. Sessions

| Session | 事件数 | 时长 | 跨度 |
|---|---|---|---|
| runtime_1783211679238_ckpiuf | 1,837 | 14.4h | 01:22-15:44 |
| runtime_1783266310686_phku5i | 64 | <0.1h | 15:45 |
| runtime_1783266476759_lqexye | 24 | <0.1h | 15:48 |

主 Session 覆盖全天，其余为短 Session 不具代表性。

---

## 8. 关键发现

### Finding 1: Context Inflation 确认
**严重度：** High  
Input/Output Ratio P50 = 1,661.8，历史记录（68.4%）是压倒性因素。这不是单次请求的问题，而是整个上下文组装策略的系统性特征。

### Finding 2: Trace 分布极度右偏
**严重度：** Medium  
50% 的 Trace 仅含 2 个事件（无工具调用），但 P90 以上的 Trace 包含大量 LLM+Tool 交互。这种双峰分布意味着 Calls per Trace 类指标需要用分位数描述，不用均值。

### Finding 3: Retrieval 存在极端值
**严重度：** Low  
retrieval 的 Max=252,400（P50=884），相差 285 倍。存在特定的高检索场景，需确认是否正常。

### Finding 4: Output Token P50 极低（61）
**严重度：** Info  
P50 Output 只有 61 tokens，说明过半 LLM 调用都是简短回复。与复杂场景（Max=6,438）形成对比。

---

## 9. 建议

### 可立即处理（低风险）

1. **Context Inflation Analysis** — 基于 history 占比 68.4%，应分析对话历史截断策略是否需要调整。这不是修复，而是确认当前策略是否在预期内。

2. **Retrieval 极端值调查** — Max 252,400 的 retrieval token 来源，确认是否为单次异常检索还是预期行为。

### 需要决策（Progress Guardrail）

3. **Guardrail 基线数据** — 当前 Calls per Trace P90=38, P95=66. 如果 Guardrail 的目标是限制单次 Trace 的 Tool 调用次数，P95=66 可作为上限参考值。

4. **Calls per Trace 分位数 vs 均值** — 考虑 Guardrail 触发条件时，应使用 P90 而非均值，因为分布严重右偏。

### 暂不处理

5. **保持 Runtime 不变** — v1.1 数据模型稳定，Observation Kernel 冻结，继续采集 Longitudinal Data。

---

## 10. Next Action

**决策点：** 基于本报告，是否进入 Progress Guardrail 开发？

- **是：** 以 Calls per Trace P95=66 作为 Guardrail 上限阈值
- **否：** 继续采集数据，等待更稳定的 P95 估计（当前 131 Traces 可能不够稳定）

建议等待至 200+ Traces 后再做 Guardrail 决策，以确认 P95 的稳定性。
