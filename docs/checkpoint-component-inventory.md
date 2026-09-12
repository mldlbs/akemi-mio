# Checkpoint Component Inventory

> Phase 1 of Runtime v2 restore freeze: 列出候选状态，按归属层分类，
> 回答 "restart 后如果这个状态丢失，系统还能否继续执行同一个任务？"

## 分类框架

### 状态归属层

| 层 | 定义 | 所有者 |
|----|------|--------|
| **Runtime** | 任务执行引擎的瞬时执行位置 | WorkflowScheduler、RestoreService |
| **Domain** | 业务逻辑的持久化/可恢复数据 | MemoryService、BlogAgentService |
| **Session** | 一次对话会话的上下文 | ConversationContext、SessionRecoveryManager |
| **Stateless** | 无状态 handler，不持有跨任务数据 | Tool 定义、TTS、ASR、MCP连接 |

### 判定标准

> restart 后，如果这个状态丢失，系统还能否继续执行同一个任务？

| 结果 | 策略 |
|------|------|
| **能** — 状态可由其他持久层重建 | 不做 checkpoint，使用重新初始化 |
| **不能** — 任务会中断或行为不一致 | 进入恢复模型 |

---

## Component Inventory

### P0: WorkflowRuntime (Runtime 层)

| 维度 | 评估 |
|------|------|
| 类别 | **Logical State** |
| ADR | ADR-011 冻结，41 测试覆盖 |
| 状态 | 当前 step 索引、ctx.steps、completed/failures/skipped Set、retry 局部变量 |
| 持久化 | WorkflowRun.steps → SQLite workflow_step_runs |
| 丢失影响 | restart 后 executeLoop 无法继续，不知道哪些 step 已完成 |
| 判定 | **✅ 必须 checkpoint** — 已实现 |
| 恢复方式 | `rebuildExecutionSteps()` → execution context 重建 |
| 已实现 | `CheckpointableComponent`, snapshot/restore/plan, resumeRun, 41 tests |

### P0: Scheduler State (Runtime 层)

| 维度 | 评估 |
|------|------|
| 类别 | **Logical State** |
| 状态 | 正在运行 runId 列表、AbortController |
| 丢失影响 | scheduler 不知道哪些 workflow 在运行 |
| 判定 | **✅ 必须 checkpoint** — 通过 `WorkflowRuntimeCheckpointableComponent.snapshot()` 记录 runId 列表 |
| 恢复方式 | restore → WorkflowRecoveryPlan[] → scheduler.resumeRun() |
| 注意 | AbortController 是 Ephemeral Resource，restore 时新建 |

### P0: ConversationContext (Session 层)

| 维度 | 评估 |
|------|------|
| 类别 | **Logical State** |
| 当前机制 | SessionRecoveryManager 独立管理（文件 JSON checkpoint） |
| 丢失影响 | 对话历史丢失，用户需要重新说明上下文 |
| 判定 | **⚠️ 已有独立恢复机制** — 且 Route v2 checkpoint 不做 session 恢复 |
| 原因 | ADR-011 §2.1 明确排除：Agent 对话历史属于 SessionRecoveryManager |
| 建议 | 保持现有 SessionRecoveryManager 不变，不与 Runtime restore 合并 |

### P1: BlogAgentService (Domain 层)

| 维度 | 评估 |
|------|------|
| 类别 | **Logical State** |
| 当前状态 | `Map<sessionId, BlogSessionState>` — 纯内存，不持久化 |
| 丢失影响 | 重启后所有活跃博客写作会话丢失，用户需重新打开 session |
| 判定 | **⏳ P1 候选** — 见 tool-state-classification-matrix.md |
| 依赖 | 需要先在 CheckpointTypes 中扩展 `componentStates` 为 `Record<string, VersionedState>` |
| 注意 | BlogSessionState 包含 stage/progress/outputs，不可从 DB 重建 |

### MemoryService (Domain 层)

