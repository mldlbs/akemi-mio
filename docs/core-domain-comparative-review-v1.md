# Core Domain Comparative Review v1

## Tool vs Workflow

### 1. State Model

**Tool:**
```ts
type ToolState =
  | { status: 'pending';   id, tool, args?, createdAt }          // ToolPending
  | { status: 'running';   id, tool, args?, startedAt }          // ToolRunning
  | { status: 'success' | 'error' | 'timeout' | 'cancelled';    // ToolTerminal
      id, tool, args?, startedAt, endedAt, latencyMs, result?, error? }
```
- 3 个接口（ToolPending, ToolRunning, ToolTerminal），其中 ToolTerminal 共享 4 种 status
- IT 字段：`id`（唯一标识），`tool`（工具名），`args`（入参），`startedAt`/`endedAt`/`latencyMs`（时间）

**Workflow:**
```ts
type WorkflowState =
  | { status: 'pending';           runId, workflowDefId, workflowName, steps, createdAt }
  | { status: 'running';           runId, workflowDefId, workflowName, steps, createdAt, startedAt }
  | { status: 'paused';            runId, workflowDefId, workflowName, steps, createdAt, startedAt }
  | { status: 'done' | 'failed' | 'cancelled';
      runId, workflowDefId, workflowName, steps, createdAt, startedAt, endedAt, error? }
```
- 4 个接口（WorkflowPending, WorkflowRunning, WorkflowPaused, WorkflowTerminal）
- NC 字段：`runId`（唯一标识），`workflowDefId`（定义引用），`steps: StepRun[]`（子状态集合），`error?`（仅 failed）

**Verdict:** ⚠️ 同构 but not identical — 两者都是 discriminated union + per-status data，structure matches. Tool 有 `latencyMs` 而 Workflow 没有（通过差值计算），Workflow 有子状态集 `steps` 而 Tool 没有。这些差异是领域本质，不是实现偏好。

### 2. FSM

**Tool FSM：**
```
pending → running → success
                  → error
                  → timeout
                  → cancelled
```
- 6 个 status，5 条合法转换
- 终态：success / error / timeout / cancelled（不可迁移）

**Workflow FSM（Run）：**
```
pending → running → done
                  → failed
                  → cancelled
         running ↔ paused
```
- 6 个 status（共享 same count），7 条合法转换
- 终态：done / failed / cancelled（不可迁移）
- 💡 paused 增加了双向边，这是 Tool 没有的「挂起-恢复」语义

**Workflow FSM（Step）：**
```
pending → running → done
                  → failed
                  → skipped
```
- 5 个 status，4 条合法转换
- skipped 仅从 pending，done/failed 仅从 running

**Verdict:** ❌ NOT isomorphic — Tool FSM 是严格线性递进（pending → running → terminal），Workflow FSM 引入了 paused↔resumed 循环边。Step FSM 与 Tool FSM 同构（pending → running → terminal），但 Workflow State 包含 steps 作为子 FSM，形成了复合状态机，而 Tool State 是原子状态机。抽象时需要处理「简单线性 vs 复合+循环」的差异。

### 3. Transition

**Tool Events（5）：**
```ts
{ type: 'tool.started',   id, tool, args?, timestamp }
{ type: 'tool.succeeded', id, result, latencyMs, timestamp }
{ type: 'tool.failed',    id, error, latencyMs, timestamp }
{ type: 'tool.timedout',  id, latencyMs, timestamp }
{ type: 'tool.cancelled', id, latencyMs?, timestamp }
```
- 每个 event 携带 `id` 关联到工具实例
- timestamp 从外部传入（IPC adapter 层）

