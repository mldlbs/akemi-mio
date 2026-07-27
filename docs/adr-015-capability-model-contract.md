# ADR-015: Capability Model Contract — Semantic Capability Layer

**Status:** ✅ Accepted — Frozen
**Date:** 2026-07-26
**Frozen at:** v2.0 — 2026-07-26, M5.1 + M5.2 (CapabilityBinding + Service + Invocation)
**P1.3a:** 2026-07-26, CapabilityFunctionSchemaAdapter + ToolSchemaProvider + ToolInvocationRouter
**P1.3b Phase A:** 2026-07-27, Capability-first mode + ProviderAdapter + call_raw_tool fallback (Synthetic Runtime ✅, Production Default ⏸)
**Phases:**
- **M5.1 Semantic Discovery** — ✅ Frozen (2026-07-26)
- **M5.2 Capability Invocation** — ✅ Frozen (2026-07-26)
- **P1.3a Function Schema Adapter** — ✅ Frozen (2026-07-26)
- **P1.3b Phase A Capability-First Schema Exposure** — ✅ Frozen (2026-07-27)
- **P1.3b Phase B Capability-First Default** — ✅ Active (2026-07-27)
- **M5.3 Multi-provider / optimization** — ⏸ Deferred
- **M5.4 Capability Taxonomy Expansion** — ✅ Frozen (2026-07-27)

| Phase | Scope | Status |
|-------|-------|--------|
| M5.1 | CapabilityDefinition, Catalog (derived from Registry), Resolver (single provider) | ✅ Frozen |
| M5.2 | CapabilityBinding, CapabilityService (resolve + invoke), Permission position freeze | ✅ Frozen |
| P1.3a | CapabilityFunctionSchemaAdapter, ToolSchemaProvider, ToolInvocationRouter, capability.selected event, dual-track mode | ✅ Frozen — Implementation ✅, Runtime ✅, Behavioral Adoption ❌ |
| P1.3b Phase A | Capability-first mode (SchemaExposureMode), ProviderAdapter (CapabilityProviderAdapter), call_raw_tool escape hatch, canonical→provider param transformation, fanqie + playwright adapters | ✅ Frozen — Synthetic Runtime ✅, Production Default ⏸ |
| P1.3b Phase B | Default enable capability-first mode (env-rollback via CAPABILITY_FIRST_MODE=false) | ✅ Active |
| M5.3 | Multi-provider ranking / fallback / optimization | ⏸ Deferred |
| M5.4 | Capability Taxonomy Expansion: file.management, search.retrieval, system.execution — canonical grouped capabilities covering ~70% of daily tool usage | ⏳ Design Frozen — Implementation ⏳ |
| P1.3b Phase C | Remove PROMPT_TOOLS, remove raw tool schemas | ⏸ Deferred |
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

---

## P1.3b Observation — Phase B Runtime

### 实验结论

**问题：** Capability-first schema 暴露后，LLM 是否能正确选择 capability 并通过 Provider 绑定执行？

**方法：** 
1. capability-first mode（4+1 函数），通过 `window.electronAPI.chat` 发出真实 LLM 请求
2. 首次验证：3 条消息（浏览器、搜索、创作），共触发 8 次 tool_calls
3. Catalog 修复后二次验证：新 session 下浏览器任务

### 结果

**Layer 1 — Schema Selection: ✅ Capability 可被 LLM 主动选择**

首次验证日志（session `pb_1`）:
```
tool_llm_tool_calls → ["browser_automation"]    ← LLM 选择 capability
tool_llm_tool_calls → ["web_scraping"]           ← LLM 选择 capability
tool_llm_tool_calls → ["call_raw_tool"]          ← fallback
```

P1.3a 的 173-tool 信噪比瓶颈被打破：当 LLM 只看到 4+1 个函数时，会主动选择 capability。

**Layer 2 — Provider Binding: ⚠️ 原始实现有混淆，已修复**

Catalog 构建时将 capability id 同时作为 tool name，导致:
```
resolve("browser.automation") → tool = "browser.automation"
⇒ callTool("browser.automation") → MCP 不认识
```

修复（Observation-B1）:
- `MCPServerManifest.dependencies[].tool` — 新增字段，显式指定 MCP tool name
- `CapabilityCatalog.rebuild()` — 优先使用依赖中的 tool 名
- `CapabilityProviderAdapter` 注册 key 与 tool name 对齐
- 已通过 synthetic test 验证：46/46 pass