| 维度 | 评估 |
|------|------|
| 类别 | **Persistent State** |
| 当前持久化 | Write-through SQLite（`memories`, `memory_summaries`, `memory_vectors` 等 8 表） |
| 内存状态 | `entries[]`, `messageCount`, `lastUserText`, `removedIds`, `decayTimer` |
| 子组件状态 | transitionMatrix（从 interaction_log 部分重建）、preloadCache（丢弃重建）、cachedProfile（丢弃重建） |
| 丢失影响 | restart 后从 SQLite 全量重载 entries[]，重建 ≈ 完整恢复 |
| 判定 | **✅ 不需要 checkpoint** — 数据已由自身持久化。运行时缓存丢失后可重建 |
| 不恢复项 | transitionMatrix（部分丢失 → 从 interaction records 部分重建，不破坏任务连续性） |
| 参考 | tool-state-classification-matrix.md §"不纳入 checkpoint 的状态" |

### Tool System (Stateless 层)

| 维度 | 评估 |
|------|------|
| 类别 | **Stateless Handler** |
| 当前状态 | 87 个 Tool 全部通过 `buildTool()` 工厂模式构建，不持有状态 |
| 丢失影响 | 无影响 — 下次调用前重新 build |
| 判定 | **✅ 不需要 checkpoint** — 状态在 Domain Service 层，不在 Tool 层 |
| 例外 | Tool 调用链的状态（pendingToolCalls）属于 ConversationContext 管理 |

### SessionRecoveryManager (Session 层)

| 维度 | 评估 |
|------|------|
| 类别 | **Persistent State** |
| 当前持久化 | File-based JSON checkpoint (`checkpoints/chk_*.json`, `latest.json`, TASK.md, STATUS.md) |
| 状态 | CheckpointData: runContext, conversationSummary, shortTermMemory, planState |
| 丢失影响 | 本身已是持久系统，不依赖 runtime checkpoint |
| 判定 | **✅ 已有独立恢复机制** — 保持独立，不与 Runtime v2 合并 |
| 边界 | Runtime v2 restore 和 SessionRecoveryManager 是两条独立链路（见 runtime-restore-integration.md §6） |

### DynamicToolLifecycle (Domain 层)

| 维度 | 评估 |
|------|------|
| 类别 | **Logical State** |
| 当前状态 | `Map<sessionId, Set<toolName>>` + `Map<toolName, DynamicToolRecord>`，纯内存 |
| 丢失影响 | session 级动态注册的 tool（register_tool/create_tool）丢失，需要重新注册 |
| 判定 | **⏳ P2 候选** — 但 user scenario 极少（register_tool 很少使用） |
| 建议 | 等待真实需求确认，暂不实现 |

### ToolCallChainStore 活跃链 (Domain 层)

| 维度 | 评估 |
|------|------|
| 类别 | **Logical State** |
| 当前状态 | `_currentIntent`, `_currentCategory`, `_currentLinks[]` — 内存独占 |
| 丢失影响 | 已完成链条保存在 `.claude/tool_call_chains.json` 不丢失；活跃链条丢失 |
| 判定 | **⏳ P3 候选** — 活跃链丢失不影响任务正确性，仅丢失分析连续性 |
| 建议 | 等待 tool chain 分析功能成熟后再考虑 |

### ToolGeneratorService (Domain 层)

| 维度 | 评估 |
|------|------|
| 类别 | **Mixed — persistent (source files) + logical (metadata)** |
| 丢失影响 | 生成 tool 的源码文件在磁盘保留，但运行时注册表丢失 |
| 判定 | **⏳ 等待需求** — 生成 tool 的运行时注册可通过扫描磁盘重建 |

### WritingService / GoalEngine (Domain 层 — 待接入)

