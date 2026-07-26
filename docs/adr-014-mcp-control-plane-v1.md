# ADR-014: MCP Control Plane v1 — ProcessManager + Registry + Health

**Status:** Frozen — ✅ Gate: ADR Frozen. 6 项 Decision, 7 项 Contract, 7 项 I-1~I-7 验收标准。
**Date:** 2026-07-26
**Frozen at:** v1.0 — 2026-07-26, 审查后补充 C-6, C-7, ProcessManager 边界定义
**Supersedes:** None
**Superseded by:** None
**References:**
- [ADR Scope Review 014](docs/adr-scope-review-014.md) — O-1: MCP Control Plane Missing, O-2: 子进程管理重复, O-3: Evolution 无安全操作面
- [ServerManager.ts](src/main/mcp/ServerManager.ts) — 当前 MCP 管理实现
- [ClaudeCodeExecutor.ts](src/main/evolution/automation/ClaudeCodeExecutor.ts) — Evolution 子进程管理
- [CreativityExecutor.ts](src/main/evolution/automation/CreativityExecutor.ts) — 创造力子进程管理
- [McpModule.ts](src/main/core/kernel-modules/McpModule.ts) — 当前 MCP Kernel Module
- [AppRuntime.ts](src/main/bootstrap/AppRuntime.ts) — MCP 初始化入口
- [Process Gate Template](docs/process-gate-template.md) — 8-gate ADR lifecycle

---

## Context

### 现状

当前 Mio 的 MCP 集成模式：

```
Agent
    |
ServerManager (~1000 行内联)
    |
Tool List (Map<string, serverName>)
    |
callTool() → switch(serverName)
```

ServerManager 承担了所有职责：持久化、健康检查、熔断、重启、权限检查、能力注册。这些全部在一个类中内联实现，无法独立测试、无法复用。

同时，至少三个子系统实现了重复的子进程管理：

| 组件 | spawn | PID 追踪 | stdout/stderr | crash 恢复 |
|------|-------|---------|---------------|-----------|
| ServerManager + McpClient | ✅ | ❌ | ❌ | ✅ inline |
| ClaudeCodeExecutor | ✅ | ✅ | ✅ | ❌ |
| CreativityExecutor | ✅ | ✅ | ✅ | ❌ |

### 根因分析

| 问题 | 根因 |
|------|------|
| MCP 治理层缺失 | ServerManager 将所有职责内联，无分层抽象 |
| 子进程管理重复 | 无统一 ProcessManager，三个消费者各自实现 |
| Evolution 无法安全改变行为 | 唯一操作面是修改 Runtime 代码，无 Capability Registry 层 |
| 工具发现不可靠 | tool discovery 是 McpClient.initialize() 的副效应，无独立 retry |
| 无运行证据 | stdout/stderr 未统一捕获，无法事后追溯 crash 原因 |

---

## Decision

### 决策 1：引入 ProcessManager 作为横向基础设施

**不再允许 executors 直接管理子进程。** 所有托管进程的生命周期由 ProcessManager 统一管理。

```
Agent / Evolution / MCP
        |
ManagedProcess (抽象接口)
        |
ProcessManager
        |
ProcessRegistry
        |
OS Process
```

ProcessManager 统一提供：
- 进程启动/停止/重启
- PID 追踪
- stdout/stderr 流捕获 → LogStore
- crash 检测
- 退出码记录

**边界定义：**
- **ProcessManager = 通用进程生命周期能力**。不理解 MCP 协议、不理解工具、不理解能力语义。它只管理 OS 进程的 spawn/stop/restart 和 IO 流。
- **MCPControlPlane = MCP 协议层管理能力**。它使用 ProcessManager 启动进程，然后通过 MCP 协议（initialize/discoverTools/callTool）管理 MCP Server。
- ServerManager 拆解后：健康检查 → MCPControlPlane（MCP 特有，需要 ping/pong），熔断器 → ProcessManager（通用，基于退出码和 crash 频率），重启预算 → ProcessManager（通用策略）。

```
ProcessManager (通用基础设施)
    |— spawn/stop/restart
    |— PID 追踪
    |— stdout/stderr 捕获
    |— crash 检测
    |— 退出码分析
    |— RestartPolicy (通用)
    |— CircuitBreaker (通用)
    |
    +-- MCPControlPlane (MCP 协议层)
    |     |— MCP initialize/discoverTools
    |     |— MCP 健康检查 (ping/pong)
    |     |— 工具列表维护
    |     |— 工具调用路由
    |
    +-- ClaudeCodeExecutor (进化子进程)
    |
    +-- CreativityExecutor (创造性子进程)
```

**核心原则：ProcessManager 不导入任何 MCP 类型。** 它的依赖只有 Node.js `child_process` 和 LogStore。MCP 类型只出现在 MCPControlPlane 中。

### 决策 2：MCP Control Plane 独立于 Agent 生命周期

MCP 的启动/停止不绑定 Agent 的 start/shutdown。Control Plane 在 AppRuntime 层面初始化，Agent 只是消费者。