**Layer 3 — Execution: ⏸ MemoryInterceptor 劫持（未闭环）**

二次验证中 LLM 直接走 `call_raw_tool("browser_navigate")`，未选 capability。
根因：MemoryInterceptor 将历史高频的 `browser_navigate` boost 为快捷方式，
LLM 跳过 capability 抽象层直接调用 raw tool。

### 新发现：Memory Layer 与 Capability 抽象层的跨层冲突

```
MemoryInterceptor (tool ← identity)
        ↓
boost history-matched tools
        ↓
LLM receives boosted tool schemas
        ↓
bypasses capability abstraction
        ↓
call_raw_tool(browser_navigate)  ← 即使 capability 可用
```

**本质问题：** Memory/Behavior/Optimization 层当前的学习对象是 **tool identity**，而不是 **capability identity**。Capability-first 只是 LLM 层的开关切换，但 Memory 层仍然在 tool 粒度操作。

```
目标状态:
Memory 学习 "用户需要浏览能力" → 推荐 browser_automation
当前状态:
Memory 学习 "browser_navigate 成功" → 推荐 raw tool
```

### 对 Phase C 的影响

Phase C（删除 raw schema exposure）前必须回答：
- 如果 Memory 推荐的是 raw tool，删除 raw tool 后系统是否退化？
- Memory 层的学习目标是否需要迁移到 capability identity？

**当前决策：**
- 不修补 Memory 层（属于独立课题，非 P1.3b 范围）
- Phase B 观察继续
- Phase C 推迟，等待 Memory alignment evidence

### 新增指标

| 指标 | 说明 |
|------|------|
| selection_source: capability | LLM 直接从 capability schema 选择 |
| selection_source: memory_bias | MemoryInterceptor 工具偏好驱动 |
| selection_source: raw_fallback | `call_raw_tool` 逃生通道 |

### P1.3b 当前状态

| 维度 | 状态 | 说明 |
|------|------|------|
| Capability-first Schema | ✅ | 4+1 函数，LLM 可主动选择 |
| Provider Routing | ✅ | catalog→tool 映射已修复，synthetic verified |
| Provider Adapter | ✅ | canonical→tool params 正确转换 |
| call_raw_tool Escape Hatch | ✅ | 正常运作 |
| Invoke Chain (selected→invoked→completed) | ⏸ | catalog 修复后未完成 E2E 闭环（Memory 劫持） |
| Memory Alignment | ⚠️ | Memory 仍操作 tool identity，非 capability |
| Phase C Decision | ⏸ | 等待 Memory evidence，不删除 raw schema |

---

## P1.3b Observation #2 — Memory Layer Tool Identity Bias

### Finding

MemoryInterceptor 仍然在 **tool identity** 粒度操作，绕过 Capability 抽象层。

### Evidence

```
capability-first schema enabled:
LLM capability selection works (pb_1: browser_automation selected)
```

但是在有 Memory 偏好的 session 中:
```
MemoryInterceptor boost: browser_navigate (matches: 5+)
    ↓
LLM tool_calls: ["call_raw_tool"]
    ↓
tool_router.raw_tool_fallback: browser_navigate
    ↓
Capability 抽象层被绕过
```

### Impact

Memory 层的学习对象是 **tool name**，不是 **capability id**。
即使 LLM 在 capability-first 模式下具备选择能力，Memory 的 tool-level 偏好会淹没这个优势。

当前 Memory 的行为等价于:
```text
目标:
  Memory: "用户需要浏览能力" → 推荐 browser.automation
实际:
  Memory: "browser_navigate 经常成功" → 推荐 raw tool
  LLM: 跟随 → call_raw_tool
  Capability-first: 被 bypass
```

### Decision

- **不做** Memory 行为变更（不属于 P1.3b 范围）
- **创建** 独立 Capability-Aware Memory migration 课题 (M6)
- **Phase C 阻塞**: 在 Memory alignment 解决前，删除 raw schema 会导致退化
- **来源分类**: 新增 `RawToolSelectionReason` 区分绕过原因

### Tool→Capability 覆盖审计

