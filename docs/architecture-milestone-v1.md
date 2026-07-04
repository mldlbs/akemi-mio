# Architecture Milestone v1

宣告时间：2026-07-04
分支：feat/slot-ui-refactor

## 四项成果

### 1. Observation Layer v1（Kernel）

Rederer 端 Runtime 日志和分析链路正常采集。

### 2. Tool Core Domain（Linear Aggregate）

- Discriminated Union FSM：`pending → running → success | error | timeout | cancelled`
- 纯转换函数，守卫防止非法状态迁移
- 全局 ClockStore 替代独立 rAF
- Store 单入口 `addTool(event: ToolEvent)`
- UI 全量投影：图标、颜色、CSS 完全由 status 决定

### 3. Workflow Core Domain（Composite Aggregate）

- Run 层 FSM（6 状态，含 paused↔resumed 循环边）
- Step 层 FSM（5 状态，严格的线性子状态机）
- 双层 Transition（run 级 7 事件 + step 级 4 事件）
- 全局 ClockStore 替代独立 setInterval
- Store 单入口 `addWorkflowEvent(event: WorkflowEvent)`
- WorkflowEditor 本地 state 消除，统一走 store 投影

### 4. Comparative Review v1 → Shared Infrastructure Rejected

**评审结论**：Tool（Linear Aggregate）与 Workflow（Composite Aggregate）属不同拓扑，FSM 与 Transition 不等构，Semantic Equivalence 未通过。

**产出**：
- `docs/core-domain-comparative-review-v1.md` — 9 维度对照 + 分类
- 架构记忆全面更新（`tool-fsm-and-clock-store-next-round.md`）

**最终决策**：`❌ Shared Infrastructure v1：Rejected（有证据支撑）`

## 冻结的架构成就

| 原则 | 来源 | 说明 |
|---|---|---|
| Core Domain Architecture Pattern | 默认架构模式 | Command → Transition → Reducer → State → Projection |
| Rule of Two | 抽象门槛 #1 | 至少两个领域验证模式 |
| Semantic Equivalence | 抽象门槛 #2 | 语义职责一致 |
| Complexity Reduction | 抽象门槛 #3 | 整体复杂度下降 |
| Architecture Freeze Rule | 冻结纪律 | 只有 Architecture Issue 才修改核心模型 |
| Evidence Before Abstraction | 决策纪律 | 必须基于正式的 Comparative Review |
| Domain Topology | 分类框架 | Linear / Composite / Graph 三类状态空间 |

## 后续候选方向

- **Conversation（待分类拓扑）** — 先判断属于哪一类，再对照对应领域的评审
- 任何新 Core Domain 沿用此路径：
  ```
  Problem → Domain Modeling → FSM → Runtime Validation → Comparative Review → Evidence → Architecture Decision
  ```
