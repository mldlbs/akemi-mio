# M2 Architecture Verification — ServerManager Decompose

**Date:** 2026-07-26
**ADR:** ADR-014 MCP Control Plane v1
**Status:** ✅ Verified — Ready for commit

---

## 1. Dependency Direction

```
ServerManager
    |
    v
MCPControlPlaneImpl
    |
    v
McpClient
    |
    v
StdioTransport / HttpTransport
```

**检查结果：** ✅ 无循环依赖。MCPControlPlaneImpl 不引用 ServerManager。

## 2. 职责边界

### ServerManager 不包含（已移除）

| 职责 | 迁移目标 | 状态 |
|------|---------|------|
| MCP initialize 协议握手 | → MCPControlPlaneImpl.initialize() | ✅ |
| MCP ping/pong 健康检查 | → MCPControlPlaneImpl (scheduleHealthCheck) | ✅ |
| tool discovery (discoverTools) | → MCPControlPlaneImpl.indexServerTools() | ✅ |
| 熔断器 (circuitBreakers) | → MCPControlPlaneImpl | ✅ |
| 重启退避 (retryStates, restartServer*) | → 删除（由 ProcessManager 接管） | ✅ |
| 重启预算 (restartBudgets) | → 删除（由 ProcessManager 接管） | ✅ |
| Capability Registry (tool drift) | → MCPControlPlaneImpl | ✅ |

### MCPControlPlaneImpl 包含的 Capability Registry

```typescript
serverId → {
  expectedTools: string[]
  actualTools: string[]
  healthScore: number
}
```

**判定：** 这是 MCP 工具漂移检测（reliability monitoring），不是 Capability Layer 的 `capability → provider` 解析。**在 M2 范围内，未提前实现 Phase 2。**

### MCPControlPlaneImpl 不包含

| 职责 | 所有权 | 状态 |
|------|--------|------|
| Permit policy (Constitution/CapabilityEngine) | ServerManager | ✅ |
| 工具路由 (callTool dispatch) | ServerManager | ✅ |
| 优先级排序 (MemoryAwareInterceptor) | ServerManager | ✅ |
| 持久化 (persistServers) | ServerManager | ✅ |
| 行为预激活 (BehaviorPredictor) | ServerManager | ✅ |
| child_process / spawn | ProcessManager | ✅ |
| PID / restart budget | ProcessManager | ✅ |

## 3. 删除代码量

| 文件 | 变更 |
|------|------|
| `src/main/mcp/MCPControlPlane.ts` (新) | +34 lines (interface) |
| `src/main/mcp/MCPControlPlaneImpl.ts` (新) | +307 lines (实现) |
| `src/main/mcp/ServerManager.ts` (重构) | -250 lines (移除进程管理/健康检查/重启预算) |
| `src/main/mcp/transport.ts` | -4 lines (移除 spawn fallback) |

## 4. 测试结果

| 测试套件 | 结果 |
|---------|------|
| ProcessManager 7/7 | ✅ |
| ServerManager 5/5 | ✅ |
| tsc 零错误 (修改范围内) | ✅ |
| C-6: spawn 仅在 ProcessManager | ✅ |
| 依赖方向 | ✅ 无循环 |

## 5. 已知缺口

| 缺口 | 说明 | 计划 |
|------|------|------|
| M2 原 M3 (Executor Migration) | ClaudeCodeExecutor/CreativityExecutor 不直接 spawn，无需变更 | N/A — No migration required |
| MCP Registry | 持久化还在 ServerManager initServers/persistServers，未独立 | M4 |
| Capability Layer | MCPControlPlaneImpl 的 Capability Registry 仅检测 tool drift | Phase 2 |