```
AppRuntime
    |
MCPControlPlane
    |
ProcessManager ←── MCP Server 进程
    |
Registry (持久化)
    |
Health System (独立心跳)
    |
Agent (工具列表消费者)
```

**Agent crash 不影响 MCP Server 运行。MCP Server crash 由 Health System 处理，不依赖 Agent 恢复。**

**所有权定义：**
- **谁负责启动 MCP：** Runtime Bootstrap（AppRuntime）。MCPControlPlane 在 AppRuntime 初始化阶段创建，独立于 Agent。
- **Agent 只能做什么：** `discover()` — 查询可用工具列表和 Capability 状态；`invoke()` — 调用已注册的工具。
- **Agent 不能做什么：** `start()` / `stop()` / `restart()` / `registry.modify()`。生命周期操作由 Control Plane 或 CLI 处理。

Agent 通过 MCPControlPlane 暴露的只读接口获取工具列表；

Agent 调用 `callTool()` 经过 MCPControlPlane 路由，但不控制 Server 生命周期。

### 决策 3：Registry + Manifest 标准化

每个 MCP Server 必须提供 Manifest 注册：

```typescript
interface MCPServerManifest {
  id: string
  name: string
  version: string

  runtime: {
    command: string
    args: string[]
  }

  capabilities: string[]           // 提供的能力列表
  dependencies?: {
    capability: string
    optional?: boolean
  }[]                              // 能力依赖图

  permissions: string[]            // 声明所需的权限
}
```

**存储路径：** `~/.mio/mcp/registry.json`（文件持久化，非内存唯一）

**需求：注册是声明式的。** 同一 manifest 重复注册幂等。

### 决策 4：强制重启预算

任何自动重启必须遵守 RestartPolicy。无预算的无限重启不被允许。

```typescript
interface RestartPolicy {
  maxRetries: number          // 窗口内最大重试次数
  windowMs: number            // 统计窗口（毫秒）
  cooldownMs: number          // 超过预算后的冷却时间
}
```

**默认值：** `{ maxRetries: 3, windowMs: 300000, cooldownMs: 60000 }`

**状态机：**

```
running → crash → recovering (重试中)
    ↑                    |
    |              retries > maxRetries
    |                    ↓
    +—————— failed ——————
                |
          Agent/User Decision
                ↓
           disabled
```

### 决策 5：Health System 多层状态

```
healthy
degraded      (部分工具不可用，但进程存活)
failed        (进程死亡或无限重试后)
disabled      (人工或 Agent 标记禁用)
```

### 决策 6：LogStore 作为独立子系统

所有托管进程的 stdout/stderr 统一写入 LogStore：

```typescript
interface LogEntry {
  processId: string
  timestamp: number
  stream: 'stdout' | 'stderr'
  message: string
}
```

**保留策略：** 每个进程滚动保留最近 1000 行（内存限制）。磁盘持久化 deferred。

**CLI 接口：** `mio mcp logs <id> [--tail N] [--stream stderr]`

---

## 契约

**7 项契约（C-1~C-7），全部必须通过 Verification Gate 才能关闭 ADR。C-6 和 C-7 是审查后补充的安全边界。**

### C-1：ProcessManager 是所有托管进程的唯一工厂

ProcessManager 负责 spawn，Executor/Agent 不直接调用 `child_process.spawn()`。

**违反检测：** 代码审查发现新增 `child_process.spawn` / `exec` / `fork` 调用 → C-1 违反。

### C-2：MCP Server 启动不阻塞 Agent 初始化

Agent 初始化时假设 MCP Server 可能尚未就绪。工具调用在 Server 未初始化时返回 `MCP_NOT_READY` 而非 crash。

### C-3：重启必须经过 RestartPolicy

任何自动重启必须调用 `RestartPolicy.check(id)`。绕过 RestartPolicy 的自动重启违反 C-3。

### C-4：Registry 是权威状态源

MCP Server 的运行状态从 Registry 恢复，而非从 in-memory 缓存。进程重启后从 Registry 重新初始化。

### C-5：Health 状态变化必须发出 Event

`mcp.server.healthy`、`mcp.server.degraded`、`mcp.server.failed`、`mcp.server.disabled` 必须作为 Evaluation Event 发出。

**消费者：** Evolution 系统可消费这些事件自动调整能力分配。

### C-6：所有托管进程必须经过 ProcessManager

业务 Executor 代码中禁止直接调用 `child_process.spawn()` / `exec()` / `fork()` / `execFile()`。

**违反检测：** 代码审查发现新增 `require('child_process').spawn` / `exec` / `fork` / `execFile` 调用 → C-6 违反。合法例外：ProcessManager 实现本身、非托管的一次性工具（如非托管 CLI 调用，需显式标注 `@bypass-process-manager`）。

### C-7：Agent 无生命周期管理权限

Agent 只能通过只读接口 discover 和 invoke。不能直接 start/stop/restart MCP Server 或修改 Registry。

Agent 看到的接口：

```typescript
interface AgentMCPView {
  discover(): MCPServerManifest[]     // 只读
  invoke(tool: string, args: any): any  // 调用
  // ⬆ 以上是 Agent 的全部权限
  // start/stop/restart 不在这个接口中
}
```

