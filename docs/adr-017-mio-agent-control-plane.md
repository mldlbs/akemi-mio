# ADR-017: Mio Agent Control Plane

**Status:** Accepted — Strategic Direction (Target = Agent Control Plane; current implementation remains ADR-016 Phase 1)
**Date:** 2026-08-14
**Branch:** codex/mio-agent-enhancement-layer
**Related:** ADR-016 Agent Enhancement Layer, ADR-014 MCP Control Plane v1, ADR-015 Capability Model Contract, ADR-002 Guardrail Architecture, ADR-003 Unified Progress Observer

## Context

Hermes 类系统通常优化单个 Agent Instance，目标是让某一个 Agent 变得更聪明、记忆更强、规划更好、工具更多。如果 Mio 的定位仍停留在“Agent Intelligence / Enhancement Layer”，会与单 Agent 智能系统高度重叠，差异化不足。

Mio 已有资产更适合面向多 Agent 管理：

- MCP Control Plane
- Capability Model / Catalog
- Evaluation Pipeline
- Observer / Evidence Pipeline
- Evolution Framework
- Memory / EventBus

因此需要把产品抽象从“让某个 Agent 更强”提升为“管理多个 Agent 的生命周期与行为质量”。

## Decision

Mio Core 的演进目标为：

> Mio = Agent Control Plane / Agent Operations System。

当前实现仍处于 ADR-016 的 MCP Enhancement Layer 阶段；本 ADR 是战略冻结点，不等于该能力已经完成。

- Mio 的优化对象是 **Agent Ecosystem**，不是单个 Agent Instance。
- Mio 不替代 Codex / OpenCode / WorkBuddy / Claude Code，而是统一管理它们。
- MCP 继续作为跨宿主协议，宿主适配层保持薄封装。
- ADR-016 的 MCP-first 决策保留；本 ADR 仅替换其产品定位层。

## Architecture

```text
              User / Task
                  |
                  v
          Mio Agent Control Plane
                  |
 +----------------+----------------+
 |                                 |
 v                                 v
Routing / Scheduling          Policy / Governance
 |                                 |
 +----------------+----------------+
                  |
        Agent Execution Hosts
 +--------+--------+--------+--------+
 |        |        |        |        |
Codex   OpenCode WorkBuddy Claude Other
 |        |        |        |        |
 +--------+--------+--------+--------+
                  |
                  v
        Observation / Evaluation
                  |
 +----------------+----------------+
 |                                 |
 v                                 v
Memory / Identity              Evolution
```

控制平面由六个平面组成：

| Plane | Responsibility |
|-------|----------------|
| Identity / Registry | 登记 Agent、能力、默认路由 |
| Memory | 共享决策、ADR、历史问题 |
| Observation / Evaluation | Agent Trace、outcome、质量、回归检测 |
| Routing / Scheduling | 按任务类型选择最佳 Agent |
| Policy / Governance | 执行前检查、权限、风险 |
| Evolution | 跨 Agent 模式分析与优化建议 |

## MVP Tool Surface

现有工具保留，新增控制平面工具：

| Tool | Plane | Phase |
|------|-------|-------|
| `mio.memory.query` | Memory | Implemented (Phase 1) |
| `mio.memory.record` | Memory | Implemented (Phase 1) |
| `mio.memory.migrate` | Memory | Implemented (Phase 1) |
| `mio.observer.ingest` | Observation | Implemented (Phase 1) |
| `mio.policy.check` | Policy | Implemented (Phase 1) |
| `mio.agent.register` | Identity / Registry | Planned / Phase 2 |
| `mio.agent.list` | Identity / Registry | Planned / Phase 2 |
| `mio.agent.report` | Evaluation | Planned / Phase 2 |
| `mio.task.route` | Routing | Implemented (Phase 1 初始版)；完整 Agent 级路由仍为 Phase 2 |
| `mio.task.record_outcome` | Evaluation | Planned / Phase 2 |
| `mio.evolution.report` | Evolution | Planned / Phase 2 |

## Agent Identity / Unified Context

Mio 服务位于多个 Agent 外部，Codex / OpenCode / WorkBuddy 连接同一个 Mio MCP Server，而不是各自内置一份 Mio。

每个宿主通过 `MIO_CONTEXT` 提供统一身份：

```json
{
  "agentId": "codex",
  "project": "akemi-mio",
  "workspace": "D:/work/code/akemi-mio",
  "sessionId": "codex-session"
}
```

- `agentId` 默认注入 `memory.record.source` 和 `observer.ingest.agent`
- `project` 默认覆盖 Git 仓库自动识别结果
- `workspace` / `sessionId` 保留给后续溯源与审计

第一阶段不实现 `agent.register`，只保证多个 Agent 共用同一个 Mio 服务并保留来源身份。
## Planned Scope (Not Implemented)

以下控制平面扩展为规划项，当前尚未实现：

- `agents.jsonl` — Agent 身份、能力、默认任务类型
- `tasks.jsonl` — 路由决策与任务结果
- `memory.jsonl` — 保留记忆数据
- `traces.jsonl` — 保留 Agent Trace

第一个验证闭环：

```text
agent.register
    -> task.route
    -> execution
    -> task.record_outcome
    -> agent.report
```

## Phase 0: Cross-Agent Value Validation

