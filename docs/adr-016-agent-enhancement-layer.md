# ADR-016: Mio Core as Agent Enhancement Layer

**Status:** Accepted — Active
**Date:** 2026-08-14
**Branch:** codex/mio-agent-enhancement-layer
**Related:** ADR-014 MCP Control Plane v1, ADR-015 Capability Model Contract, ADR-002 Guardrail Architecture, ADR-003 Unified Progress Observer

## Context

Mio 已经拥有 Memory、Evaluation、Observer、Evolution、Policy 等智能基础设施，但当前缺乏真实、低摩擦的使用入口。继续把 Mio 作为独立桌面助手推进，要求用户改变日常 Agent 使用习惯，迁移成本高且难以快速积累真实行为数据。

同时，Codex / OpenCode / WorkBuddy 等 Agent 宿主已经进入用户日常工作流。MCP 是这些宿主当前最稳定的能力接入协议，也与 Mio 已有的 MCP Control Plane 方向一致。

## Decision

在当前阶段冻结以下战略方向：

- Mio Core 不做终端产品，先做 **Agent Enhancement Layer**。
- Mio 为现有 Agent 提供记忆、观察、评估、策略与进化能力，而不是替代 Agent。
- 采用 **MCP-first + 单一 Core**：宿主通过 MCP 接入，宿主适配层只负责注入上下文、接收事件和展示建议。
- 第一阶段只交付三个最小闭环：`memory.query`、`memory.record`、`observer.ingest`、`policy.check`。

## Architecture

```text
Codex / OpenCode / WorkBuddy / Other Agents
                  |
                  | MCP
                  v
      Mio Intelligence Core
      +-------------------------+
      | Memory                  |
      | Observer / Evaluation   |
      | Behavior / Policy       |
      | Evolution               |
      +-------------------------+
                  |
                  v
        Local-first data store
```

统一 MCP 工具面：

| Tool | Phase | Purpose |
|------|-------|---------|
| `mio.memory.query` | Phase 1 | 查询项目上下文、决策记录、历史问题 |
| `mio.memory.record` | Phase 1 | 记录决策、ADR 关联、代码库理解 |
| `mio.observer.ingest` | Phase 1 | 接收 Agent Trace、tool call、error、retry、outcome |
| `mio.policy.check` | Phase 1 | 在操作前返回历史风险与建议 |
| `mio.evolution.report` | Phase 2 | 周期性行为分析报告 |

## Phase 1 Scope

新增独立服务：`server/mio-intelligence-mcp`。

- 不依赖 Electron、不依赖渲染层。
- 使用 Node.js 内置能力 + 本地 JSON/SQLite 存储，可独立启动。
- 与现有 `server/mcp-server` 分开，避免污染现有写作向 MCP。
- 工具实现保持薄封装，核心逻辑后续从 `src/main/memory`、`src/main/observer`、`src/main/evolution` 提取。

Phase 1 验证目标：

- 在 Codex 中真实运行 30 天，积累 Agent 行为数据。
- 验证 Memory 召回是否真正降低重复探索成本。
- 验证 Policy 建议是否被 Agent 采纳。

## Non-Goals

- 不替代 Codex / OpenCode / WorkBuddy。
- 不在第一阶段构建四个深度宿主适配器。
- 不迁移或修改现有 `src/main/mcp`、`server/mcp-server`、Electron 主流程。
- 不将 Mio Desktop 的完整 Agent OS 功能塞入插件。
- 不默认采集或上传敏感项目数据；存储保持本地优先、显式授权。

## Consequences

**Positive**

- 有真实使用入口，且不要求用户改变宿主习惯。
- 复用 Mio 已有 Observation / Evolution 资产。
- 每个宿主只承担轻量适配职责，核心协议不重复建设。

**Risks**

- Codex / OpenCode / WorkBuddy 的 MCP 能力与事件钩子成熟度不同。
- 若只做工具暴露而不做上下文注入，Memory 仍无法形成闭环。
- 需要警惕再次退化为“又一堆 Dashboard”，而不是真实决策支持。

## Next Steps

1. 创建独立分支 `codex/mio-agent-enhancement-layer`。
2. 在 `server/mio-intelligence-mcp` 实现最小 MCP 服务与本地存储。
3. 注册到 Codex MCP 配置，跑真实任务并记录使用数据。
4. 30 天观察后，用召回命中率与策略采纳率决定是否恢复 Mio Desktop 研发优先级。
