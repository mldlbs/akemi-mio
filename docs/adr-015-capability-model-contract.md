# ADR-015: Capability Model Contract — Semantic Capability Layer

**Status:** ✅ Accepted — Frozen
**Date:** 2026-07-26
**Frozen at:** v2.0 — 2026-07-26, M5.1 + M5.2 (CapabilityBinding + Service + Invocation)
**P1.3a:** 2026-07-26, CapabilityFunctionSchemaAdapter + ToolSchemaProvider + ToolInvocationRouter
**Phases:**
- **M5.1 Semantic Discovery** — ✅ Frozen (2026-07-26)
- **M5.2 Capability Invocation** — ✅ Frozen (2026-07-26)
- **P1.3a Function Schema Adapter** — ✅ Frozen (2026-07-26)
- **M5.3 Multi-provider / optimization** — ⏸ Deferred
- **P1.3b Full Schema Switch** — ⏸ Deferred

| Phase | Scope | Status |
|-------|-------|--------|
| M5.1 | CapabilityDefinition, Catalog (derived from Registry), Resolver (single provider) | ✅ Frozen |
| M5.2 | CapabilityBinding, CapabilityService (resolve + invoke), Permission position freeze | ✅ Frozen |
| P1.3a | CapabilityFunctionSchemaAdapter, ToolSchemaProvider, ToolInvocationRouter, capability.selected event, dual-track mode | ✅ Frozen — Implementation ✅, Runtime ✅, Behavioral Adoption ❌ |
| M5.3 | Multi-provider ranking / fallback / optimization | ⏸ Deferred |
| P1.3b | Full Schema Switch: remove PROMPT_TOOLS, remove original tool schemas | ⏸ Deferred |
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

### 决策 5（M5.2）：CapabilityService 作为 Agent 隔离层

Agent 不直接接触 MCP server id 或 tool name。所有能力调用通过 `CapabilityService`：

```typescript
interface ICapabilityService {
  resolve(capability: string, toolHint?: string): Promise<CapabilityBinding | undefined>
  invoke(binding: CapabilityBinding, input: unknown): Promise<unknown>
  listCapabilities(): string[]
}
```

**调用链：**

```
Agent
  |
CapabilityService.resolve("publishing")
  | → CapabilityBinding { capability, provider: { type: "mcp", id: "fanqie" }, tool: "publish" }
  |
CapabilityService.invoke(binding, input)
  | → ServerManager.callTool(tool, input)  ← 此路径含 Permission
  | → MCP Server
```

**Agent 永远不知道：**
- MCP server id
- tool name
- transport protocol

### 决策 6（M5.2）：Permission 检查在 invoke 路径，不在 resolve 路径

```
resolve:  → Resolver  → Catalog       ← 无 Permission
invoke:   → callTool  → CapabilityEngine  ← 有 Permission
```

Resolver 是发现阶段，执行前才需授权。Permission 检查仍在 `ServerManager.callTool()` 路径。`CapabilityService.invoke()` 不添加额外 Permission 检查。

### 决策 7（P1.3a）：ToolSchemaProvider — LLM-facing schema 统一层

不将 Capability schema 直接挂载到 ServerManager。新增 `ToolSchemaProvider` 作为 LLM-facing schema 的唯一入口：

```
LlmService
   |
   v
ToolSchemaProvider
   |
   + Local Tool Schema（from getAllTools）
   + MCP Tool Schema（from ServerManager.getAllSchemas）
   + Capability Function Schema（from CapabilityFunctionSchemaAdapter）
```

ServerManager 继续只提供：
```typescript
getToolSchemas()  // MCP tool schemas only, no capability
callTool()        // MCP tool routing only, no capability dispatch
```

**决策依据：** ServerManager 是 MCP/tool runtime facade，职责应限定在 tool discovery + MCP routing。合并 Capability 会导致职责混合。新增 `ToolSchemaProvider` 作为 schema 合并层，不改变现有组件边界。

### 决策 8（P1.3a）：CapabilityDefinition 增加 inputSchema