| 工具 | 对应 Capability | 覆盖率 |
|------|----------------|--------|
| browser_navigate | browser.automation | ✅ |
| browser_snapshot | browser.automation | ✅ |
| browser_click | browser.automation | ⏸ 未注册 |
| read_file | — | ❌ 无 |
| write_file | — | ❌ 无 |
| grep/search | — | ❌ 无 |
| publish_novel | publishing | ✅ |
| save_draft | content.drafting | ✅ |
| tts_speak | — | ❌ 无 |
| run_command | — | ❌ 无 |

覆盖率评估: ~8% (4/52+)，大量基础工具无 capability 映射。

---

## P1.3b Observation #3 — Capability Catalog Coverage Gap

### Finding

Phase B 的 Memory Alignment 阻塞根因不是 Memory 自身，而是 Capability Catalog 覆盖率过低。

### Audit Result (34 known tools)

| 分类 | 覆盖 |
|------|------|
| browser.* (6) | ✅ 100% mapped to browser.automation |
| publishing + content.drafting (2) | ✅ 100% |
| **File I/O** (read/write/edit/delete/...) | ❌ 0/9 |
| **Search** (grep/glob/web_search/...) | ❌ 0/4 |
| **System** (run_command/bash/python) | ❌ 0/3 |
| TTS/Memory | ❌ 0/4 |
| Builtin/Plan/Workflow | ❌ 0/6 |
| **Total** | **8/34 = 24%** |

### Root Cause

Memory/Behavior 层只能学习已定义的抽象。Catalog 只有 4 条目时，Memory 推荐必然回退到 tool 粒度。Memory Alignment 的真正前置是 Capability Taxonomy Expansion。

### Revised Decision

| 阶段 | 状态 |
|------|------|
| P1.3b Phase B | ✅ Observations collected |
| **M5.4 Capability Taxonomy Expansion** | **⬆️ NEW — before M6** |
| M6 Capability-Aware Memory | ⏸ depends on M5.4 coverage |
| Phase C | ⏸ blocked by M6 |

**Tier 1 scope:**
- `file.management` — read/write/edit/move/delete/copy/create_directory/list_files/append_file
- `search.retrieval` — grep/glob/web_search/web_fetch
- `system.execution` — run_command/bash/python

Target: 24% → ~65% coverage.

### Architecture Confirmation

`call_raw_tool` design validated: capability coverage can grow incrementally without breaking existing functionality. This is the Agent OS pattern — abstraction priority = actual call frequency.

### P1.3b Final Status

| 维度 | 状态 |
|------|------|
| Capability-first Schema | ✅ |
| Provider Routing | ✅ |
| Provider Adapter | ✅ |
| Escape Hatch | ✅ |
| Catalog Coverage | ⚠️ 24% → M5.4 |
| Memory Alignment | ⏸ blocked |
| Phase C | ⏸ blocked |

---

## M5.4 Capability Taxonomy Expansion — Design Freeze

### Problem

P1.3b Phase B Observation #3: Capability Catalog coverage is 24% (8/34 tools). Memory/Behavior layer cannot learn capability-level patterns when the abstraction covers <1/3 of daily tool usage. The Memory alignment issue is not a Memory bug — it is a catalog coverage gap.

### Decision D1 — Capability Granularity

**Principle:** Capability ≠ tool rename. A capability expresses what user wants to achieve.

**Correct:**
```
file.management
  └─ operation: "read" | "write" | "edit" | "delete"
  └─ path: string
  └─ content?: string
```

**Incorrect (tool alias):**
```
file.read      ← 这只是 read_file 的别名
file.write     ← 这只是 write_file 的别名
```

Three capabilities for M5.4 Phase 1:

| Capability | Provider Tools | Canonical Input |
|---|----|---|
| `file.management` | read_file, write_file, edit_file, delete_file, move_file, copy_file, create_directory, list_files | `{ operation: string, path: string, content?: string }` |
| `search.retrieval` | grep_search, glob_find, web_search, web_fetch | `{ query: string, scope?: string, source?: string }` |
| `system.execution` | run_command, bash_execute, execute_python | `{ command: string, args?: string[], language?: string }` |

### Decision D2 — Canonical Schema Ownership

Per P1.3b D3: Each capability owns its canonical `inputSchema`. Provider adapters transform.

```
file.management.inputSchema
  { operation, path, content? }
      ↓
fileSystemAdapter(input, "read_file")
  → { path: input.path }

fileSystemAdapter(input, "write_file")
  → { path: input.path, content: input.content }
```

