# Runtime Restore Architecture

**Date:** 2026-07-20
**Status:** Draft
**References:**
- ADR-009 (Runtime v2 Architecture Constraints) — `docs/adr-009-runtime-v2-constraints.md`
- ADR-010 (Checkpoint Contract) — `docs/adr-010-runtime-v2-checkpoint-contract.md`
- Finding — `docs/finding-workflow-recovery-state-gap.md`

---

## 1. 架构概览

```
AgentService
    |
    +-- RuntimeManagerImpl         ← task 工厂，无 checkpoint 逻辑
    |
    +-- RuntimeRestoreService      ← restore 入口，协调恢复全过程
            |
            +-- CheckpointRestoreCoordinator
                    |
                    +-- ComponentRegistry       ← descriptor 查找
                    +-- CheckpointManager       ← load / validate / save
                    +-- RuntimeCheckpointAdapter ↔ RestorePlan
```

### 分层职责

| 层 | 职责 | 不负责 |
|---|------|--------|
| `RuntimeRestoreService` | restore 入口, 日志, 错误报告 | 解释 component 状态 |
| `CheckpointRestoreCoordinator` | 编排 restore 流程，失败决策 | 创建 RuntimeTask, 理解内部语义 |
| `ComponentRegistry` | 按 id 查找 descriptor | 创建/管理 component 实例 |
| `RuntimeManagerImpl` | task CRUD | restore 逻辑 |

---

## 2. 生命周期决策

### 2.1 ComponentRegistry — application scoped

`ComponentRegistry` 不持有 component 实例，只持有 descriptor 工厂。

```ts
interface ComponentDescriptor {
  /** 组件唯一标识，作为 componentStates 的 key */
  id: string

  /** 组件 schema 版本 */
  version: string

  /** 创建独立实例。restore 时每次调用 create()，不复用 */
  create(): CheckpointableComponent
}
```

**何时填充：** `AgentService` 初始化时注册所有可用组件。

```
AgentService.start()
    ↓
registry.register(workflowDescriptor)   ← new WorkflowRuntimeDescriptor(…)
registry.register(memoryDescriptor)     ← new MemoryRuntimeDescriptor(…)
    ↓
RuntimeRestoreService(coordinator)
```

**何时查询：** restore 时根据 checkpoint 中的 `componentStates` key 查找。

### 2.2 Coordinator — session scoped

`CheckpointRestoreCoordinator` 贯穿一次 restore 全流程。成功/失败后即完成使命。

```ts
interface CheckpointRestoreCoordinator {
  restore(checkpoint: Checkpoint): Promise<RestoreResult>
}
```

创建位置：`RuntimeRestoreService.restore()` 方法内部。

```ts
class RuntimeRestoreServiceImpl implements RuntimeRestoreService {
  async restore(checkpointId: string): Promise<RestoreResult> {
    const checkpoint = await this.checkpointManager.load(checkpointId)
    const coordinator = new CheckpointRestoreCoordinator(
      this.registry,
      this.checkpointManager,
    )
    return coordinator.restore(checkpoint)
  }
}
```

### 2.3 Component 实例 — per-restore-session

restore 时通过 `descriptor.create()` 创建新实例，绝不复用运行中的实例。

```
checkpoint restore start
    ↓
descriptor = registry.resolve("workflow-runtime")
    ↓
component = descriptor.create()      ← 新实例，无运行态残留
    ↓
component.restore(state)             ← 注入 checkpoint 状态
    ↓
component → pass to RuntimeManager    ← 注册到运行时
```

**原因：**
- checkpoint restore 和当前运行态可能共存（hot restore 场景）
- 复用运行态实例可能导致状态交叉污染
- create() 时可以在 constructor 注入独立的依赖（store、scheduler 引用等）

---

## 3. 核心接口

### 3.1 RuntimeRestoreService

```ts
interface RuntimeRestoreService {
  restore(checkpointId: string): Promise<RestoreResult>
}
```

位置：`src/main/runtime/RuntimeRestoreService.ts`

职责：
- 委托 `CheckpointManager.load()` 加载 checkpoint
- 创建 `CheckpointRestoreCoordinator`
- 调用 coordinator.restore()
- 向 AgentService 报告 restore 结果

### 3.2 CheckpointRestoreCoordinator

```ts
interface CheckpointRestoreCoordinator {
  restore(checkpoint: Checkpoint): Promise<RestoreResult>
}
```

位置：作为 internal class 保持在 `RuntimeRestoreService.ts` 中，不暴露为独立模块。

职责：
- resolve components
- 按序 restore
- 失败决策

### 3.3 ComponentRegistry

```ts
interface ComponentRegistry {
  register(descriptor: ComponentDescriptor): void
  resolve(id: string): ComponentDescriptor | undefined
  list(): ComponentDescriptor[]
}
```

位置：`src/main/runtime/ComponentRegistry.ts`

---

## 4. Restore 流程

### 4.1 成功路径

