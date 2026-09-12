# Tool State Classification Matrix

> Runtime v2 下一阶段：识别哪些服务状态值得跨任务生命周期保存。
> 基于现有 87 个工具的统计和 service-level 状态分析。

## 核心结论

**Tool 是 stateless handler，状态在 Domain Service 层。** 因此：
- `StatefulComponent` 重命名为 `CheckpointableComponent`，由 Domain Service 实现
- `ToolRuntimeSnapshotPlugin` 的目标对象从 Tool 改为 Tool-backed Domain Component
- CheckpointManager 不理解 domain 语义，通过 `Record<string, VersionedState>` 泛化存储

## 修正后的设计

### componentStates 类型
```typescript
// 从固定 key 改为 Record，保留 version 语义
componentStates?: Record<string, VersionedState>
// 例如: { "workflow-runtime": {...}, "blog-session": {...} }
```

### CheckpointableComponent 接口
```typescript
interface CheckpointableComponent {
  id: string
  snapshot(): Promise<VersionedState>
  restore(state: VersionedState): Promise<void>
}
```

### 第一实现者优先级

| 优先级 | Component | 理由 |
|--------|-----------|------|
| P0 | WorkflowRuntime | 生命周期明确、有暂停/恢复需求、不属于 Agent 核心状态 |
| P1 | BlogSession | 长期写作会话需要断点续写 |
| P2 | ConversationContext | 接近 Runtime 核心，暂缓 |
| P3 | GoalEngine | 跨对话目标追踪 |

不实现：MemoryService、PlanManager（已文件持久化，不做冗余）

## 分类规则

| 类别 | 含义 | Checkpoint 策略 |
|------|------|-----------------|
| **Logical State** | 有价值、内存独占、丢失后无法自动重建的逻辑状态 | 保存完整 payload |
| **Persistent State** | 已由服务自身持久化到磁盘的状态 | 保存引用/refId，不存数据 |
| **Ephemeral Resource** | 运行时资源（handle、timer、socket、callback） | 丢弃，restore 时重建 |

## 分类矩阵

### Layer 1: Logical State — 需要 Checkpoint

| 状态 | 服务/Manager | 持有者 | 示例数据 | 原因 |
|------|-------------|--------|---------|------|
| ConversationContext | ScopedAgent / ChatExecutor | messages[] | 用户消息、LLM 回复 | 恢复对话的关键引用值；内存独占 |
| BlogAgent sessions | BlogAgentService | `Map<sessionId, BlogSessionState>` | 当前 stage、progress、outputs | 长期会话，进程重启丢失 |
| Workflow running runs | WorkflowSchedulerV2 | `running: Map<runId, AbortController>` | 当前步骤索引、上下文数据 | DAG 执行位置，需恢复时回滚 |
| Writing session | WritingService | 写作阶段性输出 | 当前章节状态 | 长期写作任务的断点续写 |
| Goal progress | GoalEngine/GoalService | goals[] | 当前进度百分比 | 跨对话目标追踪 |

### Layer 2: Persistent State — 保存引用

| 状态 | 服务 | 持久化方式 | Checkpoint 策略 |
|------|------|-----------|-----------------|
| PlanManager plans | PlanManager | 文件系统(e.g. `.claude/plans/`) | 存 `planId`，restore 时从存储重载 |
| MemoryService entries | MemoryService | JSON 文件系统 | 存 `sessionId` + `entryId[]` |
| ToolCallChainStore | ToolCallChainStore | `.claude/tool_call_chains.json` | 存引用，恢复时重建 store |
| ToolCallLogStore | ToolCallLogStore | `.claude/tool_call_log.json` | 同上一一运行时可重建 |
| Workflow definitions | WorkflowStoreV2 | JSON 文件 | 存 `defId` |
| EventMonitor configs | EventMonitorService | 文件系统 | 存 monitorId，重建 timer |
| User preferences | MemoryService | JSON | 存 pref key，直接在 memory 中查找 |
| Dynamic tool registry | ToolProviderRegistry | 会话级 | 存 provider name，重建 tool |
| Blog habit profile | BlogAgentService | MemoryService | 存引用，内存中重建 profile |
| TypeChallengeGenerator | TypeChallengeGenerator | — | 状态简单，可存 `{ currentChallenge }` |

### Layer 3: Ephemeral Resource — 丢弃

| 资源 | 所在 | 原因 |
|------|------|------|
| AbortController | WorkflowSchedulerV2、ScopedAgent、各 interval | 运行时信号，restore 时新建 |
| setInterval/setTimeout | SessionGovernor、ToolCallOptimizer、BlogAgentService | 时间敏感，restore 时重建 |
| SSH connection handle | sshClient | 连接会被关闭，需重建 |
| IPC listener | preload/index.ts | Electron IPC，窗口重建时重连 |
| EventBus listener | 多处 | 订阅回调，restore 后重新注册 |
| Streaming audio buffer | TtsService | 播放中音频，无法恢复 |
| ToolAvailabilityCache | ToolAvailabilityCache | 运行时缓存，可重建 |

## 关键边界决策

### Tool 级别不持有状态

所有 87 个 Tool 都是 stateless handler（`buildTool()` 工厂模式）。状态分散在后台服务中。所以：
- 不要在 Tool 定义上实现 `StatefulComponent`
- 应该在 Domain Service 层面实现
- `Checkpoint.componentStates.tools` 不存"所有 tool 的状态"，而存"需要恢复的 domain service 状态"

### 谁需要实现 StatefulComponent

| 优先级 | Domain Service | 理由 |
|--------|---------------|------|
| P0 | ScopedAgent / ConversationContext | 对话上下文是最核心的恢复目标 |
| P1 | WorkflowSchedulerV2 | 正在运行的工作流需断点续行 |
| P2 | BlogAgentService | 长期博客会话 |
| P3 | GoalEngine | 跨对话目标追踪 |

### 不纳入 checkpoint 的状态

- **MemoryService 数据**: 已由 MemoryService 自身持久化，不需要 checkpoint 冗余存储
- **PlanManager 计划**: 同上一一已有文件持久化
- **Tool 分析/统计信息**: ToolCallChainStore、ToolEvalSnapshotStore 等统计数据的丢失不影响任务正确性
- **LLM 模型状态**: 无状态 API 调用，不需要保存

## Checkpoint.componentStates 当前的限制

```typescript
// CheckpointTypes.ts 当前定义
componentStates?: {
  workflow?: VersionedState
  tools?: VersionedState
}
```

问题：
1. `workflow` 和 `tools` 是固定 key，不具扩展性
2. 没有区分 logical/persistent/ephemeral
3. `VersionedState.data` 是 `unknown`，没有 domain 级类型约束

建议下一阶段重新定义为一个 `Map<string, DomainCheckpoint>` 结构：

```typescript
interface DomainCheckpoint {
  domain: string        // e.g. 'conversation', 'workflow_scheduler', 'blog_agent'
  stateType: 'logical' | 'persistent_ref' | 'ephemeral'
  payload: unknown
  estimatedSize: number // bytes, for storage budgeting
}
```

这样 CheckpointManager 可以不理解 domain 语义，但 domain service 层有明确契约。
