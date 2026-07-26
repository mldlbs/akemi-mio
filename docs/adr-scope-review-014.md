# ADR Scope Review 014 — MCP Control Plane v1

> **Phase:** Pre-ADR 判定
> **Date:** 2026-07-26
> **References:**
> - [ADR-013](docs/adr-013-session-memory-architecture.md) — 最近的 ADR，Event-Driven Memory Layer
> - [ServerManager.ts](src/main/mcp/ServerManager.ts) — 当前 MCP 管理实现（~1000 行，内联所有逻辑）
> - [ClaudeCodeExecutor.ts](src/main/evolution/automation/ClaudeCodeExecutor.ts) — 独立的子进程 spawn 实现
> - [CreativityExecutor.ts](src/main/evolution/automation/CreativityExecutor.ts) — 另一份独立的子进程 spawn 实现
> - [McpModule.ts](src/main/core/kernel-modules/McpModule.ts) — 当前 MCP 在 Runtime Kernel 中的接入点
> - [AppRuntime.ts](src/main/bootstrap/AppRuntime.ts) — MCP 初始化入口

---

## Observation

### 问题 1：MCP 治理层缺失

当前 MCP 集成停留在"应用级集成"：

```
Agent
    |
MCPManager
    |
Tool List
    |
Call
```

缺少 Registry、Lifecycle、Health、Discovery 的抽象。ServerManager（~1000 行）将所有职责内联在一个类中：

- 持久化初始化（initServers/persistServers）— 内联
- 健康检查（startHealthCheck/scheduleHealthCheck）— 内联递归 setTimeout
- 重启退避（restartServerWithBackoff）— 内联指数退避
- 熔断器（circuitBreakers）— 内联 Map
- 重启预算（restartBudgets）— 内联 Map
- 能力注册（registerCapabilities）— 内联
- 工具发现（discoverTools）— 依赖 McpClient.initialize()

这些机制是合理的，但全部耦合在一个类中，无法独立测试、无法水平扩展、无法被其他子系统复用。

### 问题 2：子进程管理重复实现

至少三个独立实现：

| 组件 | 功能 | 生命周期管理 | PID 追踪 | stdout/stderr 捕获 |
|------|------|-------------|---------|------------------|
| ServerManager + McpClient | MCP Server 进程 | ✅ inline | ❌ | ❌ |
| ClaudeCodeExecutor | Claude Code 子进程 | ✅ inline | ✅ | ✅ |
| CreativityExecutor | 创造性子进程 | ✅ inline | ✅ | ✅ |

三个实现各自处理：spawn、crash detection、resource cleanup。没有统一抽象。

### 问题 3：Evolution 无法安全改变系统行为

当前 Evolution 可以产生优化建议，但无法安全地变更系统行为——因为它只能修改 Runtime 代码（高风险），没有更安全的操作面。

---

## Scope Review

### 进入 ADR 的范围

| 项目 | 判定 |
|------|------|
| MCP Registry（Manifest + 持久化） | **Enter ADR** — 基础设施，独立于任何 MCP Server |
| Lifecycle Manager（start/stop/restart/status） | **Enter ADR** — 必须独立于 Agent 生命周期 |
| ProcessManager（统一子进程管理） | **Enter ADR** — 横向基础设施，三个重复实现 |
| Health System（heartbeat + crash detection + restart budget） | **Enter ADR** — 长期自治的前提 |
| Tool Discovery 标准化（MCP initialize → tool list refresh） | **Enter ADR** — 需要契约而非内联 |
| LogStore（stdout/stderr 统一捕获与查询） | **Enter ADR** — "没有运行证据 = 无法自治" |
| Capability Layer（Capability Graph + Resolver） | **Deferred to Phase 2** — 依赖 M1 稳定后演化 |
| Permission Sandbox（进程级沙箱隔离） | **Deferred** — M0 只需要静态 allow/deny |
| Evolution 整合（Capability Proposal → Registry Change） | **Deferred** — 依赖 M1 和 Evolution 双方稳定 |

### 范围边界

**本 ADR 只做一件事：**
> 将 MCP 从"Agent 的工具列表"升级为"Agent Runtime 的能力基础设施"。

**本 ADR 不做：**
- 实现新的 MCP Server（fanqie、github 等）
- 设计 Capability Resolver / Capability Graph
- 实现权限沙箱（第一版只需要 JSON 配置 allow/deny）
- 修改 Evolution 系统的行为路径

---

## 进入 ADR 的决定

基于上述分析，O-1（MCP Control Plane Missing）是根因，O-2（子进程管理重复）和 O-3（Evolution 无安全操作面）是其派生问题。

**判定：O-1 进入 ADR-014，O-2 和 O-3 作为 ADR 内的设计约束处理，不单独成 ADR。**

*O-2 的解决方式是作为 ProcessManager 的第二个消费者，O-3 的解决方式是作为 Capability Registry 的未来消费者。两者都在 ADR-014 的架构中预留接口而非完整实现。*
