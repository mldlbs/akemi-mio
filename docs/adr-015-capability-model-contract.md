# ADR-015: Capability Model Contract — Semantic Capability Layer

**Status:** Draft — Gate: ADR Frozen
**Date:** 2026-07-26
**Supersedes:** None
**Superseded by:** None
**References:**
- ADR-014 — MCP Control Plane v1 (ProcessManager + MCPControlPlane + Registry)
- [MCPRegistry.ts](src/main/mcp/MCPRegistry.ts) — M4 MCP Registry with manifest.dependencies/capabilities
- [ServerManager.ts](src/main/mcp/ServerManager.ts) — 当前工具路由（callTool 按 tool name 分发）
- [CapabilityEngine.ts](src/main/capability/CapabilityEngine.ts) — 现有权限层（action sandbox，与语义 Capability 正交）

---

## Context

### 当前架构

MCP Control Plane v1（ADR-014）完成后：

```
Agent
    |
ServerManager.callTool("fanqie_publish_novel", args)
    |
MCPControlPlane.getClient("fanqie").callTool(...)
```

Agent 调用工具仍按 **工具名**。这意味着：
- Agent 需要知道 MCP Server 提供的 exact tool name
- 没有抽象层隔离 MCP Server 变更
- 没有能力发现机制（Agent 无法回答"你可以做什么？"）
- Registry 中的 capabilities 字段存储但不消费

### 现有权限层

`CapabilityEngine` 管理的是 **permission**（`file.write` / `shell.execute` / `mcp.call`），控制"谁可以执行什么操作"。它不回答"什么场景需要哪些能力"。

**两个层次必须在 ADR-015 中明确分离：**

| 层次 | 职责 | 所属 |
|------|------|------|
| Permission Layer | `caller → action allowed?` | CapabilityEngine (existing) |
| Semantic Layer | `task → provider → tool` | ADR-015 (new) |

### 根因

当前 Agent 的认知模型：

```
看到 list 中的工具名
  ↓
选择 fanqie_publish_novel
  ↓
callTool("fanqie_publish_novel", args)
```

目标认知模型：

```
需要"发步小说"
  ↓
resolve("publishing")
  ↓
得到 { provider: "fanqie", tool: "publish" }
  ↓
callTool("publish", args)
```

---

## Decision

### 决策 1：Capability Model 与 Permission Layer 分离

```typescript
// 语义 Capability — 描述"系统能做什么"
interface CapabilityDefinition {
  id: string                    // "publishing"
  description: string           // "发布内容到外部平台"
  providers: CapabilityProvider[]
}

interface CapabilityProvider {
  mcpServerId: string           // MCP Registry 中的 server id
  tools: string[]               // 该服务器提供的工具名列表
  defaultTool?: string          // 默认工具（仅有一个 provider 时使用）
}

// Permission — 描述"谁可以做什么"（已存在，不修改）
// CapabilityEngine.checkCallAllowed(action, resource, caller)
```

**决策依据：** 语义 Capability 解决"做什么"，Permission 解决"让不让做"。耦合会导致 Agent 无法理解能力边界。

### 决策 2：Provider 注册来自 MCP Registry

当 MCP Server 注册时，其 manifest 中的 capabilities 字段自动注册为 Provider：

```typescript
// MCP Registry 中某 server 的 manifest:
{
  id: "fanqie",
  capabilities: ["publishing", "content.drafting"]
}

// CapabilityCatalog 自动更新:
{
  "publishing": {
    providers: [{ mcpServerId: "fanqie", tools: ["publish"], defaultTool: "publish" }]
  }
}
```

**不**在 Registry 之外单独配置 Capability 映射。

### 决策 3：M1 只做单 Provider 解析

```typescript
interface ResolveResult {
  capabilityId: string
  provider: {
    mcpServerId: string
    tool: string
  }
  confidence: 1.0  // M1 只有 1.0，多 provider 选择属于 M2
}
```

**不做的：**
- 多 Provider 自动选择/路由
- Provider 健康度加权
- Provider fallback 链
- Agent 自主选择 Provider

### 决策 4：CapabilityCatalog 是 Registry 消费者，不管理持久化

`CapabilityCatalog` 在内存中构建索引，Registry 变化时重建。持久化由 Registry 负责。

```
MCPRegistry (持久化)
    |
    ↓ rebuild on change
CapabilityCatalog (内存索引)
    |
    ↓ query
CapabilityResolver
    |
    ↓ resolve(agent task)
```

---

## 契约

### C-1：语义 Capability 与 Permission 不互通

`CapabilityResolver.resolve()` 不调用 `CapabilityEngine.checkCallAllowed()`。Permission 检查仍在 `ServerManager.callTool()` 路径执行。

**违反检测：** CapabilityResolver 中出现 `CapabilityEngine` import → C-1 违反。

### C-2：CapabilityCatalog 不持久化

Catalog 只持有内存索引。持久化在 Registry。重启后从 Registry 重建。

### C-3：Resolver 总是返回确定的 provider

M1 中，对于每个 capability，如果只有一个 provider，返回它。如果有多个，挑第一个注册的。不引入选择逻辑。

### C-4：Manifest capabilities 字段是权威来源

Catalog 只从 Registry 的 manifest.capabilities 构建。不接受外部直接注册。

---

## 影响

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/main/capability/types.ts` | 追加 CapabilityDefinition, CapabilityProvider, ResolveResult |
| `src/main/capability/CapabilityCatalog.ts` | 从 MCPRegistry 重建索引, getCapabilities(), getProviders() |
| `src/main/capability/CapabilityResolver.ts` | resolve(capabilityId) → ResolveResult |

### 修改文件

| 文件 | 变化 |
|------|------|
| `src/main/capability/index.ts` | 导出新类型和类 |
| `src/main/mcp/ServerManager.ts` | 可选：暴露 resolveCapability() 使 Agent 可通过 capability 调用 |

### 未改变

- CapabilityEngine（permission layer）不变
- MCPControlPlane 不变
- ProcessManager 不变
- MCPRegistry 不变（Consumer 模式）

---

## 验收标准

| ID | 标准 | 验证方式 |
|----|------|---------|
| I-1 | Registry 注册 fanqie → Catalog 中出现 publishing | getCapabilities() 返回 |

| I-2 | resolve("publishing") 返回正确 provider | 结果包含 fanqie + publish |
| I-3 | Registry unregister → Catalog 自动移除 | resolve 返回 undefined |
| I-4 | 多 capability server 注册 | 各自 capability 独立解析 |
| I-5 | 现有 CapabilityEngine 测试全部通过 | vitest run capability |
| I-6 | ServerManager 5/5 不变 | vitest run tools.test |

---

## 已知缺口

| 缺口 | 说明 | 计划 |
|------|------|------|
| 多 Provider 选择 | 只有一个 provider 时总是选中 | M2 |
| Agent 通过 capability 调用 | 当前 Agent 仍用 tool name | M3 |
| 权限集成 | Permission check 在 tool call 层级独立 | 与语义层正交 |
| Capability 健康感知 | Resolver 不考虑 provider 健康状态 | Capability Layer M2 |