Adapter is NOT identity — it projects the canonical schema onto tool-specific params.

### Decision D3 — Provider Mapping

Manifest declares capability→tools mapping explicitly:

```typescript
{
  id: 'file-system',
  capabilities: ['file.management'],
  dependencies: [
    { capability: 'file.management', tool: 'read_file' },
    { capability: 'file.management', tool: 'write_file' },
    // ...
  ],
}
```

Catalog defaultTool = first dependency tool. Adapter key = `${providerId}:${tool}`.

### Decision D4 — Coverage Target

| Tier | Scope | Tools | Coverage |
|------|-------|-------|----------|
| Tier 1 (M5.4) | file.management, search.retrieval, system.execution | ~16 | 24% → ~70% |
| Tier 2 (future) | TTS, Memory, Plan | ~8 | ~70% → ~94% |
| Tier 3 (raw) | Low-frequency builtins | ~2 | 100% |

Do not chase 100%. call_raw_tool remains for Tier 3.

### Non-goals

- ❌ Per-tool capability aliases
- ❌ Rich inputSchema (generic `{description}` fallback stays)
- ❌ CapabilityFunctionSchemaAdapter changes
- ❌ Memory/Behavior layer changes
- ❌ Phase C cleanup
- ❌ Tier 2-3 coverage (TTS, Memory, Plan, Workflow)

### Files

| File | Change |
|------|--------|
| `src/main/capability/adapters/<category>-adapter.ts` | New — canonical → tool params projection |
| `src/main/capability/adapters/index.ts` | Export |
| `src/main/bootstrap/AppRuntime.ts` | Register 3 manifests + adapters |
| `src/main/tool/__tests__/P1_3b_exit_gate.test.ts` | Assert contracts, not counts |

### Verification

1. `resolve("file.management") → { tool: "read_file", provider: "file-system" }`
2. Adapter transforms `{ operation, path }` → tool-specific params
3. Existing 46/46 tests pass
4. Test asserts presence of capabilities, not count

---

## M5.4 Observation #1 — Canonical Schema Requirement

### Finding

Grouped capability without explicit canonical inputSchema cannot reliably participate in LLM function calling. The generic `{ description }` fallback schema is insufficient when a capability requires structured parameters (operation, path, query, etc.).

### Evidence

```
file.management selected by LLM                 ✅
CapabilityService received input: { description }
CapabilityDefinition.inputSchema was generic    ❌
file-system adapter cannot extract operation/path
invocation failed: "path 参数缺失"               ❌
fallback to call_raw_tool                      ⚠️
```

LLM **can** select grouped capabilities (proving taxonomy works), but the absence of canonical schema makes LLM produce natural-language input instead of structured parameters.

### Resolution

`MCPServerManifest` gains optional `capabilitySchemas` field:
```typescript
capabilitySchemas?: Record<string, {
  type: 'object'
  properties: Record<string, { type: string; description: string }>
  required: string[]
}>
```

`CapabilityCatalog.rebuild()` uses manifest schema as canonical source when present, falling back to generic `{ description }` schema for manifest-declared capabilities without explicit schema.

All three M5.4 grouped capabilities now carry explicit canonical schemas:
- `file.management` — `{ operation, path, content? }`
- `search.retrieval` — `{ operation, query, scope? }`
- `system.execution` — `{ command, cwd? }`

### Impact

- Observation Gate indicators now valid for measurement
- No interference from schema insufficiency in coverage/projection data
- Backward compatible: existing 4 capabilities (browser.automation, etc.) unchanged

### Status

✅ Resolved at implementation level.
⏳ Pending runtime verification.

---

## M5.4.2 Observation Gate — Minimal Closure

Before entering full Observation Window, verify each grouped capability completes a full `selected → invoked → completed(success)` cycle at least once.

### Verification plan

| Task | Capability | Expected adapter output |
|------|-----------|------------------------|
| "创建 test.txt, 内容 hello" | file.management | `{ path, content }` → write_file |
| "读取 test.txt" | file.management | `{ path }` → read_file |
| "重命名 test.txt → test2.txt" | file.management | `{ source, destination }` → move_file |
| "搜索 grep TODO" | search.retrieval | `{ pattern }` → grep_search |
| "执行 pwd" | system.execution | `{ command }` → run_command |