**Workflow Events（11）：**
```ts
// Run level:
{ type: 'workflow.created',   runId, workflowDefId, workflowName, steps, timestamp }
{ type: 'workflow.started',   runId, timestamp }
{ type: 'workflow.completed', runId, timestamp }
{ type: 'workflow.failed',    runId, error, timestamp }
{ type: 'workflow.cancelled', runId, timestamp }
{ type: 'workflow.paused',    runId, timestamp }
{ type: 'workflow.resumed',   runId, timestamp }
// Step level:
{ type: 'step.started',       runId, stepId, timestamp }
{ type: 'step.completed',     runId, stepId, agentResult, timestamp }
{ type: 'step.failed',        runId, stepId, error, timestamp }
{ type: 'step.skipped',       runId, stepId, timestamp }
```
- 两层事件（run level + step level），Tool 只有一层
- step 事件通过 `runId` 关联到父 run，`stepId` 关联到子步骤
- paused/resumed 是 Tool 没有的语义

**Verdict:** ❌ NOT isomorphic — Tool event 是单个原子操作的完整生命周期；Workflow event 分为 run 层和 step 层两个层次，step 事件不是独立领域实体而是 run 的子实体。抽象 Transition Dispatcher 时，Workflow 需要处理两步寻址（runId → stepId）。

### 4. Reducer

**Tool Reducer（内联于 store）：**
```
createPending(event)          → { status: 'pending', ... }
  → transitionToRunning(...)  → { status: 'running', ... }
  → transitionToSuccess(...)  → { status: 'success', startedAt, endedAt, latencyMs, result }
  → transitionToError(...)    → { status: 'error', ..., error }
  → transitionToTimeout(...)  → { status: 'timeout', ... }
  → transitionToCancelled(...)→ { status: 'cancelled', ..., latencyMs? }
```
- 纯函数，输入 state + event → new state
- 守卫从 state 断言运行期约束
- 副作用（undefined）: 有 1 处 `Date.now()` 回退（toolTypes.ts:139）

**Workflow Reducer（内联于 store）：**
```
createRun(event)                      → { status: 'pending', ... }
  → transitionToRunning(...)          → { status: 'running', ... }
  → transitionToDone(...)             → { status: 'done', endedAt }
  → transitionToFailed(...)           → { status: 'failed', endedAt, error }
  → transitionToCancelled(...)        → { status: 'cancelled', endedAt }
  → transitionToPaused(...)           → { status: 'paused' }
  → transitionToResumed(...)          → { status: 'running', startedAt }
  → transitionStepToRunning(...)      → steps[].status = 'running'
  → transitionStepToDone(...)         → steps[].status = 'done'
  → transitionStepToFailed(...)       → steps[].status = 'failed'
  → transitionStepToSkipped(...)      → steps[].status = 'skipped'
```
- 纯函数，输入 state + event → new state（spread 非变异）
- 守卫同样从 state 断言运行期约束
- 副作用（undefined）: 无 `Date.now()` 回退

**Verdict:** ⚠️ 部分同构 — 两者都是 `(state, event) → new state` 纯函数，签名一致。但 Workflow 的 step reducer 不是独立 reducer（它修改 `state.steps[]` 内嵌状态），而 Tool reducer 是独立实例级 reducer。如果抽象共享 Reducer 接口，需要处理「单层 vs 嵌套」的差异。

### 5. Projection

**Tool：**
- `isToolActive(state)` → `status === 'pending' || status === 'running'`
- UI 通过 `tools.filter(isToolActive)` 和 `tools.filter(negate)` 派生视图
- ToolIcon 通过 `switch(state.status)` 决定图标、颜色、CSS 类

**Workflow：**
- `isWorkflowActive(state)` → `status === 'pending' || status === 'running' || status === 'paused'`
- UI 通过 `workflowRuns.filter(isWorkflowActive)` 派生
- `isStepActive(state)` → `status === 'pending' || status === 'running'`
- 所有显示完全由 status 值决定

**Verdict:** ✅ isomorphic — 两者 UI 都是 `(status) → icon/color/style` 的纯投影，helper 函数仅差异在 paused 的归属上。抽象 selector 工具时，Tool 和 Workflow 共用 `array.filter()` 接口。

### 6. Replay

**Tool：**
- `ToolEvent[] → toolReducer() → ToolState[]` 需要确定性
- 当前有 1 个违规点：`transitionToCancelled` 中 `Date.now()` 回退（toolTypes.ts:139）
- ID 生成含 `Math.random()`（useTools.ts），但 reducer 不参与 ID 生成