Capability function schema 的 parameters 不允许为空 `{}`。Function calling 中空 parameters 等价于"无约束"，会导致：
- LLM 参数质量下降
- invoke 输入不可预测
- 后续 evaluation 无法分析参数结构

CapabilityDefinition 增加 `inputSchema` 字段：

```typescript
interface CapabilityDefinition {
  id: string
  description: string
  inputSchema: JSONSchema  // P1.3a: 非空，用于 function calling parameters
  providers: CapabilityProvider[]
}
```

`CapabilityFunctionSchemaAdapter` 从 `inputSchema` 生成 function.parameters：

```
CapabilityCatalog
    |
    v
CapabilityFunctionSchemaAdapter
    |
    v
function: { name, description, parameters: cap.inputSchema }
```

Catalog 构建时，从 Manifest 的 tool definitions 推断 inputSchema（M1 阶段所有 provider 共享第一个 provider 的 tool schema）。

### 决策 9（P1.3a）：ToolInvocationRouter — 调用分发层

LLM 返回的 tool_call 不直接进 ServerManager。新增 `ToolInvocationRouter` 负责分发：

```
LLM tool_call
    |
    v
ToolInvocationRouter
    |
    + capability name → CapabilityService.invoke()
    |
    + normal tool → ServerManager.callTool()
```

判断依据：tool_call 的 function name 是否匹配某个 capability id。

**决策依据：** 不允许 ServerManager 感知 Capability 概念。分发逻辑由 Router 独立承载，ServerManager 和 CapabilityService 彼此无直接引用。

### 决策 10（P1.3a）：双轨模式 — 保留原始 tools

P1.3a 是影子阶段的延伸，不移除原始 tool schema。LLM 同时看到两类函数：

| Schema 来源 | 函数名 | 路由目标 | 生命周期 |
|---|---|---|---|
| 原始工具 | `read_file`、`write_file` 等 | `ServerManager.callTool()` | P1.3a 保留 |
| Capability 函数 | `publishing`、`content.drafting` 等 | `CapabilityService.invoke()` | P1.3a 新增 |

**P1.3a 不做的：**
- 删除 PROMPT_TOOLS 文本
- 删除原始 tool schema
- Capability ranking / fallback
- Agent 无 tool name 硬编码（C-6 目标保持推迟）

### 决策 11（P1.3a）：capability.selected 事件

LLM 主动选择 capability 函数时发射 `capability.selected` 事件。事件名静态化，不包含 capability id 变量。

事件生命周期：

```
capability.suggested    ← P1.1: shadow 暴露
    |
    v
capability.selected     ← P1.3a: LLM 主动选择了 capability 函数
    |
    v
capability.invoked      ← P0: 开始执行
    |
    v
capability.completed    ← P0: 执行完成
```

Payload 设计：