**Goal:** 证明 Mio 能在不同 Agent 之间产生可复用价值，而不是只积累数据。

**最小闭环：**

```text
Agent A (Codex)
  task -> observer.ingest -> outcome -> memory.record

Agent B (OpenCode / WorkBuddy)
  similar task -> memory.query -> reuse -> execute
```

**成功标准：**

- ≥2 个宿主
- ≥20 个真实任务
- ≥5 次经验复用
- 可测量的结果改善：失败次数 / token 消耗 / 人工介入

**有效复用定义：**

一次有效复用必须同时满足：

1. `memory.query` 返回历史经验
2. Target Agent 行为发生变化
3. Task outcome 改善

“查到了但没用”不计入有效复用。

**证据结构：**

由 `mio.experience.reuse` 写入 `experience_reuse.jsonl`：

```json
{
  "sourceAgent": "codex",
  "targetAgent": "opencode",
  "experienceId": "xxx",
  "reuse": true,
  "behaviorChanged": true,
  "outcomeImproved": true,
  "project": "akemi-mio",
  "timestamp": "ISO8601"
}
```
**Phase 0 结果（2026-08-17）：通过 ✅**

| 成功标准 | 结果 |
|---|---|
| ≥2 个宿主 | 2/2（codex + opencode，均 active，host-health 验证） |
| ≥20 个真实任务 | 32/20（agentCoverage 主数据源 codex 27 / opencode 3，其余来自兜底/历史来源） |
| ≥5 次经验复用 | 5/5（全部 codex→opencode，经 `mio.experience.confirm` 确认） |
| 可测量结果改善 | 14/1（outcome improved 复用事件） |

确认口径：5 条 verified 均对照 Target Agent 实际输出核验（明确引用 source 记忆并据此改变方案），非自报；同 Agent（codex→codex）及弱关联 auto_claim 一律不确认，避免数据污染。

**结论：** 跨 Agent 经验复用价值成立，ADR-017 控制平面定位通过证伪阶段，决策门触发。

**决策门：已触发（2026-08-17，通过）**

- ✅ 通过（已发生）：验证完成，进入 `agent.register`、`task.route` 等控制平面扩展（下一阶段）。
- 未通过（未发生）：不扩展 API；Mio 暂时保持 Memory / Observer 工具定位，ADR-017 目标未被证明。

## 真实使用期评估检查表（2026-08-18 起）

Phase 0 通过后进入真实使用期：先积累真实数据、评估后再扩展。P0–P4 已实现并随 MCP 14 工具上线（OpenCode 已于 2026-08-18 重启接入）：

- P0（c074d2f）`memory.query/record` 支持 `scope`（project/global/all）+ 混合检索评分
- P1（0a5e410）`mio.task.route` 任务 → 已验证经验路由
- P2（67d5d77）证据加权排名：verified 记录的 reuseCount/confirmed 回灌检索排序
- P3（1aad937）`mio.memory.migrate` 跨项目迁移 + 分层记忆（project/global）
- P4（35ee2a9）`policy.check` 增加 `guidance`（none/advisory/actionable）与 saferAlternatives

**评估检查表（每个任务对照）：**

1. 工具列表应包含 `mio.task.route` / `mio.memory.migrate`（共 14 个）；缺失说明宿主仍连旧 server，需重启。
2. 任务开始时调 `mio.task.route`，确认是否命中已验证经验；记录命中是否改变执行方案。
3. 高风险操作前调 `mio.policy.check`，确认 `guidance` 是否给出 actionable 建议。
4. 跨项目问题用 `scope=all` 查询，确认全局经验能按语义召回。
5. 任务结束时核对新增 auto-claim：仅跨 Agent 且真实改变行为才 `experience.confirm`；同 Agent / 弱关联 / 自报一律不确认。

**评估期指标（对照 Phase 0 基线 2026-08-17：hosts 3/2、tasks 176/20、verified 6/5、improved 30/1）：**

- 路由采纳率：`task.route` 命中且被采纳的次数 / 调用次数
- 行为改变率：confirmed（behaviorChanged=true）数量变化
- 召回质量：`scope=all` 与混合检索是否减少无效探索
- 数据卫生：pending auto-claim 噪声占比是否随确认纪律下降

评估期结束后再决定是否实现 `agent.register` / `agent.list` / `agent.report`（ADR-017 已授权），或合并分支。

## Non-Goals

- 不构建完整的 Kubernetes 级 Agent 编排器。
- 不替代任何 Agent 宿主。
- 不做通用多 Agent 对话框架。
- 不在第一阶段实现自动接管执行；只提供路由、评估和治理建议。
- 不将 Mio Desktop 的终端产品功能提前合并。

## Success Metrics

- 路由建议采纳率。
- 同一任务类型在不同 Agent 上的 outcome 对比。
- 错误路由率是否下降。
- 重复探索成本是否随组织记忆积累下降。
- 高风险操作在 Policy 建议后是否减少失败。

## Next Steps

1. ✅ 执行 Phase 0 Cross-Agent Value Validation，按成功标准收集数据（已完成，2026-08-17）。
2. 验证通过后，再实现 `agent.register`、`agent.list`、`agent.report`。
3. 随后实现 `task.route` 与 `task.record_outcome`。
4. 观察期结束后决定是否进入 Evolution 自动建议阶段。