**Workflow：**
- `WorkflowEvent[] → workflowReducer() → WorkflowState[]` 完全确定性
- 所有 reducer 无条件分支使用 event 中传入的值
- ID 由 main process 分配，reducer 不参与

**Verdict:** ✅ 约束一致 — 两者 Reducer 的 Replay 约束相同（纯函数、无 `Date.now()`/`Math.random()`），只是 Workflow 更严格地遵守了该约束。Tool 需要在抽象前修复 1 个违规点。

### 7. Time Model

**Tool：**
- ElapsedTimer 通过 `useClockStore`（全局 rAF）读取 `now`
- Store 中的时间戳（startedAt, endedAt, createdAt）来自 IPC adapter 的 `Date.now()`
- `latencyMs` 作为冗余字段存在 state 中（始终等于 `endedAt - startedAt`）

**Workflow：**
- 工作流计时器通过 `useClockStore`（全局 rAF）读取 `now`
- Store 中的时间戳来自 IPC adapter 的 `Date.now()`
- 没有 `latencyMs` 冗余字段，用时通过 `endedAt - startedAt` 计算

**Verdict:** ✅ isomorphic — 都用全局 `useClockStore` 做实时计时，时间戳都从外部传入，reducer 内不产生时间。Tool 多了 `latencyMs` 冗余——这是历史遗留，但可以在抽象时归一化。

### 8. Store Responsibility

**Tool（useAgentStore）：**
- 混合了 Agent 状态（agentState, pendingText, displayText, transcribed）和 Tool 状态（tools）
- Tool 领域的 entry: `addTool(event: ToolEvent)`
- 领域无关的 entry: `setAgentState`, `setPendingText`, `appendPendingText`, `setDisplayText`, `setTranscribed`, `setToolStatus`, `resetAgent`

**Workflow（useWorkflowStore）：**
- 混合了 Workflow 定义数据（definitions, loading）和 Workflow 运行时（workflowRuns）
- 领域 entry: `addWorkflowEvent(event: WorkflowEvent)`
- 领域无关的 entry: `setDefinitions`, `setLoading`

**Verdict:** ⚠️ 部分同构 — 两个 Store 都混合了领域状态和 UI/静态数据。但 Tool 的领域态被嵌入一个更大的 Agent store，而 Workflow 的领域态在独立 store 中。抽象 Domain Store 时需要考虑「是否将领域状态提取到独立的 store」——或将此视为 Integration Gap 由各 Store 自行演进。

### 9. Command Boundary

**Tool：**
- Command = 用户或 LLM 调用 MCP 工具
- 入口：`useTools.ts`（IPC adapter）
- IPC 输出：`{ type: 'tool.started' | 'tool.succeeded' | 'tool.failed' }`
- 不存在独立 Command 层（被 IPC adapter 和 store action 合并处理）

**Workflow：**
- Command = 用户创建/启动/停止工作流
- 入口：`useWorkflowDefinitions.ts`（IPC adapter）
- IPC 输出：`onWorkflowRunCreated`, `onWorkflowRunUpdated`, `onWorkflowRunStep`
- 不存在独立 Command 层（同上）

**Verdict:** ✅ 职责一致 — 两者 Command 都来自 IPC/UI，都通过 hook adapter 转为 Event。都不需要独立 Command 层（因为 IPC 事件本身就是命令的 result）。未来如果需要，两者架构都支持在 hook 层之前插入 Command 验证/转换。

---

## 汇总

