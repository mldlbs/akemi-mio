# ADR-002：Guardrail Architecture

**Status:** Draft  
**Date:** 2026-07-07  
**Context:** Observation v1.2 确认 Guardrail MVP 在 Tool Runtime 内有效，同时发现 Chat Runtime 完全不在检测域内。在扩展覆盖范围或调整策略前，需先冻结 Guardrail 的架构边界。

---

## ADR-1：职责（Responsibility）

**核心问题：Guardrail 在保护什么？**

### 候选定义

| 定义 | 覆盖 | Progress 信号 | 当前状态 |
|------|------|---------------|----------|
| **A. Workflow Guardrail** — 防止工具工作流陷入无效循环 | Tool Runtime | tool, workflow, goal | **MVP 当前实际实现** |
| **B. Agent Progress Guardrail** — 防止 Agent 长时间无有效推进 | Tool + Chat + Workflow Runtime | 与 Runtime 无关，与 Trace 相关 | 更高层抽象 |
| **C. Cost Guardrail** — 防止 Context / Token / Cost 无限增长 | 不限 Runtime | token growth, context inflation, output density | 可独立于 Progress 存在 |

### Observation 证据

- MVP 在 Tool Runtime 的 76 条 Eligible Trace 上触发 4 次
- Chat Runtime 的 13+ 条 Trace（0 tool events，198 轮调用）触发 0 次
- Progress Density 对比：Triggered Trace (92%) ≈ Healthy Long Trace (91%) — 当前信号对 Tool 活动敏感，对目标推进不够敏感

### 决策

**→ 采用 B（Agent Progress Guardrail），但按 Phase 渐进实施。**

明确区分当前实现与目标架构：

| 状态 | 定义 | 覆盖 |
|------|------|------|
| **Current State** | Workflow Progress Guardrail — 防止工具工作流陷入无效循环 | Tool Runtime |
| **Target State** | Agent Progress Guardrail — 防止 Agent 长时间无有效推进 | Tool + Chat + Workflow Runtime |

Phase 1（当前冻结）：维持 MVP 的 Tool Runtime 覆盖（Current State），不缩小也不扩大。
Phase 2：扩展到 Chat Runtime，将 Progress Observer 从 toolLoop 提升到 Conversation 层（Target State Phase 1）。
Phase 3：引入 Cost Guardrail 作为独立信号，与 Progress 并行评估。

---

## ADR-2：Coverage Domain

**核心问题：Guardrail 观察哪些 Runtime？**

### 事实（Observation v1.2）

```
Agent Runtime
      │
      ├── Tool Runtime    76 Eligible → 4 Triggered
      └── Chat Runtime    13 Eligible → 0 Triggered
```

### 架构选择

| 模式 | 结构 | 复杂度 | 耦合 |
|------|------|--------|------|
| **Runtime-local** | 每个 Runtime 各自拥有 Guardrail | 低 | 与 Runtime 生命周期一致 |
| **Runtime-global** | 统一 Progress Observer 覆盖所有 Runtime | 高 | 与 Runtime 解耦 |

### 决策

**→ 采用 Runtime-global，但通过统一 Event Pipeline 实现。**

关键约束：不直接在 ChatExecutor 或 toolLoop 中新增检测点，而是通过 Progress Observer（订阅 Evaluation Event 流）实现全局覆盖。这样 Chat Runtime 天然获得检测能力，无需修改 ChatExecutor。

---

## ADR-3：Architecture Pattern

**核心问题：Guardrail 是 Runtime Hook 还是 Event Pipeline Observer？**

### 当前模式（Runtime Hook）

```
ChatExecutor
    ↓
toolLoop()
    ↓
GuardrailPipeline.check()
```

特点：实时、简单、Runtime 强耦合。Guardrail 生命周期绑定 ChatExecutor。

### 候选模式（Event Pipeline Observer）

```
Evaluation Events → Progress Observer → GuardrailPolicy → RuntimeAction
```

特点：可重放、可实验、Runtime 解耦。Guardrail 不再直接依赖 toolLoop。

### 决策

**→ 渐进式迁移：当前保留 Runtime Hook，ADR 指导 Phase 2 迁移到 Event Pipeline Observer。**

迁移条件：
- [ ] 评估 Event Pipeline Observer 延迟（当前实时检测增加 ≤100ms）
- [ ] Chat Runtime 扩展需要 Progress Signal 独立于 toolLoop
- [ ] Adaptive Policy 需要历史重放能力

---

## ADR-4：Architecture Invariants

无论 Architecture Pattern 如何演化，以下原则必须保持：

1. **Observation-first** — 任何 Guardrail 行为变更前必须有对应版本的 Observation 基线
2. **Policy 与 Runtime 解耦** — Policy 不感知 ChatExecutor、toolLoop 等 Runtime 细节
3. **Progress Signal 可重放** — 所有 Signal 可离线重新计算，不依赖运行时状态
4. **Event 不可修改，只追加** — Guardrail 产生的 Event 一旦写入不再变更
5. **Guardrail 不拥有业务状态** — 所有状态来自 Evaluation Event 流或 Trace 存储

---

## ADR-5：Non-goals

**核心问题：Guardrail 明确不做什么。**

