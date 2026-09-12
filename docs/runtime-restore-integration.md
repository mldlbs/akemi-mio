# Runtime Restore Integration

**Date:** 2026-07-20
**Status:** Draft
**References:**
- ADR-009 (Runtime v2 Architecture Constraints) — `docs/adr-009-runtime-v2-constraints.md`
- ADR-010 (Checkpoint Contract) — `docs/adr-010-runtime-v2-checkpoint-contract.md`
- Architecture — `docs/runtime-restore-architecture.md`
- Finding — `docs/finding-workflow-recovery-state-gap.md`

---

## 1. AppRuntime 生命周期注入点

当前 `AppRuntime.start()` 中与 restore 基础设施相关的创建顺序（简化）：

```
Stage 1:
  255  AgentService (含 RuntimeManagerImpl 内部创建)
  265  WorkflowSchedulerV2 (依赖 AgentService.subAgentPool)
  309  setWorkflowScheduler(scheduler)        ← 全局单例就绪

Stage 2:
  319  app.whenReady()
  360  initDatabase()                         ← SQLite 可用

Stage 3:
  523  MemoryService

Stage 4:
  838  PluginLoader / MCP
  851  ConstitutionEngine

Stage 5:
  892  TaskRunner / MemoryIndexer
  940  CognitiveService

Stage 6:
  1039 LazyServiceGroup (进化/洞察/灵感等)
```

### 注入点分析

**RuntimeRestoreService 的构造依赖：**
- `CheckpointManager` → 需要 SQLite（Stage 2 后可用）
- `ComponentRegistry` → 纯内存，无外部依赖
- `WorkflowRuntimeCheckpointableComponent` → 需要 WorkflowSchedulerV2（Stage 1 后可用）
- 其他组件 descriptor → 需要对应服务就绪

**三个候选注入阶段：**

| 阶段 | 时机 | 可注册的组件 | 风险 |
|------|------|-------------|------|
| A: Stage 1 末 (line 315) | scheduler 就绪后，DB 前 | workflow-runtime | DB 未就绪，checkpoint 不能持久化 |
| B: Stage 3 末 (line 540) | DB 就绪后，Memory 就绪后 | workflow-runtime + memory? | 启动延迟增加 |
| C: Stage 6 末 (line 1095) | 全部就绪后 | 全部组件 | restore 太晚，部分服务已启动 |

**推荐方案：分两阶段注册**

```
Stage 1 末：
  创建 ComponentRegistry
  注册 workflow-runtime descriptor
  创建 RuntimeRestoreService（只注册 registry，不创建 checkpointManager）

Stage 2 末 (initDatabase 后)：
  创建 PersistentCheckpointManager（依赖 DB）
  注入到 RuntimeRestoreService
  （此时 restore 能力就绪，但不行使）

Stage 6+ (lazyInit)：
  按触发策略执行 restore
```

这保证：
- DB 就绪前 registry 已准备好
- restore 能力就绪但不自动执行
- 注册和恢复解耦

---

## 2. ComponentRegistry Ownership

当前：仅存在于测试代码。

生产环境 ownership：

```ts
// AppRuntime 持有（private 字段）
private componentRegistry: ComponentRegistryImpl

// 创建时机：Stage 1 末，scheduler 就绪后
this.componentRegistry = new ComponentRegistryImpl()
this.registerCheckpointComponents()
```

### 注册接口

```ts
private registerCheckpointComponents(): void {
  const scheduler = getWorkflowScheduler()  // setWorkflowScheduler 已经调用
  const store = workflowStore

  this.componentRegistry.register({
    id: 'workflow-runtime',
    version: '1.0',
    create: () => new WorkflowRuntimeCheckpointableComponent(scheduler, store),
  })

  // 后续扩展：
  // this.componentRegistry.register({ id: 'blog-session', ... })
  // this.componentRegistry.register({ id: 'memory-index', ... })
}
```