| 维度 | Verdict | 说明 |
|---|---|---|
| State Model | ⚠️ 同构但不等价 | 判别联合一致；Workflow 有子状态集 steps |
| FSM | ❌ 不等构 | Tool 线性；Workflow 复合（run+step）+ 循环边（paused） |
| Transition | ❌ 不等构 | Tool 单层 5 事件；Workflow 双层 11 事件 |
| Reducer | ⚠️ 部分同构 | 签名一致；Workflow 需处理嵌套 reducer |
| Projection | ✅ 同构 | 纯 status → UI，helper 模式一致 |
| Replay | ✅ 约束一致 | 纯函数，无内部副作用（Tool 有 1 违规点） |
| Time Model | ✅ 同构 | 共用 ClockStore，时间外部传入 |
| Store Responsibility | ⚠️ 部分同构 | 都会混合领域态和静态数据，但 Store 边界不同 |
| Command Boundary | ✅ 职责一致 | 都经 IPC adapter → Event，无需独立 Command 层 |

**综合结论：**

- ✅ Semantic Equivalence：**Not passed** — FSM 和 Transition 两个核心维度不等构
  - Tool 是「原子线性状态机」；Workflow 是「复合（run+step）+ 循环（paused）」状态机
  - 将两者抽象到同一接口会在 Workflow 端产生大量条件分支（`if step level` / `if run level`）
- ⚠️ Complexity Reduction：无法通过 Semantic Equivalence 评估

**决策：停止抽象计划。保持 Tool 和 Workflow 为独立 Core Domain。**## Domain Topology 分类

Comparative Review v1 的核心发现不是「哪个领域更复杂」，而是 **两个领域的状态空间结构不同**。

Core Domain 按其状态拓扑分为三类：

### 1. Linear Aggregate（单实体线性）
- **状态空间**：单实体，无子状态
- **FSM**：纯线性递进，无循环边
- **代表**：**Tool**（pending → running → terminal）
- **Transition**：单层，事件直接对应实体生命周期
- **Reducer**：原子级，输入 state + event → new state

### 2. Composite Aggregate（聚合根 + 子状态）
- **状态空间**：聚合根管理多个子实体
- **FSM**：可能包含循环边（如 paused↔resumed）
- **代表**：**Workflow**（Run 管理多个 Step）
- **Transition**：双层，run 级事件 + step 级事件
- **Reducer**：需处理嵌套子状态

### 3. Graph Aggregate（未来 — DAG / 状态网络）
- **状态空间**：状态之间可能存在复杂依赖关系
- **候选**：Conversation（多轮上下文中的分支/回溯）、Planning（步骤依赖图）
- 尚未有实现，预留此类以待验证

### 分类的意义

> 先验证领域拓扑，再讨论共享基础设施。

抽象决策按拓扑进行：

```
Linear (Tool)  + Linear (?)  → 对照评审 → 共享 Reducer/Transition
Composite (Wf) + Composite (?) → 对照评审 → 共享 Reducer/Transition
Graph (?)     + Graph (?)      → 对照评审 → 共享 Reducer/Transition
不同拓扑                           → 保持独立实现
```

这避免了将「原子线性」和「复合聚合」强行纳入同一抽象体系。

### 已有验证

- **Linear Aggregate**：Tool ✅（已验证可行）
- **Composite Aggregate**：Workflow ✅（已验证可行）
- 两者属不同拓扑，不共享基础设施

## Abstraction Verdict

| 条件 | 结果 | 依据 |
|---|---|---|
| Rule of Two | ✅ 通过 | 两个领域独立验证了 FSM + Transition 模式 |
| Semantic Equivalence | ❌ 未通过 | FSM 复合度、Transition 层次结构不等构 |
| Complexity Reduction | 不适用 | Semantic Equivalence 未通过，不进入此评估 |
| **允许共享基础设施** | **❌ 拒绝** | |

### 推荐做法

1. **保持独立实现** — Tool 和 Workflow 各自的 FSM 类型、Store、UI 投影保持不变
2. **共享设计原则** — 第三条 `Architecture Freeze Rule` 和 `Core Domain Architecture Pattern` 作为设计指南继续适用
3. **不共享代码** — 不抽取 Reducer 基类、Transition Dispatcher、Replay Engine
4. **如果未来出现第三个领域** — 重新评估：若该领域 FSM 是线性的（像 Tool），则 Tool 可以抽象；若该领域 FSM 是复合的（像 Workflow），则 Workflow 可以抽象。只有当第三个领域的结构同时匹配两者时，才三向合并。