Guardrail 不负责：
- **Prompt 优化** — 不修改或编排用户 Prompt
- **Token Compression** — 不触发 Context 压缩或摘要
- **Cost Optimization** — 不选择模型或路由，仅报告 Cost 信号
- **Tool Selection** — 不决定调用哪个工具
- **Error Recovery** — 不重试失败的 Tool 或 Workflow
- **Behavior Learning** — 不学习用户偏好（这是 Memory/Meta 层的职责）
- **Execution Orchestration** — 不决定任务顺序或并行度

当新功能请求超出以上列表时，应创建新的 ADR 而非扩展 Guardrail 职责。

---

## ADR-6：Progress Signal is infrastructure, not policy

**核心原则：Progress Signal 是整个演化系统共享的基础设施，不属于任何单一消费者。**

### 约束

1. **Progress Snapshot 是唯一进展定义** — Guardrail、Fitness、Reflection、Evolution 都使用相同的 ProgressSnapshot，不得各自重新计算一套"进展"。
2. **ProgressAnalyzer 是唯一生产者** — 所有 Progress Signal 必须经过 GuardrailTypes.ts 定义的 ProgressAnalyzer 接口。后续新增 Signal（如 Cost Signal）需扩展 ProgressSnapshot，而非另起炉灶。
3. **消费者不定义 Signal** — GuardrailPolicy 只消费 ProgressSnapshot 做决策，不新增 Signal。Fitness Engine 如需要进展相关性指标，基于 ProgressSnapshot + MetricSnapshot 推导，不重新扫描 Event。
4. **Signal 不可变** — 一旦 ProgressSnapshot 写入 Event 流（作为 progress.snapshot Event 类型），不得修改。重算产生新版本，旧版本保留。

### 违反示例

| 场景 | 违反 | 正确做法 |
|------|------|----------|
| Reflection 模块自己计算"模型回复是否在推进目标" | ✅ 违反 ADR-6 | Reflection 订阅 ProgressSnapshot，添加语义标签，不重新计算 Signal |
| Evolution 从 Event 中统计"连续 tool.completed 次数"以评估工具链效率 | ✅ 违反 ADR-6 | Evolution 通过 MetricsEngine.compute() 获取统计指标，ProgressSnapshot 提供进展信号 |
| Fitness Engine 定义自己的"progress_score"指标 | ✅ 违反 ADR-6 | Fitness 使用 ProgressSnapshot 中的字段加权组合，不自行定义 Signal 生产 |

### 理由

如果后续每个模块都重新计算一套 Progress，系统很快会出现多个互相矛盾的"进展"定义：
- Guardrail 认为"连续 5 轮无 tool.completed → 停滞"
- Fitness 认为"连续 5 轮无 agent.response → 低效"
- Evolution 认为"token 消耗 > 10k 且无 task.completed → 浪费"

三个定义无法对齐，演化体系失去一致性。

### 适用范围

本约束只适用于 **Progress** 的定义和语义。Metrics（流量、延迟、成本）仍由 MetricsEngine 统一生产，不在此约束范围内。

本 ADR 默认冻结。仅满足以下条件之一时允许重新评审：

- Observation 显示 Coverage Domain 已成为 Guardrail 有效性的主要限制
- Runtime Hook（当前模式）成为 ChatExecutor 性能瓶颈
- Adaptive Policy 需要历史重放能力且 Runtime Hook 模式无法满足
- 新 Runtime（如 Workflow Runtime、Evolution Runtime）无法复用现有 Guardrail

---

## 冻结的架构决策摘要

| ADR | 决策 | Phase |
|-----|------|-------|
| Responsibility | Agent Progress Guardrail（Current: Workflow, Target: Agent） | Phase 1: MVP 冻结 |
| Coverage Domain | Runtime-global（通过 Event Pipeline） | Phase 2 |
| Architecture Pattern | 从 Runtime Hook 迁移到 Event Pipeline Observer | Phase 2 |
| Architecture Invariants | 5 条不变原则 | 永久 |
| Non-goals | 7 项明确排除 | 永久 |
| Progress Signal is infrastructure | ProgressAnalyzer 是唯一生产者，消费者不定义 Signal | 永久 |
| Decision Revisit Criteria | 4 个条件触发重新评审 | 按需 |

---

## 参考文献

- Observation v1.2 Report: `scripts/analysis/observation-v1.2-report.ts`
- Progress Density Analysis: `scripts/analysis/progress-density.ts`
- Trace Forensics (req_173894_42): `scripts/forensics/trace-forensics.ts`
- Observation v1.1 Report: `docs/observation-report-v1.1.md`
- Analysis Assets Manifest: `docs/analysis-manifest.md`

---
## 附录 A：Phase 1 发现的问题

| 问题 | 根因 | 修复 | 影响 |
|------|------|------|------|
| Guardrail 跨 Trace 漏检 | `GuardrailPipeline.lastCheckedTurn` 跨 Trace 残留，新 Trace 首检被 throttle 跳过 | `ChatExecutor.toolLoop()` 入口加 `this.guardrailPipeline?.reset()` | 215+ 条 Tool Runtime Trace 未经检测。修复后需要新 Observation 重新验证 Coverage Domain |
