# WorkflowRuntime State Mapping

> WorkflowRuntime (WorkflowSchedulerV2) 是第一个实现 CheckpointableComponent 的 Domain Service。
> 本文档确认哪些状态属于 checkpoint、哪些可重建、哪些丢弃。

## WorkflowRuntime 状态全景

```
WorkflowSchedulerV2 instance (内存)
├── running: Map<runId, AbortController>        ← ephemeral
├── cancelled: Set<runId>                       ← ephemeral
├── runAgentIds: Map<runId, string[]>           ← ephemeral
│
executeLoop (每次 startRun 创建)
├── completed: Set<stepId>                      ← logical → 可重建
├── failures: Set<stepId>                       ← logical → 可重建
├── skipped: Set<stepId>                        ← logical → 可重建
├── StepContext { steps, input }                ← logical → 可部分重建
│
WorkflowStoreV2 (SQLite, 持久化)
├── workflow_defs                                ← persistent reference
├── workflow_runs (status, pendingGate)          ← persistent reference
└── workflow_step_runs (output, error)           ← persistent reference
```

## 三层分类

### Layer 1: Logical State — 需要 checkpoint

| 状态 | 当前位置 | 存储方式 | 原因 |
|------|---------|---------|------|
| `completed` Set | `executeLoop` 栈帧 | 纯内存 `Set<string>` | 决定 DAG 进度指针，丢失后无法恢复 |
| `failures` Set | `executeLoop` 栈帧 | 纯内存 `Set<string>` | 同上 |
| `skipped` Set | `executeLoop` 栈帧 | 纯内存 `Set<string>` | 同上 |
| `StepContext.input` | `executeLoop` 栈帧 | `ctx.input` | 用户原始输入，丢失后 workflow 无法继续 |
| `run.pendingGate` | `WorkflowRun` 对象 | SQLite + 内存 | 暂停位置，restore 后需恢复 gate 等待 |
| `run.status` | `WorkflowRun` 对象 | SQLite + 内存 | paused/running 标识 |

### Layer 2: Persistent Reference — 保存引用

| 状态 | 持久化位置 | Checkpoint 策略 |
|------|-----------|-----------------|
| Workflow definition | `workflow_defs` SQLite | 存 `def.id` |
| Step individual results | `workflow_step_runs` SQLite | 存 `run.runId` |
| Run metadata (userInput, trigger) | `workflow_runs` SQLite | 存引用，按需 reload |

### Layer 3: Ephemeral Resource — 丢弃

| 资源 | 原因 |
|------|------|
| `AbortController` | 运行时信号，restore 时新建 |
| `Set<runId>` cancelled | 取消标记，新 run 没有取消历史 |
| `Map<runId, string[]>` runAgentIds | spawn 的 subagent ID，已随进程消失 |
| `Promise` pending tool/API call | 运行中请求无法恢复 |
| `setTimeout` sleep/sleepWithSignal | 时间敏感，丢弃 |
| `eventBus.on('workflow.run.updated')` listener | restore 后重新注册 |

## 关键设计决策

### 1. 重建 vs 保存

以下状态**不需要**在 checkpoint 中完整保存，可以从 SQLite 重建：

```typescript
// Restore 时重建 executeLoop 状态：
const run = workflowStore.getRun(runId)          // → status, pendingGate
const stepRuns = run.steps                        // → per-step status

// 从 stepRuns 重建 Sets:
const completed = new Set(stepRuns.filter(s => s.status === 'done').map(s => s.stepId))
const failures = new Set(stepRuns.filter(s => s.status === 'failed').map(s => s.stepId))
const skipped = new Set(stepRuns.filter(s => s.status === 'skipped').map(s => s.stepId))

// StepContext 需要额外处理:
// ctx.input = run.userInput (从 SQLite 拿)
// ctx.steps = {} ← 这里有个 gap
```

### 2. StepContext.steps 的问题

`executeLoop` 中:
```typescript
const ctx: StepContext = { steps: {}, input: run.userInput ?? '' }
```
每次 step 完成后:
```typescript
ctx.steps[sd.id] = { result: result.data, status: 'done' }
```
但 `workflowStore.updateStep()` 写的是独立的 `workflow_step_runs.output`。`ctx.steps` 的完整累积状态**没有作为一个整体持久化**。这意味着：
- 单个 step 的 `result` 可以从 `stepRun.agentResult` 获取
- 但下游步骤引用的 "上一步完整输出" 在 restore 时是可用的（从各自的 step_run）

**结论**: StepContext 不需要额外保存，从 step_runs 数组可重建等价结构。

### 3. 暂停状态

`pendingGate` 已由 WorkflowStoreV2 持久化。Checkpoint 只需要存 `runId`，restore 时从 SQLite 加载。

## CheckpointableComponent 定义

```typescript
class WorkflowRuntimeCheckpointableComponent implements CheckpointableComponent {
  id = 'workflow-runtime'

  async snapshot(): Promise<VersionedState> {
    // 只保存 running/paused 的 workflow 的 runId
    // completed/failed/cancelled 的 run 不需要 checkpoint
    const activeRunIds = this.getRunningRunIds()

    return {
      component: 'workflow-runtime',
      version: '1',
      data: {
        activeRunIds,        // 正在运行的 run 列表
      },
      createdAt: Date.now(),
    }
  }

  async restore(state: VersionedState): Promise<void> {
    // 1. 从 persistent storage 重建 executeLoop 状态
    // 2. 对 paused 的 run，维持 paused 状态
    // 3. 对 running 的 run，重建 completed/failures/skipped 后继续 executeLoop
  }
}
```

## Snapshot 实际内容

WorkflowRuntime 的 snapshot **很小**——不需要存 step 数据，只需要：

```typescript
interface WorkflowRuntimeSnapshot {
  activeRunIds: string[]           // 哪些 run 需要恢复
  // 不包含:
  //   - workflow definitions (已持久化)
  //   - step results (已持久化)
  //   - AbortController (丢弃)
  //   - cancelled Set (丢弃)
}
```

这也是它作为第一个实现者的优势：snapshot 极其轻量。

## Restore 流程

```
restore(VersionedState)
    │
    ├─1. 验证 activeRunIds 中的 run 在 DB 中存在
    │
    ├─2. 对每个 activeRun:
    │     ├─ load run from SQLite
    │     ├─ load def from SQLite
    │     ├─ 重建 completed/failures/skipped Sets
    │     ├─ 重建 StepContext
    │     ├─ 新建 AbortController
    │     └─ 调用 continueRun() → 继续 executeLoop
    │
    └─3. 返回成功的 RestoreResult
```

## 为什么 WorkflowRuntime 是理想的第一个实现者

1. **生命周期明确**: startRun → executeLoop → finishRun
2. **状态隔离**: 不依赖 ScopedAgent、MemoryService 等外部服务
3. **恢复可验证**: paused 的 workflow 恢复后可以继续执行
4. **Snapshot 轻量**: 只需要存 `activeRunIds: string[]`
5. **ADR-010 验证**: 完整覆盖 componentStates / StatefulComponent / RestoreResult 链路

## 已知风险

| 风险 | 处理方式 |
|------|---------|
| restore 时 SQLite 中的 def 被删除 | RestoreResult.degraded 标记该 run 不可恢复 |
| restore 时 subagent 全没了 | 依赖 subagent 的 step 会失败，走重试逻辑 |
| 内存状态 vs DB 状态不一致 | 以 DB 为准重建，不信任旧的内存快照 |