**谁持有引用：**
- `AppRuntime` 持有 `ComponentRegistryImpl` 实例
- `RuntimeRestoreService` 通过构造注入接收 `ComponentRegistry` 接口
- 组件 descriptor 的 `Create()` 不保留引用，每次 create 产生新实例

---

## 3. CheckpointManager Ownership

当前：`MockCheckpointManager`（仅测试）。缺少生产实现。

### 所需存储接口

`CheckpointManager` 当前 contract：

```ts
interface CheckpointManager {
  create(ctx: CheckpointContext): Promise<Checkpoint>
  save(checkpoint: Checkpoint): Promise<void>
  load(id: CheckpointId): Promise<Checkpoint>
  validate(checkpoint: Checkpoint): ValidationResult
}
```

不包含：
- `list()` / `query()` ← 需要读取所有 checkpoint 的恢复策略决定
- `delete()` ← 但暂不需要

**建议存储介质：** SQLite 文件表 `checkpoint_store`（复用 `getRawDb()`）

原因：
- initDatabase 后即可用
- 无需额外连接管理
- 与 WorkflowRuns 在同一 DB，事务一致性

### Ownership

```ts
// AppRuntime 持有
private checkpointManager: CheckpointManager

// 创建时机：Stage 2 末（initDatabase 后）
this.checkpointManager = new SqliteCheckpointManager()
```

**不归属 `AgentService`。** CheckpointManager 是基础设施，AgentService 是业务层。

---

## 4. Restore Trigger Policy

### 候选策略

| 策略 | 触发方式 | 适用场景 | 风险 |
|------|---------|---------|------|
| **显式请求** | IPC handler 调用 `restore(checkpointId)` | 用户手动恢复 | 不支持 crash recovery |
| **调度触发** | TaskRunner 定时检查 + 恢复 | 后台任务持续 | 恢复时机不可控 |
| **启动自动** | LazyInit 启动立即恢复 | crash 后的快速恢复 | 阻塞启动 / 干扰用户 |

### 推荐：分层触发

```
Layer 1: 启动不 restore（能力就绪）
  AppRuntime.start() ends without calling restore.

Layer 2: IPC 入口（用户/系统触发）
  ipc handler: 'runtime.restore' → RuntimeRestoreService.restore(id)

Layer 3（未来）: 可选自动恢复
  LazyInit service reads "pending checkpoints" from SQLite
  → 仅 restore 上一次 active 运行的 workflow
  → 不自动恢复长期 paused 的 workflow
```

### 具体规则

```
恢复触发时，RuntimeRestoreService 的行为：

1. 只接受明确指定的 checkpointId（非"全部恢复"）
2. 返回 RuntimeRestoreResult，由调用方决定下一步
3. 调用方可以是：
   - IPC handler（用户/外部请求）
   - AgentService（内部调度）
   - TaskRunner（定时任务）
```

### 不支持"全部恢复"

原因：
- 用户可能不期望所有 workflow 恢复执行
- checkpoint 可能有不同 schema 版本
- 部分 workflow 可能已过期（如昨天的分析任务）

---

## 5. Failure / Degraded 行为

### 恢复失败分类

| 阶段 | 失败场景 | 行为 | 返回 |
|------|---------|------|------|
| 1. load | checkpoint 不存在 / DB 错误 | `status: 'failed'` | 调用方记录日志 |
| 2. validate | schema 版本不兼容 / 字段缺失 | `status: 'failed'` | 调用方可选重试/跳过 |
| 3. component restore | 某组件 restore 抛出 | `status: 'failed'` | fail-fast，不执行 activation |
| 4. activation | scheduler.resumeRun 失败 | `status: 'degraded'` | 组件已恢复，但 scheduler 未恢复执行 |

### Degraded 状态定义

```
degraded:
  - checkpoint 的 component state 已全部成功 restore
  - 但 scheduler 未能接续执行
  - 调用方可选择：
    a. 重试 activation
    b. 标记为 degraded，用户后续手动触发 resumeRun
    c. 跳过（workflow 挂起）
```

