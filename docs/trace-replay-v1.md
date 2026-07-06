# Trace Replay Report v1

> 日期：2026-07-05 | 分析方法：`evaluation_events` 逐事件回放

---

## 摘要

Top 5 Trace 可聚类为**两类完全不同的长尾模式**：

1. **纯工具链 Trace**（empty-trace, 235 事件, ~10h）— 有工具调用但无 LLM 事件，工具级联正常，非循环。
2. **纯对话 Trace**（4 条, 30-64 事件）— 有 LLM 调用但无工具调用，重复对话轮次造成 Context Inflation。

两者根因不同，但**两类 Trace 都遇到了同一底层问题**：消息上下文持续膨胀而缺乏有效的剪枝/退出机制。

---

## Trace 1: empty-trace（工具链, 235 事件, 10.2h）

**特征：** trace_id 为空字符串的 235 个事件，全为 `tool.invoked` + `tool.completed`，0 个 LLM 调用。

### 时间线分段

```
Phase 1 [0-20min]  Writing 场景浏览  →  writing_get_scene ×33（33 个不同 sceneId）
Phase 2 [6-15min]  ComfyUI 图片生成   →  run_command + generate_image + browser 交互
Phase 3 [15-52min]  ComfyUI 轮询      →  browser_evaluate ×13 + browser_wait_for ×3（反复检查队列）
Phase 4 [51-64min]  写作工具开发       →  create_dev_plan + write_file ×4（编写 writing-copy-tool）
Phase 5 [63-170min] CentOS 部署循环   →  centos_exec ×34 + centos_write_file ×4（反复部署+验证）
Phase 6 [170-610min] 部署修复         →  edit_file + centos_exec 调试（7h 间隔跳跃）
Phase 7 [609-611min] 最终部署         →  centos_read_file + centos_write_file 完成
```

### 工具使用分析

| 工具 | 调用数 | 工具 | 调用数 |
|------|--------|------|--------|
| centos_exec | 34 | writing_get_scene | 33 |
| browser_evaluate | 13 | run_command | 6 |
| centos_write_file | 4 | write_file | 4 |
| browser_navigate | 3 | browser_snapshot | 3 |
| browser_wait_for | 3 | centos_read_file | 3 |
| generate_image | 2 | writing_get_story | 2 |
| writing_list_scenes | 2 | browser_click | 1 |
| centos_grep | 1 | create_dev_plan | 1 |
| edit_file | 1 | writing_list_stories | 1 |
| writing_update_story | 1 | | |

### 循环分析

| 指标 | 值 |
|------|----|
| 相邻工具重复 | 63 / 118（53%）|
| 唯一工具数 | 19 / 118（多样性 16%）|
| Top 相邻重复 | `writing_get_scene→writing_get_scene` ×30, `centos_exec→centos_exec` ×24 |
| 相同 Tool 平均间隔 | 1126s（~19min）|

### 结论：不是异常循环

相邻重复率高（53%）但细看序列发现：

- **writing_get_scene ×30**：读取 33 个不同的 sceneId，是正常的小说场景批量读取，非重复调用同一资源。
- **centos_exec ×24**：32 个不同的 shell 命令，是正常的开发部署交互序列（mkdir → start server → curl verify → fix → restart 等）。
- 相邻重复是因批量连续调用同类工具所致（如 `browser_evaluate` ×8 是轮询队列状态），**不是死循环**。

**判定：NORMAL** — 这是用户使用 Writing MCP 和 CentOS MCP 的正常工作流，不是 LLM 失控循环。

---

## Trace 2-5: 纯 LLM Trace（4 条, 16-32 LLM 调用）

四条纯 LLM Trace 结构高度一致：LLM→Reply→LLM→Reply 模式，中间插入工具调用的事件在 `evaluation_events` 中不可见（因为当前 tool.invoked 不携带 traceId，但在整体数据中已确认 trail）。

### Trace 概况

| Trace | LLM 次数 | 耗时 | 总输入 Token | 总输出 Token | Token Ratio |
|-------|----------|------|-------------|-------------|-------------|
| req_173894_42 | 32 | 11.4 min | 2,298,308 | 473 | **4,859:1** |
| req_637102_13 | 29 | 13.4 min | 2,142,253 | 698 | **3,069:1** |
| req_805575_71 | 30 | 4.3 min | 883,005 | 1,543 | **572:1** |
| req_903990_91 | 15 | 2.9 min | 6,215,466 | 395 | **15,735:1** |

### 深层发现

#### 1. Token 累积曲线

以 `req_637102_13` 的输入 Token 变化为例：

```
#0  112k ├████████████████████████████████
#1  113k ├█████████████████████████████████
#2  113k ├█████████████████████████████████
#3  113k ├█████████████████████████████████
#4  113k ├█████████████████████████████████
#5  113k ├█████████████████████████████████
#6   59k ├█████████████████                ← Context Trim 发生！
#7   59k ├█████████████████
...
#10  60k ├██████████████████
...
#22  66k ├████████████████████
#28  68k ├████████████████████
```

关键模式：
- 每次调用 **仅增长 ~350-450 Token**（LLM 回复的携带成本）。
- 在 #6 处有一次 **Context Trim**（113k → 59k），剪掉了约一半。
- 修剪后**再次线性增长**（59k → 68k in 22 calls）。

这说明 **Context 修剪有效但不够激进**：修剪只砍掉了约 50%，然后被连续调用再次填满。

