# ADR-010: Runtime v2 Checkpoint Contract

**Status:** Draft
**Date:** 2026-07-19
**Supersedes:** None
**Upstream Dependencies:**
- ADR-009 (Runtime v2 Architecture Constraints) — Frozen

---

## Context

ADR-009 冻结了 Runtime v2 的架构边界。Checkpoint 是 v2 的第一个具体契约——它决定 Runtime 能否支持长时间运行任务、断点续传、跨会话 resume。

本 ADR **只定义 Contract，不绑定存储实现**。在接口和语义层面达成一致后，再进入 CheckpointManager 实现阶段。

### 前置约束（来自 ADR-009）

- Agent 不持有持久化逻辑（§1.1）
- CheckpointManager 不持有 Agent 引用（§1.2）
- Runtime 是唯一生命周期锚点（§1.3）
- Tool Runtime 状态所有权未解决（§1.4 — 在本 ADR 解决）
- Checkpoint 必须包含三层版本信息（§4）

---

## 1. Checkpoint 数据结构

### 1.1 核心结构

```ts
interface Checkpoint {
  // ── 标识 & 版本信息 ──
  id: string
  taskId: string

  // 三层版本（见 ADR-009 §4）
  schemaVersion: string            // MAJOR.MINOR
  runtimeCompatibility: {
    min: string                    // 可恢复的最小 Runtime 版本
    max: string                    // 可恢复的最大 Runtime 版本
  }

  // ── 恢复所需的核心状态 ──
  taskState: TaskState
  executionState: ExecutionState

  // ── 可选的外部引用 ──
  memoryReference?: MemoryReference

  // ── 组件级状态（版本化 payload，CheckpointManager 不解包） ──
  componentStates?: {
    workflow?: VersionedState
    tools?: VersionedState
  }

  // ── 元数据 ──
  createdAt: number
}
```

### 1.2 TaskState

RuntimeTask 级别的不可变元数据。恢复时用于重建 Task 锚点。

```ts
interface TaskState {
  name: string
  metadata?: Record<string, unknown>
  createdAt: number
}
```

### 1.3 ExecutionState

Worker 级别的执行位置。恢复时用于从 SafePoint 续传。

```ts
interface ExecutionState {
  workerId: string
  goal: string

  // 执行游标（SafePoint 级别的精确位置）
  step: number
  lastSafePoint: SafePoint

  // Agent 层面 — 使用 inline/reference 双模
  conversationContext: SerializedContext
  pendingToolCalls: ToolCallState[]         // 尚未完成的工具调用

  // 决策等待状态（如果 WAITING_SUPERVISOR）
  pendingDecision?: {
    query: string
    summary: string
  }
}

interface ToolCallState {
  toolName: string
  args: unknown
  status: 'pending' | 'in_flight'
  retryCount: number
  createdAt: number
}

/**
 * SerializedContext — LLM 消息历史的序列化形式。
 *
 * 双模设计：
 *   "inline": 消息内容直接序列化在 checkpoint 内。
 *             适用于短会话、独立恢复场景。
 *   "reference": 仅保存消息元数据（数量、token 估算、摘要），
 *                实际 payload 由外部存储（MemoryService / DB）管理。
 *
 * 选择依据：如果消息历史较大（> 10 messages）或已有外部持久化，
 * 应使用 "reference" 模式避免 checkpoint 膨胀。
 *
 * 边界约束：
 * - CheckpointManager 不解析 data 中的消息内容
 * - StorageAdapter 不决定消息的语义含义
 * - 消息存储的生命周期独立于 checkpoint 生命周期
 */
type SerializedContext =
  | { type: 'inline'; messages: MessagePayload[]; tokenEstimate: number }
  | { type: 'reference'; messageCount: number; lastSummary?: string; refId: string; tokenEstimate: number }
```

### 1.4 MemoryReference

跨会话恢复时重新加载 LTM 上下文所需的关键引用。

```ts
interface MemoryReference {
  sessionId?: string
  relevantEntryIds: string[]
  lastAccessTime: number
}
```

### 1.5 VersionedState

组件级状态的通用包装。CheckpointManager 不解包内部数据。

```ts
interface VersionedState {
  component: string     // 组件名 (e.g. "workflow", "tools", "memory")
  version: string       // 组件自己的版本号
  data: unknown         // 组件私有的序列化状态
  createdAt: number
}
```

### 1.6 SafePoint 枚举（复用于 executionState）

```ts
enum SafePoint {
  BeforeLLM = 'before_llm',
  AfterLLM = 'after_llm',
  AfterTool = 'after_tool',
}
```

---

## 2. 三层职责边界

### 2.1 CheckpointManager

**负责：**
- 接收 Runtime 提供的状态快照 → 组装成 Checkpoint
- 持久化 Checkpoint（通过 StorageAdapter）
- 按 taskId 或 checkpointId 加载 Checkpoint
- 加载时执行 schema compatibility check
- 维护 checkpoint 版本迭代

**不负责：**
- 生成 Agent 或 Tool 的内部状态（只接收、不解包）
- 解释 Component 私有状态的语义
- 重建 Runtime、Agent 或 Tool 实例（只返回 Checkpoint 数据）

### 2.2 Runtime

**负责：**
- 在 checkpoint 时机收集当前 execution snapshot
- 调用 CheckpointManager.save()
- 调用 CheckpointManager.load() → 使用返回数据重建 RuntimeTask
- 决定何时 checkpoint（worker 完成、pause、周期）

**不负责：**
- 解释 Component 内部状态（透传 componentStates）
- 实现持久化细节

### 2.3 Component (Memory / Tool / Workflow)