```typescript
interface CapabilitySelectedPayload {
  capability: string        // "publishing"
  source: 'llm_function_call'
  toolCallId: string        // LLM 返回的 tool_call ID
  input?: unknown           // LLM 传入的参数
  matchedTool?: string      // 如果 LLM 同时通过原始 tool 名调用，记录对应关系
}
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

### C-5（M5.2）：CapabilityService.invoke() 不添加额外 Permission

Permission 检查仅在 `ServerManager.callTool()` 路径执行。`CapabilityService` 不重复检查。

**违反检测：** `CapabilityServiceImpl.ts` 中出现 `CapabilityEngine` import → C-5 违反。

### C-6（M5.2）：Agent 无 tool name 硬编码

Agent 业务代码通过 `Service.resolve()` + `Service.invoke()` 调用能力，不直接构造 `CapabilityBinding` 或调用 `ServerManager.callTool()`。

**违反检测：** Agent 代码中出现 `serverManager.callTool("specific_tool_name", ...)` → C-6 违反（但有合理例外：`file.read`/`write` 等内置工具）。

### C-7（P1.3a）：ToolSchemaProvider 是 LLM-facing schema 的唯一入口

`LlmService` 获取 tools 时通过 `ToolSchemaProvider.getSchemas()`，不再直接调用 `ServerManager.getAllSchemas()`。ServerManager 不含 Capability schema。

**违反检测：** LlmService 中出现 `mcpManager.getAllSchemas()` 或 `ServerManager.getAllSchemas()` → C-7 违反。

### C-8（P1.3a）：Capability function schema 的 parameters 不为空

`CapabilityDefinition.inputSchema` 必须包含非空的 properties 和 required。`CapabilityFunctionSchemaAdapter` 拒绝生成空 parameters 的 schema。

**违反检测：** 生成的 capability function schema 中 `function.parameters.properties` 为 `{}` → C-8 违反。

### C-9（P1.3a）：ServerManager 不感知 Capability

ServerManager.callTool() 不检测 capability 函数名，不路由到 CapabilityService。分发由 ToolInvocationRouter 独立完成。

**违反检测：** `ServerManager.ts` 中出现 `CapabilityService` import → C-9 违反。

### C-10（P1.3a）：P1.3a 不删除原始 tool 路径

原始 tool schema 在 P1.3a 阶段始终存在于提示中。Capability 函数 schema 是追加，不是替换。

**违反检测：** `getAllTools()` 返回数量少于 P1.3a 之前 → C-10 违反（合理例外：新工具加入）。

### C-11（P1.3a）：capability.selected 在 capability.invoked 之前发射

对于 LLM 通过 capability 函数发起的调用，事件顺序必须为 `selected → invoked → completed`。selected 关联 tool_call_id 在 invoked 之前。

**违反检测：** 同一次 trace 中 `capability.invoked` 出现在 `capability.selected` 之前 → C-11 违反。

---

## 影响

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/main/capability/types.ts` | 追加 CapabilityDefinition, CapabilityProvider, ResolveResult, CapabilityBinding, ICapabilityService |
| `src/main/capability/CapabilityCatalog.ts` | 从 MCPRegistry 重建索引, getCapabilities(), getProviders() |
| `src/main/capability/CapabilityResolver.ts` | resolve(capabilityId) → ResolveResult |
| `src/main/capability/CapabilityServiceImpl.ts` | resolve() + invoke(), Agent 隔离层 |

### P1.3a 新增

| 文件 | 职责 |
|------|------|
| `src/main/capability/CapabilityFunctionSchemaAdapter.ts` | CapabilityDefinition → OpenAI function schema 转换，过滤空 parameters |
| `src/main/tool/ToolSchemaProvider.ts` | LLM-facing schema 统一入口，合并 tool + capability schema |
| `src/main/tool/ToolInvocationRouter.ts` | LLM tool_call 分发：capability → CapabilityService，normal → ServerManager |

### 修改文件

| 文件 | 变化 |
|------|------|
| `src/main/capability/index.ts` | 导出新类型和类 |
| `src/main/capability/types.ts` | CapabilityDefinition 增加 inputSchema 字段；新增 CapabilitySelectedPayload |
| `src/main/core/evaluation/types.ts` | EventType 追加 capability.selected |
| `src/main/core/EventBus.ts` | 注册 capability.selected 事件名 |
| `src/main/core/evaluation/ToolEventBridge.ts` | 新增 onCapabilitySelected handler |
| `src/main/capability/index.ts` | 导出 CapabilityFunctionSchemaAdapter |
| `src/main/tool/index.ts` | 导出 ToolSchemaProvider，ToolInvocationRouter |
| `src/main/llm/LlmService.ts` | 改用 ToolSchemaProvider 获取 schemas |
| `src/main/bootstrap/AppRuntime.ts` | 创建并注入 ToolSchemaProvider、ToolInvocationRouter、CapabilityFunctionSchemaAdapter |

### 未改变