```
RuntimeRestoreService.restore(checkpointId)
    |
    |── CheckpointManager.load(id) → checkpoint
    |
    |── 恢复顺序（见 ADR-010 §3.1）:
    |
    |   1. validate(checkpoint)                     ← CheckpointManager
    |         │
    |         ├── schemaVersion 兼容?   否 → return FAILED
    |         ├── runtimeCompatibility? 否 → return FAILED
    |         └── OK → step 2
    |
    |   2. resolve components                        ← ComponentRegistry
    |         │
    |         └── for each key in checkpoint.componentStates
    |               descriptor = registry.resolve(key)
    |               descriptor not found
    |                 ├── component optional → skip, log warning
    |                 └── component required → return FAILED
    |
    |   3. create & restore components              ← Coordinator
    |         │
    |         └── for each resolved descriptor
    |               instance = descriptor.create()
    |               await instance.restore(state)
    |               restore failed
    |                 ├── required → return FAILED
    |                 └── degraded allowed → continue, mark degraded
    |
    |   4. rebuild RuntimeTask                       ← RuntimeManager
    |         │
    |         └── RuntimeManager.createTask(
    |               checkpoint.taskState.name,
    |               checkpoint.taskState.metadata
    |             )
    |
    |   5. resume execution                         ← RestorePlan
    |         │
    |         └── restorePlan = RuntimeCheckpointAdapter.planRestore(checkpoint)
    |             restorePlan.resumeStrategy
    |               ├── continue → agent resume
    |               ├── wait_supervisor → set WAITING_SUPERVISOR
    |               └── retry_tool → retry last tool
    |
    └── return { status: 'ok', taskId: '...' }
```

### 4.2 失败路径

```
component restore fail
    |
    v
Coordinator
    |
    +-- component declares 'allowDegradedOnRestoreFail'
    |       AND
    |       caller accepts degraded?
    |           |
    |           YES → continue, record degraded
    |           NO  → → ↓
    |
    +-- return { status: 'failed', errors: [...] }

```

checkpoint 不标记 consumed，可重试。

### 4.3 Checkpoint consumed 语义

```
restore 结果              consumed 标记
─────────────────────     ──────────────
ok                        restore 成功 → consumed
failed                    restore 失败 → 保留，可重试
degraded                  调用方确认 degrade → consumed
```

- `consumed` 意味 checkpoint 已被消耗，不能再用于同语义的第二次恢复
- failed 时 checkpoint 保留，可以 debug 或升级后再尝试

---

## 5. 设计决策记录

### D1: Registry 不持有实例

**结论：** registry 只保存 descriptor（工厂），不保存 component 实例。

**原因：** restore 隔离性。每次 restore 创建新实例，避免与运行态交叉污染。

### D2: Coordinator 在 restore 方法内创建

**结论：** `CheckpointRestoreCoordinator` 在 `RuntimeRestoreService.restore()` 内部创建，不作为全局单例。

**原因：** coordinator 是流程编排，没有跨 restore 共享状态。方法级创建保持无状态设计。

### D3: 不向 RuntimeManagerImpl 添加 restore 逻辑

**结论：** `RuntimeManagerImpl` 保持纯 task 工厂角色。

**原因：** RuntimeManager 当前职责清晰（create/list/cancel task）。增加 restore 逻辑会引入 checkpoint 依赖。`RuntimeRestoreService` 作为新层承担恢复编排。

### D4: RestoreResult 使用 ADR-010 §3.2 的 degraded 语义

**结论：** 沿用 `RestoreResult.status: 'ok' | 'failed' | 'degraded'`。

**原因：** degraded 模式已在 ADR-010 定义，这里是实现不是重设计。

---

## 6. 位置与文件清单

```
src/main/runtime/
    ├── RuntimeRestoreService.ts         ← 新建：RuntimeRestoreService interface + impl
    ├── CheckpointRestoreCoordinator.ts  ← 新建：restore 编排（或与 RuntimeRestoreService 合并）
    ├── ComponentRegistry.ts             ← 新建：descriptor registry
    ├── RuntimeManagerImpl.ts            ← 无修改（保持纯 task 工厂）
    ├── CheckpointManager.ts             ← 已有
    ├── CheckpointTypes.ts               ← 已有（含 CheckpointableComponent, VersionedState）
    ├── RuntimeCheckpointAdapter.ts      ← 已有（RuntimeTask ↔ CheckpointContext）
    └── __tests__/
        └── RuntimeRestoreService.test.ts ← 新增
```

---

## 7. 下一阶段

设计文档审查通过 → 实现。

实现顺序：

1. `ComponentRegistry`（无外部依赖，可独立测试）
2. `CheckpointRestoreCoordinator`（依赖 registry + checkpointManager + adapter）
3. `RuntimeRestoreService`（依赖 coordinator + checkpointManager）
4. 连接 `AgentService` 初始化流程
5. 端到端 restore 测试

不提前接入 Scheduler。Scheduler 的 resume 逻辑属于 Workflow component 的内部行为，不在 Coordinator 层面触碰。