| 维度 | 评估 |
|------|------|
| 类别 | **Logical State** |
| 优先级 | P2-P3（按 tool-state-classification-matrix.md）|
| 当前状态 | 未审计具体实现 |
| 判定 | **⏳ 未来扩展** — 需要各自的 snapshot/restore 契约 |
| 依赖 | 需要 `componentStates` 扩展为 `Record<string, VersionedState>` |

---

## 恢复策略总表

| Component | 类别 | 是否需要 checkpoint | 恢复方式 |
|-----------|------|-------------------|---------|
| WorkflowRuntime | Runtime | ✅ P0（已实现） | rebuildExecutionSteps + scheduler.resumeRun() |
| Scheduler runId 列表 | Runtime | ✅ P0（已实现） | WorkflowRuntimeCheckpointableComponent |
| ConversationContext | Session | ⚠️ 已有独立系统 | SessionRecoveryManager |
| MemoryService entries | Domain | ❌ SQLite 已持久化 | 启动时 SELECT * FROM memories |
| MemoryService 运行时缓存 | Domain | ❌ 可重建 | 丢弃，下次访问时重新计算 |
| Tool 定义 | Stateless | ❌ 无状态 handler | buildTool() 工厂 |
| Tool 统计/分析 | Domain | ❌ 文件已持久化 / 可重建 | 启动时从文件重载 |
| ToolAvailabilityCache | Domain | ❌ 可重建 | 丢弃，30 分钟 TTL 自动填充 |
| ToolCallChainStore 活跃链 | Domain | ⏳ P3 候选 | 活跃链小，但丢失不影响任务正确性 |
| DynamicToolLifecycle | Domain | ⏳ P2 候选 | session 动态 tool，使用稀少 |
| ToolGeneratorService | Domain | ⏳ 等待需求 | 源码文件在磁盘，metadata 可扫描重建 |
| BlogAgentService sessions | Domain | ⏳ P1 候选（未实现） | 待实现 CheckpointableComponent |
| SessionRecoveryManager | Session | ✅ 文件已持久化 | latest.json 恢复 |
| WritingService | Domain | ⏳ P2-P3 | 未来扩展 |
| GoalEngine | Domain | ⏳ P3 | 未来扩展 |
| TTS / ASR / MCP | Stateless | ❌ 无状态 | 启动时重新初始化 |

---

## 现状 vs tool-state-classification-matrix.md 对比

### 一致项

- ✅ Tool 是 stateless handler（87 个 = 一致性确认）
- ✅ WorkflowRuntime 是第一个实现者（P0 已完成）
- ✅ MemoryService 不纳入 checkpoint
- ✅ PlanManager 不纳入 checkpoint（文件持久化）

### 需更新项

| 配置项 | 原矩阵 | 当前审计结论 |
|--------|--------|-------------|
| ConversationContext 优先级 | P0 "最核心的恢复目标" | 应由 SessionRecoveryManager 独立管理，不并入 Runtime restore |
| BlogAgentService 优先级 | P1 | 确认 P1，但前置依赖（componentStates 扩展）未解决 |
| componentStates 类型 | 固定 key `workflow`/`tools` | 需扩展为 `Record<string, VersionedState>` 才能接入新组件 |

---

## 关键边界决策

1. **Runtime vs Session 不合并** — Runtime v2 restore 解决"执行位置恢复"，SessionRecoveryManager 解决"对话上下文恢复"。两条链路互不依赖，也不应合并。

2. **MemoryService 不进入 Runtime checkpoint** — 数据已由 SQLite 持久化。运行时缓存（transitionMatrix, preloadCache, cachedProfile）丢失后不影响任务执行连续性，下次交互时重建。

3. **BlogAgentService 是下一个扩展候选** — 但前置条件是 `componentStates` 从固定 key 扩展为 `Record<string, VersionedState>`。在 ADR-010/ADR-011 冻结状态下，这需要新的 ADR。

4. **当前不扩展任何新组件** — ADR-011 §3 要求：后续组件接入需补充独立 ADR 或扩展本 ADR。Inventory 标识了候选，但接入需要独立的语义定义。