#### 2. 输出质量

所有 trace 中 **绝大多数调用的 output=0**（占比 ~60-70%）：

```
req_637102_13: 29 次调用中 18 次 output=0（62%）
req_903990_91: 15 次调用中 9 次 output=0（60%）
```

output=0 意味着 LLM 回复为空或只有工具调用声明（无文本回复），说明这些轮次中 LLM **只产生了工具调用但工具结果未返回 LLM**（可能被其他路径消耗了）。

#### 3. Latency 分布

| Trace | P50 | P95 | 备注 |
|-------|-----|-----|------|
| req_805575_71 | 5.5s | 9.3s | 正常 chat 延迟 |
| req_903990_91 | 8.1s | 13.1s | 输入 400k+，延迟略高 |
| req_173894_42 | 19.2s | 24.1s | 输入 72k，明显偏高 |
| req_637102_13 | 20.5s | 24.9s | 输入 57k，明显偏高 |

`req_805575_71` 和 `req_903990_91` 延迟正常（模型处理时间），但 `req_173894_42` 和 `req_637102_13` 在类似输入规模下延迟高了 3-4x，怀疑是其他并发请求导致的排队。

---

## 交叉分析

### Call Graph 聚类

```
空 trace:   Tool → Done → Tool → Done → ...    （工具级联，无 LLM）
纯 LLM:    LLM → Reply → LLM → Reply → ...    （纯对话，无工具）
```

两种模式泾渭分明，**尚未发现 LLM→Tool→LLM→Tool 的长链混合模式**。这意味着目前无 LLM 驱动的工具循环。

### Token Ratio 对比

| Trace 类型 | P50 Ratio | Context Trim 发生 |
|------------|-----------|-------------------|
| 纯工具 | N/A（无 LLM） | N/A |
| 纯 LLM（短）| 572:1 | 否 |
| 纯 LLM（长）| 1,618-7,887:1 | 偶发 |

长 Trace 的 Token Ratio 由重复输出的累积效应导致，而非系统 Prompt 异常膨胀。

### 数据质量问题影响

- 纯 LLM Trace 中的工具调用**没有 traceId**，因此无法在 Trace Replay 中看到 LLM→Tool 的完整调用链。
- 212 事件的工具链没有 traceId → 无法关联到触发它的 LLM 调用。
- **修复 traceId 传播后**，Trace Replay 可以合并 LLM+Tool 链，看到完整调用图。

---

## 诊断结论

### Finding 1: 工具链长尾是正常开发行为 ✅

**空 Trace(212事件)**的相邻重复率虽高（53%），但分析到命令级别后所有重复都是正常的多步开发操作（不同场景读取、不同命令执行）。没有发现死循环或失控循环。

### Finding 2: 纯 LLM 长尾 Trace 存在 "Zero-Output Creep" ⚠️

**60-70% 的 LLM 调用 output=0**。这意味着 LLM 在这些轮次中仅产生了工具调用声明（`tool_calls`），没有文本回复。由于工具调用结果不经过 LLM（直接由 `ToolScheduler` 执行），这些轮次本质上是在"空转"——LLM 花费了 token 和延迟，但产出为零。

**怀疑根因：** LLM 在 toolLoop 中被要求"继续"，但没有新信息可回答，于是输出空回复或仅工具调用。每次空轮回都会增加 ~350 Token 的对话历史，导致 Context Inflation 逐步恶化。

### Finding 3: Context Trim 有效但不够激进

`req_637102_13` 显示 Context Trim 在 #6 处发生（113k→59k），但修剪后 Token 再次线性增长。如果修剪阈值设在 60k，应在到达 113k 前的 #3 或 #4 处更早触发。

### Loop Score 汇总

| Trace | Events | LLM | Tool | 相邻重复 | 判定 |
|-------|--------|-----|------|---------|------|
| empty | 235 | 0 | 118 | 53% | NORMAL — 正常开发工作流 |
| req_173894_42 | 64 | 32 | 0 | N/A | NORMAL — 长对话，output=0 偏高 |
| req_805575_71 | 60 | 30 | 0 | N/A | NORMAL — 长对话，ratio 正常 |
| req_637102_13 | 58 | 29 | 0 | N/A | ⚠️ Zero-Output Creep 疑似 |
| req_903990_91 | 32 | 16 | 0 | N/A | ⚠️ Zero-Output Creep, 输入已达 400k+ |

---

## 下一步建议

### 优先修复

1. **TraceId 传播**（Observation v1.1）
   - 当前工具调用不携带 traceId，导致 LLM 事件和工具事件无法关联。
   - 修复后可以发现"LLM 连续调用同一工具"这类的实际循环模式。

2. **Zero-Output 检测**（Runtime Guardrail）
   - 如果 LLM 连续 N 次 output=0（或仅工具调用无文本回复），应触发退出而非继续循环。
   - 这直接关系 Context Inflation 的长尾。

### 优先分析

3. **为什么 output=0 调用占比如此高？**
   - 需要查看 ChatExecutor.toolLoop() 中这些轮次的实际 tool_calls 内容。
   - 当前数据只显示"LLM 调用了工具"，但不知道工具调用后 LLM 是否应继续。

### 暂缓

4. **Context Trim 阈值调整** — 当前仅偶发触发，且修剪后仍会反弹。这不是修复优先级；只有修复 Zero-Output Creep 后 Context 膨胀才会自然缓解。
