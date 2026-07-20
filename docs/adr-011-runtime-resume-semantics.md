# ADR-011: Runtime Resume Semantics v1

**Status:** Draft
**Date:** 2026-07-21
**Supersedes:** None
**Upstream Dependencies:**
- ADR-009 (Runtime v2 Architecture Constraints) — Frozen
- ADR-010 (Runtime v2 Checkpoint Contract) — Frozen

---

## Context

ADR-009/ADR-010 定义了 Runtime v2 的架构边界和 Checkpoint 契约。`e9fc33c` 是 Scheduler Resume 的首次实现——它补全了从持久化状态到执行状态恢复的最后一段链路。

在扩展更多 CheckpointableComponent 之前，需要先冻结恢复语义的边界。否则后续接入 Tool/Memory/Evolution 时会面临恢复策略不一致的风险。

### 当前恢复链路

```
CheckpointManager.load()
    ↓
RuntimeRestoreService.restore()
    ↓
CheckpointRestoreCoordinator (component restore)
    ↓
RuntimeRecoveryActivator (plan → scheduler)
    ↓
Scheduler.resumeRun()
    ↓
executeLoop (with context rebuild)
```

### 未覆盖的场景（本 ADR 明确排除）

- Tool 状态 checkpoint
- MemoryService 状态 checkpoint
- Evolution 状态 checkpoint
- 自动启动恢复策略（crash recovery）
- 并发恢复（同一 checkpoint 多实例）

---

## 1. Resume Semantics（冻结）

### 1.1 Step 级恢复策略

| 持久化状态 | resume 行为 | 说明 |
|-----------|-----------|------|
| `done` | **跳过**，不重新执行 | `ctx.steps[id] = { result: output, status: 'done' }` |
| `failed` | **重新评估**，按当前 retry policy 执行 | 重试计数器重置 |
| `skipped` | **跳过** | 不进入执行队列 |
| `pending` / `running` | **重新评估** | 视为未执行，正常调度 |

### 1.2 Retry 语义：Fresh Scheduler Session

**决策：** 进程重启后 retry counter 重置为 0。

理由：
- retry 是运行时容错机制，不是业务状态
- failed step 重启后按当前 maxRetry 策略重新执行，不累计历史重试次数
- 避免 retryCount 的跨进程序列化和一致性维护成本

**不保留的数据：**
- `executeStep` 中的 `retries` 局部变量（line 226）
- `step.retryCount` 在 DB 中保留但不用于 resume 决策

### 1.3 依赖链重建

`rebuildExecutionSteps` 从 `WorkflowStepRun[]` 恢复三组数据结构：

```
done     → completed Set + ctx.steps[stepId]
failed   → failures Set  + ctx.steps[stepId]
skipped  → skipped Set
```

后续 step 通过 `depsReady()` 检查依赖状态，通过 `resolveTemplate()` 从 `ctx.steps` 读取前置 output。依赖链是**隐式恢复**的——不显式记录 DAG，只通过 Set membership 和 ctx 键值对重建。

### 1.4 Pending Gate 恢复

gate 状态保存在 `WorkflowRun.pendingGate` 中，SQLite `workflow_runs.pending_gate` 字段完整持久化。resume 时：

```
run.status === 'paused'
    → registerRuntimeState(runId)
    → 等待外部 approveGate 调用
```

不自动恢复 gate。gate 必须由用户或外部系统重新批准。

### 1.5 Running-with-Gate 恢复

如果 checkpoint 时 gate 已触发但未批准（`run.status === 'running' && run.pendingGate`）：

```
run.status === 'paused'（executeLoop 收到 signal）
    → registerRuntimeState(runId)
    → 等待外部 approveGate
```

gate 触发后 executeLoop 立即 return。resume 时 run 在 DB 中仍为 `running`，但 `pendingGate` 存在，`RuntimeRecoveryActivator` 按 `register-only` 处理。

---

## 2. 恢复边界

### 2.1 恢复不影响的数据

| 数据 | 原因 |
|------|------|
| Agent 对话历史 | 属于 SessionRecoveryManager，不归 Runtime Checkpoint 管 |
| TTS 缓存 | 无状态服务，不需要 checkpoint |
| ASR 状态 | 无状态服务，不需要 checkpoint |
| MCP 连接 | 启动时重新建立 |
| 凭证 | credentialsManager 独立管理 |

### 2.2 恢复不影响的行为

| 行为 | 原因 |
|------|------|
| AppRuntime.start() | restore 不阻塞启动，失败也不阻断 |
| IPC `runtime:restore` | 手动触发，不做自动恢复 |
| session recovery | 两个独立链路，不交叉（见 runtime-restore-integration.md §6） |

### 2.3 失败语义