### 对 AppRuntime 的影响

```
restore 失败 → 不阻塞 AppRuntime.start()
  - 日志记录失败详情
  - 不抛出异常
  - 不阻止后续 Stage 初始化
```

原因：restore 是运行时的增强能力，不是核心启动依赖。即使所有 checkpoint 不可恢复，Agent chat 功能应正常工作。

---

## 6. Legacy SessionRecoveryManager Coexistence

### 当前状态

| 维度 | SessionRecoveryManager | Runtime v2 Checkpoint |
|------|----------------------|----------------------|
| 存储介质 | JSON 文件 (snapshot.json) | SQLite (checkpoint_store) |
| 范围 | ConversationContext + PlanState | Component state (workflow-runtime + 扩展) |
| 触发 | processTextInput 入口自动 | IPC / 调度器 / 显式 |
| 用途 | 用户对话连续性 | 执行状态持久化 |
| 生命周期 | 单次会话内 | 跨会话，检查点可选择性恢复 |

### 互补边界

```
SessionRecoveryManager:
  - 保存对话历史 + 活跃计划
  - 恢复发生在：用户发送下一条消息时静默恢复
  - 用户感知：对话仿佛没中断过

Runtime v2 Checkpoint:
  - 保存 workflow 执行状态
  - 恢复发生在：IPC 请求或调度器触发
  - 用户感知：Workflow panel 恢复

重叠区：
  - 二者都可能保存"活跃计划 ID"
  - 但读取方不同：SessionRecovery 注入到 ConversationContext，
    Runtime v2 只恢复执行引擎
```

### 不合并的原因

1. **关注点分离：** SessionRecovery 关心"说到了哪儿"，Runtime v2 关心"执行到了哪儿"
2. **恢复触发不同：** 用户消息触发 vs 系统调度触发
3. **错误隔离：** Runtime v2 restore 失败不应影响对话恢复；反之亦然
4. **迁移成本：** SessionRecoveryManager 在 AgentService 内部紧耦合（614-868 行），抽出风险高

### 建议过渡方案

```
Phase 1（当前）:
  SessionRecoveryManager = 对话连续性
  Runtime v2 Checkpoint = 执行状态（尚未接）

Phase 2（接 RuntimeRestoreService 后）:
  SessionRecoveryManager 不变
  Runtime v2 Checkpoint 独立运行

Phase 3（未来）:
  如果 Runtime v2 覆盖了 SessionRecoveryManager 的用途，
  再评估合并或废弃。
```

**不在 Phase 2 修改 SessionRecoveryManager 的任何代码。** 只叠加，不动既有逻辑。

---

## 7. 实现顺序（冻结后）

```
Step 1: SqliteCheckpointManager
  - 同一 DB (getRawDb)
  - 复用 MockCheckpointManager 的 contract tests 验证
  - 不改变 CheckpointManager 接口

Step 2: RuntimeRecoveryActivator
  - 实现 RecoveryActivator
  - 调用 scheduler.resumeRun
  - 处理 plan.action (resume / register-only / skip)

Step 3: AppRuntime wiring
  - Stage 1 末: create ComponentRegistry + register workflow-runtime
  - Stage 2 末: create SqliteCheckpointManager
  - 接 RuntimeRestoreService (注入 registry + cpMgr)
  - 接 RecoveryActivator (注入 scheduler)
  - 注入 activator → RuntimeRestoreService.setActivator()

Step 4: IPC handler
  - 'runtime.restore' handler
  - 调用 RuntimeRestoreService.restore(checkpointId)
  - 返回 RuntimeRestoreResult

Step 5: End-to-end test
  - 模拟 app restart
  - checkpoint 持久化后可加载
  - restore → activation → scheduler.resumeRun
  - 验证 executeLoop 重新开始
```