**违反检测：** Agent 代码调用 start()/stop()/restart() 或直接写 registry.json → C-7 违反。

---

## M1 阶段的 Capability Dependency 约束

Registry 中的 `dependencies` 字段在 M1 只做三件事：

1. **存储** — Manifest 中的 `dependencies` 原样写入 registry.json
2. **校验** — 注册时检查 `dependency.capability` 引用的能力是否存在（线性扫描，非 DAG 解析）
3. **查询** — `mio mcp info <id>` 展示依赖关系

**M1 不做：**
- DAG 拓扑排序
- 自动启动/停止依赖链
- 循环依赖检测
- 版本解析

这些属于 Capability Resolver（Phase 2），M1 仅保留依赖关系的数据，不赋予它调度意义。

---

## 影响

### 架构变化

```
当前：
    ServerManager (内联所有)
        |— 持久化
        |— 健康检查
        |— 熔断器
        |— 重启预算
        |— 能力注册
        |— 工具发现
        |— 工具调用路由

目标：
    ProcessManager (独立)
        |— 进程生命周期
        |— PID 追踪
        |— stdout/stderr 捕获
        |— crash 检测
    
    MCPControlPlane
        |— Registry (Manifest + 持久化)
        |— Lifecycle (start/stop/restart/status)
        |— Health (heartbeat + 状态机)
        |— Discovery (initialize + tool list refresh)
        |— LogStore (日志查询)
    
    Agent (纯消费者)
        |— getAllSchemas() → 只读
        |— callTool() → 路由
        |— 不再管理进程
```

### 对现有组件的改变

| 组件 | 变化 |
|------|------|
| ServerManager | 拆分为 ProcessManager + MCPControlPlane。现有健康检查/熔断/重启预算逻辑迁移而非重写 |
| McpClient | 聚焦 MCP 协议通信，移除进程管理职责 |
| ClaudeCodeExecutor | spawn → ProcessManager.create()。保留 Executor 逻辑，移除进程管理 |
| CreativityExecutor | 同上 |
| AppRuntime | MCPControlPlane 在此初始化，不绑定 Agent |
| McpModule | MCPControlPlane 在 Kernel Module 之上添加管理层 |
| Evolution | 通过 MCP Health Events 获得新输入面 |

### 未改变

- MCP 协议层（McpClient、transport）不修改
- 工具调用路由逻辑（callTool() 分发）保留在 MCPControlPlane
- CapabilityEngine 和 Constitution 的权限检查不变
- LocalProvider（内置工具）不受影响

### M1 验收

| ID | 标准 | 验证方式 |
|----|------|---------|
| I-1 | Registry 文件持久化 | 重启后 `mio mcp list` 恢复注册状态 |
| I-2 | Lifecycle start/stop/restart | `mio mcp start <id>` 实际启动进程，`stop` 发送 SIGTERM |
| I-3 | Health status 准确 | 手动 kill 进程后 `mio mcp status <id>` 变为 failed |
| I-4 | RestartPolicy 生效 | 连续快速 crash 5 次后状态锁定为 failed，不再自动重启 |
| I-5 | LogStore 可查询 | `mio mcp logs <id>` 返回最近 stdout/stderr |
| I-6 | ProcessManager 接管现有进程 | ClaudeCodeExecutor 和 CreativityExecutor 改为通过 ProcessManager spawn |
| I-7 | Tool discovery 可恢复 | MCP Server 重启后 tool list 自动刷新，无需 Agent 干预 |

### Contract 验证

| ID | 验证方式 |
|----|---------|
| C-1 | grep 搜索业务代码中的 `child_process.spawn\|exec\|fork` 检查新增调用 |
| C-2 | Agent 启动后立即调用工具，预期返回 `MCP_NOT_READY` 而非异常 |
| C-3 | 自动重启代码路径检查 RestartPolicy.check() 调用 |
| C-4 | 直接删除 registry.json 后重启，观察是否重新注册 |
| C-5 | 手动 kill 进程，观察 evaluation_events 表出现 `mcp.server.failed` |
| C-6 | grep 搜索所有 non-ProcessManager 文件中的 spawn/exec/fork |
| C-7 | Agent 代码审查确认只有 discover() 和 invoke() 调用 |

### CLI

```bash
mio mcp list
mio mcp start <id>
mio mcp stop <id>
mio mcp restart <id>
mio mcp status <id>
mio mcp logs <id> [--tail 50] [--stream stderr]
```

---

## 已知缺口

| 缺口 | 说明 | 计划 |
|------|------|------|
| Capability Resolver | Registry 中的 capabilities/dependencies 字段预留但不解析 | Phase 2 |
| 权限沙箱 | 第一版用 JSON allow/deny 清单，无进程级隔离 | Phase 2 |
| LogStore 磁盘持久化 | 内存滚动 1000 行，重启丢失 | Phase 2 |
| Evolution 集成 | Health Event 已定义，但 Evolution 消费逻辑 defer | Phase 3 |
| 指标监控 | 无 CPU/内存采集 | Deferred |