| 场景 | RestoreResult.status | 后续 |
|------|---------------------|------|
| checkpoint load 失败 | `failed` | 日志，不重试 |
| validate 失败 | `failed` | 日志，checkpoint 保留 |
| component restore 抛出 | `failed` | fail-fast，单组件不污染全局 |
| activator 抛出 | `degraded` | 数据已恢复，执行未激活，可重试 |
| resumeRun 返回 failed | `degraded` | 非抛出，可继续 |

---

## 3. 组件级恢复扩展契约

本 ADR 只为第一个实现的组件（WorkflowRuntime）冻结语义。后续组件接入时需补充独立的 ADR 或扩展本 ADR。

### 3.1 ComponentDescriptor 注册要求

```
registry.register({
  id: string          // 全局唯一，作为 componentStates 的 key
  version: string     // 组件 schema 版本
  create()            // 创建独立实例，restore 时每次调用
})
```

- registry 不持有实例，只在 restore 时 create
- create 必须产生隔离实例，不引用运行态实例
- registry 启动时注册，不动态增删

### 3.2 组件恢复顺序

当前架构中组件恢复是**并行无序**的（`for...of` 遍历 `componentStates` 对象条目）。后续如果引入依赖序，需要：

1. 在 ComponentDescriptor 中声明 `dependsOn?: string[]`
2. Coordinator 按拓扑序恢复
3. 环状依赖等于设计错误

当前不需要此机制——WorkflowRuntime 是唯一组件，不依赖其他组件。

### 3.3 扩展步骤

```
1. 定义新 ComponentDescriptor
2. 注册到 ComponentRegistry
3. 实现 snapshot()/restore()
4. 通过现有 Coordinator + RestoreService 自动接入
```

不需要修改 RestoreService、Coordinator 或 Activator。

---

## 4. 设计决策记录

### D1: retry 不持久化

**结论：** retryCount 随进程生命周期重置。

**理由：** retry 是运行时容错，不是业务状态。跨进程维护 retry counter 需要序列化运行时局部变量，收益低于成本。

### D2: 依赖链通过 ctx.steps 隐式恢复

**结论：** 不显式记录 DAG，只恢复 key-value 映射。

**理由：** WorkflowStepDef 的 `dependsOn` 已经是 DAG 的显式声明。只需要确保 `ctx.steps[key]` 存在，`depsReady()` 自动判断。显式 DAG 序列化是冗余。

### D3: 不做自动恢复

**结论：** restore 只有 IPC 入口，不在启动时自动触发。

**理由：** 见 ADR-009 §5。自动恢复引入的时间窗口问题（DB 就绪 vs 服务就绪 vs checkpoint 有效）在当前阶段不需要解决。

### D4: gate 不自动批准

**结论：** resume 后 gate 保持 pending，等待外部输入。

**理由：** gate 是用户决策点。自动批准 gate 可能造成业务逻辑错误（尤其是定时任务和人工审核场景）。

---

## 5. 验证边界

### 5.1 通过条件

```
1. Step done 后 restart → skip, not re-execute
2. Step A done → Step B reads A output after restart
3. Failed step → re-evaluated under retry policy
4. Paused gate → registerRuntimeState, not resumeRun
5. Empty run → no-op (completed/failures/skipped all empty)
```

### 5.2 测试覆盖

| 文件 | 数量 | 验证点 |
|------|------|--------|
| `WorkflowScheduler.resume.test.ts` | 9 | contract: done/failed/skipped/pending/dependency/empty |
| `E2ERestoreValidation.test.ts` | 19 | 4-scene: assembly/roundtrip/matrix/isolation |
| `RuntimeRestoreService.test.ts` | 6 | service: success/load-fail/validation-fail/concurrent |
| `CheckpointRestoreCoordinator.test.ts` | 7 | coordinator: resolve/create/restore/fail-isolation |

合计 41 测试覆盖 restore 全链路。

---

## 6. 未来方向（本 ADR 不承诺）

- **Tool state checkpoint** — 需要先明确 Tool 的 state classification（已记录在 `tool-state-classification-matrix.md`）
- **MemoryService checkpoint** — 需要 MemoryService 的 snapshot/restore 契约
- **自动 crash recovery** — 需要定义"哪些 checkpoint 应该自动恢复"的策略
- **Scheduler resume after long pause** — 当前假设重启发起立即恢复，不处理被暂停 N 小时后 WorkflowDef 已变更的场景
- **Concurrent recovery** — 当前有 in-flight guard，但不支持多实例同时恢复

---

## 7. References

- ADR-009: Runtime v2 Architecture Constraints
- ADR-010: Runtime v2 Checkpoint Contract
- `docs/runtime-restore-architecture.md`
- `docs/runtime-restore-integration.md`
- `docs/runtime-v2-checkpoint-restore-release.md`
- `docs/tool-state-classification-matrix.md`
- `docs/finding-workflow-recovery-state-gap.md`
- `e9fc33c` — Scheduler resume context rebuild
