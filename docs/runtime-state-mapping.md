# Runtime State ↔ Checkpoint 映射关系

## 概述

本文件记录 Runtime 当前状态模型与 Checkpoint 数据结构之间的映射规则。
定义见 ADR-010，实现见 `RuntimeCheckpointAdapter.ts`。

## 状态分层

```
RuntimeManager (任务注册表)
    ↓ 持有引用
RuntimeTaskImpl (任务锚点)
    ↓ 持有引用
AgentSupervisor (Worker 协调器)
    ↓ 持有引用
SupervisedWorkerAgent (核心执行者)
    ↓ 持有引用
ConversationContext (消息历史)
```

## 映射矩阵

### RuntimeTaskImpl → Checkpoint.TaskState

| Runtime 字段 | Checkpoint 字段 | 映射规则 |
|---|---|---|
| `id` | — | 不直接进入 checkpoint（由 checkpoint.taskId 引用） |
| `name` | `taskState.name` | 1:1 |
| `createdAt` | `taskState.createdAt` | 1:1 |
| `metadata` | `taskState.metadata` | 1:1 |
| `supervisor` | — | 不序列化，restore 时重建 |

### SupervisedWorkerAgent → Checkpoint.ExecutionState

| Runtime 字段 | Checkpoint 字段 | 映射规则 |
|---|---|---|
| `id` | `executionState.workerId` | 1:1 |
| `goal` | `executionState.goal` | 1:1 |
| `_step` | `executionState.step` | 1:1 |
| `state: RuntimeState` | `executionState.lastSafePoint` | **复合映射**（见下方） |
| `context: ConversationContext` | `executionState.conversationContext` | inline / reference 双模 |
| `maxTurns` | — | restore 时由 Supervisor config 注入 |
| `mailbox queue` | `executionState.pendingDecision` | 仅保留 WAITING_SUPERVISOR 相关命令 |
| — | `executionState.pendingToolCalls` | 由 Runtime 外部提供 |

### RuntimeState ↔ SafePoint 映射

| RuntimeState | SafePoint | 说明 |
|---|---|---|
| `RUNNING` | `before_llm` | 默认起始点，尚未调用 LLM |
| `WAITING_TOOL` | `after_tool` | 工具调用完成后等待 |
| `WAITING_SUPERVISOR` | `after_llm` | LLM 返回后等待决策 |
| `PAUSED` | `before_llm` | 暂停时默认回到 LLM 前 |
| `INTERRUPTED` | `before_llm` | 中断时回到起始 |
| `COMPLETED` | — | 已完成 Worker 不进入 checkpoint |
| `FAILED` | — | 已失败 Worker 不进入 checkpoint |
| `CANCELLED` | — | 已取消 Worker 不进入 checkpoint |

### 明确不进入 Checkpoint 的字段

| 字段 | 原因 |
|---|---|
| `abortController` | 运行时资源，不可序列化（ADR-010 §4.2） |
| `onProgress` | 回调闭包，不可序列化 |
| `completedResults` | 已完成 Worker 无需恢复 |
| `_pauseRequested` | 恢复后不自动进入 pause |
| `mailbox.queue`（非 decision 命令） | pause/resume/redirect 命令在 checkpoint 时已过时 |
| `supervisorFactory` | 工厂函数，restore 时重新提供 |

## 恢复流程

```
Checkpoint.restore()
    ↓
RuntimeCheckpointAdapter.planRestore(checkpoint)
    ↓
RestorePlan {
    resumeStrategy: 'continue' | 'retry_tool' | 'wait_supervisor' | 'complete'
}
    ↓
RuntimeManager.rebuildRuntimeTask(plan)
    ↓
重建 RuntimeTask + Supervisor（从 config）
    ↓
重建 Worker（从 executionState）
    ↓
注入 ConversationContext（inline/reference 模式）
    ↓
按 resumeStrategy 继续执行
```