```ts
interface StatefulComponent {
  /** 导出当前状态快照（带版本号） */
  snapshot(): VersionedState

  /** 导入之前导出的状态快照 */
  restore(state: VersionedState): Promise<void>
}
```

**MemorySnapshotPlugin、ToolRuntimeSnapshotPlugin 等实现此接口。**

**负责：**
- 定义自己的 version 语义
- 导出/导入自己的状态数据
- 响应 version 不兼容（抛出可处理的错误）

**不负责：**
- 调用 CheckpointManager（违反 ADR-009 §1.1）
- 决定 checkpoint 时机

---

## 3. 恢复流程

### 3.1 恢复顺序

Restore 必须按固定顺序执行，组件恢复依赖 Runtime 容器先存在。

```
1. Validate checkpoint metadata
   验证 schemaVersion + runtimeCompatibility
   失败 → 拒绝恢复，不进入下一步

2. Create runtime/task container
   从 taskState 重建 RuntimeTask + Worker 锚点

3. Restore execution state
   从 executionState 恢复：
     a. 消息上下文（conversationContext）
     b. 工具调用状态（pendingToolCalls）
     c. 决策等待状态（pendingDecision）
   Worker 进入匹配的 SafePoint 等待状态

4. Restore memory references
   通过 memoryReference 重新加载 LTM 上下文
   （Memory 组件自身的 StatefulComponent.restore() 在此阶段）

5. Restore workflow/component states
   按 componentStates 注册顺序依次调用各组件的 restore()
   CheckpointManager 不解包 data，只分发给对应组件

6. Mark task resumable
   全部成功 → task 进入 RUNNING / WAITING_* 状态
   任一失败 → task 不进入可运行状态
```

### 3.2 失败处理

#### 原子性原则

默认恢复具有事务语义：**任意核心 component restore 失败，task 不进入 running 状态，checkpoint 不标记 consumed。**

```
核心组件: executionState, memory references
可选组件: workflow, tools（标记为 optional 的 component）

核心 restore 失败
    ↓
task → FAILED, 保留失败原因 + 恢复上下文
checkpoint → 可重新尝试恢复

可选组件 restore 失败
    ↓
仅当 component 声明了 capability flag 'allowDegradedOnRestoreFail'
且调用方显式接受降级时，才允许进入 degraded 模式
    ↓
否则 → 同核心失败处理
```

#### 不允许的默认行为

- ❌ 部分恢复后自动继续执行（默认）
- ❌ 忽略 component restore 错误
- ❌ 静默降级（无日志、无标记）

#### Rollback 策略

CheckpointManager 不需要实现业务级回滚。只需要保证：

```
开始恢复
    ↓
成功 → mark checkpoint consumed, task 可运行
失败 → discard 恢复上下文, checkpoint 保留
    ↓
调用方重试或报告错误
```

不引入 transaction manager 或两阶段提交。如果某个组件恢复产生了副作用（如重建了外部连接），由该组件自身在失败时清理。

### 3.3 检查点合并策略

- 一个 task 可以有多个 checkpoint（自动/手动）
- restore 默认使用最新 checkpoint
- 支持按 checkpointId 指定恢复

---

## 4. Tool Runtime 状态模型（本 ADR 解决 ADR-009 §1.4）

### 4.1 可恢复 vs 不可恢复

| 可恢复（进入 componentStates.tools） | 不可恢复 |
|--------|------|
| pagination cursor | 文件描述符 |
| workflow progress | 网络 socket |
| polling token | 临时缓存 |
| API 会话元数据（非连接本身） | 已关闭的 WebSocket |
| 重试计数器 | 进程级互斥锁 |

### 4.2 原则

- Checkpoint 保存 **逻辑状态**，不保存**运行资源**
- Tool 的不可恢复状态在 restore 后由 Tool 自身重建（重新连接、重新打开）
- Runtime 不假设 Tool 的 `restore()` 是瞬时完成的（允许 async）

### 4.3 ToolRuntimeSnapshotPlugin 契约

```ts
interface ToolRuntimeSnapshotPlugin extends StatefulComponent {
  /** 声明此 Tool Runtime 支持哪些工具的 state snapshot */
  supportedTools(): string[]

  /** 只保存与执行进度相关的逻辑状态 */
  snapshot(): VersionedState

  /** 恢复后，不可恢复资源由 Tool 自身重建 */
  restore(state: VersionedState): Promise<void>
}
```

---

## 5. 兼容性保证

### 5.1 CheckpointManager 承诺

- 写入的 checkpoint 版本一定在声明的 `runtimeCompatibility` 范围内
- 加载时验证 `schemaVersion` 是否兼容
- 不兼容时抛出错误，不静默恢复
- 同一个 `schemaVersion` 的 checkpoint，加载结果确定

### 5.2 Runtime 承诺

- 每次 checkpoint 时提供完整的 `executionState`
- ComponentStates 透传给相应组件，不篡改数据
- 恢复完成后恢复后的 Agent 可以立即 resume

### 5.3 Component 承诺

- `snapshot()` 返回的 `version` 与 `restore()` 接受的 `version` 语义一致
- `restore()` 对于不兼容版本抛出可识别错误
- 不可恢复的资源在 `restore()` 完成后自行重建

---

## 6. 后续步骤

1. **实现 CheckpointManager + StorageAdapter**（基于本 Contract）
2. **实现 ToolRuntimeSnapshotPlugin**（解决 ADR-009 §1.4）
3. **实现 Restore 测试**：从持久化恢复、SafePoint 续传、跨会话 resume
4. **按需进入 Scheduler / Workflow Runtime**

---

**References:**
- ADR-009 Runtime v2 Architecture Constraints — `docs/adr-009-runtime-v2-constraints.md`
- Runtime Architecture Freeze v1 — `memory/runtime-architecture-migration.md`