- CapabilityEngine（permission layer）不变
- ServerManager 不变（CapabilityService 作为消费者）
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
| I-7 | CapabilityService 不引用 CapabilityEngine | grep "CapabilityEngine" CapabilityServiceImpl.ts → 无匹配 |
| I-8 | CapabilityService.invoke 委托 ServerManager.callTool | code review |
| I-9 (P1.3a) | Capability function schema 出现在 LLM tools 中 | ToolSchemaProvider.getSchemas() 包含 capability 函数 |
| I-10 (P1.3a) | Capability function schema 的 parameters 非空 | properties 不为 {}，required 不为 [] |
| I-11 (P1.3a) | LLM 选择 capability 函数 → 路由到 CapabilityService | capability.selected 事件 + invoked 在同 trace |
| I-12 (P1.3a) | LLM 选择原始工具 → 路由到 ServerManager（无回归） | 原始 tool.invoked 事件持续产生 |
| I-13 (P1.3a) | ServerManager 不包含 CapabilityService import | grep "CapabilityService" ServerManager.ts → 无匹配 |
| I-14 (P1.3a) | eventBus 正常发射 capability.selected | 事件可被 EvaluationRepository 持久化 |

---

## 已知缺口

| 缺口 | 说明 | 计划 |
|------|------|------|
| 多 Provider 选择 | 只有一个 provider 时总是选中 | M5.3 |
| Agent 通过 capability 调用 | 当前 Agent 仍用 tool name | P1.3b |
| 权限集成 | Permission check 在 tool call 层级独立 | 与语义层正交 |
| Capability 健康感知 | Resolver 不考虑 provider 健康状态 | M5.3 |
| CapabilityRegistry（能力持久化）| Catalog 派生自 MCPRegistry，无独立能力存储 | 与 Registry 耦合，暂无计划独立 |
| P1.3b Full Switch | 删除原始 tool schema + PROMPT_TOOLS | P1.3a 数据充分后启动 |
| Capability inputSchema 自动推断 | M1 阶段从 provider tool schema 推断，非独立定义 | 需 Manifest 增强 |

---

## P1.3a Observation

### 实验结论

**问题：** Capability Function Schema 作为附加工具注入是否足以让 LLM 主动选择 capability？

**方法：** 将 4 个 capability function schema 合并到 173 个原始 tool schema 中，通过 ToolSchemaProvider 统一提供给 LLM。

**结果：** LLM 仍选择原始工具，capability.selected 事件为 0。

**原因分析：**

```
假设:
  old tools + capability tools → LLM 逐渐偏好 capability

实际:
  173 raw tools + 4 capability tools → 仍选择 raw tools
```

Capability schema 在数量上被淹没，LLM 的 tool selection 倾向于具体、已知的工具名。抽象 capability 函数在大量细粒度工具中不可见。

**根本发现：** 增量式 schema 注入不足以改变 LLM 工具选择行为。形式化切换需要 capability-first 架构，即 LLM 只看到 capability 函数，背后由 CapabilityService → Provider → Tool 分解。

### 对 P1.3b 的要求

从当前模式：

```
Agent → [old tools + capability tools] → LLM selects raw tool → ServerManager.callTool()
```

变为：

```
Agent → [capability tools only] → LLM selects capability → CapabilityService.resolve()
    ↓
Provider.select()
    ↓
ServerManager.callTool()
```

### 已关闭的路径

| 路径 | 结论 | 原因 |
|------|------|------|
| 增加 capability 描述 | ❌ 无效 | 信噪比问题，不是描述质量问题 |
| 收集 suggested/selected 数据 | ❌ 不必要 | selected=0 已经回答问题 |
| 调整 ranking | ❌ 超出 P1.3a 范围 | 属于 M5.3 多 Provider 选择 |
| 调整 prompt | ❌ 无效 | 架构问题不能用 prompt 解决 |

### P1.3a 最终状态

| 维度 | 状态 | 说明 |
|------|------|------|
| Implementation | ✅ | Schema Adapter + Sanitization + Router + Synthetic Test 17/17 |
| Runtime Compatibility | ✅ | API tools 兼容，capability schema 注入 |
| Behavioral Adoption | ❌ | capability.selected = 0, raw tool selection 不变 |
| Finding Generated | ✅ | 本 Observation 已记录 |
