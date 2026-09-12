# Phase 3 Pre-Audit: Current Evolution Execution Flow

> **目的：** 在实现 ExecutionPolicy 前确认当前 Problem/Proposal/Executor 的生命周期，
> 找出 ExecutionPolicy 的正确插入点。

---

## 1. 关键发现：存在两个独立的 Evolution 管道

系统当前有两套并行的 Evolution 管道，**互不感知**：

```
Pipeline A: 自动化管道 (automation/)
  SelfEvolutionService.runAnalysisCycle()
        ↓
  PipelineOrchestrator.runOnce()
        ↓
  Collector[] → ProblemQueue → FixExecutor[]
        ↓
  14 个内置 Collector／Executor

Pipeline B: 战略进化管道 (pipeline/)
  SelfEvolutionService (早期版本 / 独立分支)
        ↓
  Analyzer → Strategizer → Executor → Reviewer
        ↓
  ProposalValidator 连接
```

| 维度 | Pipeline A (automation/) | Pipeline B (pipeline/) |
|---|---|---|
| **驱动方式** | `PipelineOrchestrator.runOnce()` | LLM-driven 4 阶段流水线 |
| **输入** | `SignalCollector[]` (tsc/test/工具等) | `AnalysisInput` + `StrategyContext` |
| **中间状态** | `ProblemQueue` (JSON 持久化) | `DevPlan` (PlanManager) |
| **执行方式** | `FixExecutor.execute()` — 自动执行 | `IExecutor.executeNextStep()` — 按 plan 执行 |
| **风险控制** | 无（`tryFix` 直接跑） | `ProposalValidator` 在 Reviewer 阶段介入 |
| **是否连接 Evidence** | 否（Phase 1 刚接入 ProblemSource） | 否 |

**关键结论：** EvidenceCollector 接入的是 Pipeline A。ExecutionPolicy 必须在 Pipeline A 中插入。

---

## 2. Path 1: Problem 生命周期（Pipeline A）

```
PipelineOrchestrator.runOnce()

  Phase 1: Collect
    Collector.collect() → Problem[]
    queue.push(problems)               ← 无过滤直接入队
    queue.reconcile(source, freshIds)  ← 移除过期问题
    queue.skipCachedUnfixable()        ← 跳过已知不可修复

  Phase 2: Execute
    for (i = 0; i < maxFixesPerCycle; i++)
      problem = queue.pop()            ← 按 severity × occurrence 出队
      result = tryFix(problem)         ← 见 Path 3
      markCompleted / markFailed
```

**已检出的问题：** `pop()` 到 `tryFix()` 之间**无任何风险判断**。任何来源的 Problem 一旦入队就会自动执行（只要匹配到 executor）。

### 当前行为总结

| 步骤 | 是否有门控 | 备注 |
|---|---|---|
| Collector → Problem | ❌ 无 | 任何 Collector 都可直接将问题入队 |
| Problem → ProblemQueue | ❌ 无 | push() 仅去重，不过滤 |
| ProblemQueue → tryFix | ❌ 无 | pop() 仅按 severity 排序 |
| tryFix → Executor | ⚠️ 半门控 | 仅检查 `isAvailable()` 和 `supportedSources` |

---

## 3. Path 2: Proposal 生成位置

**Proposal 只在 Pipeline B 中存在，与 Pipeline A 无关。**

- `ProposalValidator.ts` 定义的 `Proposal` / `ProposalValidation` 类型
- `ProposalValidator` 被 `SelfEvolutionService`（Pipeline B）在 `Reviewer` 阶段使用
- `AppRuntime.ts` 创建了 `ProposalValidator` 实例，注入了 `constitutionEngine`、`planManager`、`resourceBudget`
- Pipeline A（automation/）不创建任何 `Proposal`

**结论：** Evidence Problem（Pipeline A）无法生成 Proposal。要实现 Level 1（建议），需要**在 Pipeline A 中新增 Proposal 生成能力**，或者**在 ExecutionPolicy 中连接 ProposalValidator**。

---

## 4. Path 3: FixExecutor 执行入口

```
tryFix(problem)
  │
  ├─ matching = executors.filter(e => e.supportedSources.includes(problem.source))
  │
  ├─ if (matching.length === 0)
  │     return { success: true, summary: '无执行器支持，已跳过' }
  │     ← Evidence Problem 会落在此处（无 'evidence' 支持的 executor）
  │
  └─ primary = matching[0]
       │
       ├─ if (primary.isAvailable())
       │     primary.execute(problem)
       │     ← 无风险判断，直接执行
       │
       └─ 如果主执行器失败，尝试备用
```

**关键行为：** `supportedSources` 使用 `includes(str)` 匹配，不是 enum switch。Evidence source 的 Problem 会匹配到空列表，然后**静默跳过**。这意味着目前 Evidence Problem 入队后不会有任何实际影响。

---

## 5. Path 4: Constitution 连接点

```
AppRuntime
  │
  ├─ new ConstitutionEngine()  +  setSandboxRoot()
  ├─ new ProposalValidator()
  │     .setConstitution(constitutionEngine)
  │     .setPlanManager(planManager)
  │     .setResourceBudget(resourceBudget)
  │     .setStabilityScore(stabilityScore)
  │
  └─ SelfEvolutionService (Pipeline B 中使用)
```

ProposalValidator 的 Constitution 检查覆盖：
- `checkWrite(targetFiles)` — 检查路径是否违反 Constitution（受保护路径）
- `assessRegressionRisk(targetFiles)` — 按路径模式判断风险（`core/`、`scheduler/`、`lifecycle/`、`constitution/` = high risk）
- `checkBudget(proposal)` — LLM 预算检查

**结论：** Constitution 连接已存在，但只服务于 Pipeline B。ExecutionPolicy 可以**复用 ProposalValidator**，不需要重复实现 Constitution 检查。

---

## 6. 执行策略插入点

```
当前 Pipeline A 执行流：

  ProblemQueue.pop()
       ↓
    [← ExecutionPolicy 插入点]
       ↓
    tryFix(problem)
       ↓
    markCompleted / markFailed

ExecutionPolicy 职责：
  输入: Problem
  输出: 'proceed' | 'block' | 'proposal'
  依赖: 不需要新类型，复用 Problem.severity/source
```

### 插入点推荐

```
pop()
  ↓
  ExecutionPolicy.evaluate(problem)
  │
  ├─ Level 0 (info / low confidence / evidence)
  │     → queue.markCompleted(problem.id)    // 记录，不执行
  │
  ├─ Level 1 (warning / capability_regression)
  │     → 生成 ProposalRecord（关联 evidenceRef）
  │     → 推入 PlanManager 等待 review
  │     → queue.markCompleted(problem.id)    // 已转为 Proposal，不在 ProblemQueue 重试
  │
  ├─ Level 2 (error / high confidence / known pattern)
  │     → tryFix(problem)
  │
  └─ Reject (constitution violation)
        → queue.markCompleted(problem.id)
```

### 接入现存组件

| 组件 | 如何复用 |
|---|---|
| `ProposalValidator` | Level 1 生成 Proposal 后调用 `validate()` |
| `ConstitutionEngine` | 已通过 ProposalValidator 接入 |
| `SystemStabilityScore` | 可辅助判断是否允许 Level 2 |
| `ResourceBudget` | Level 2 前检查预算 |

---

## 7. Phase 3 拆分：ABC 三阶段

### Phase 3A — Execution Gate（全局治理门）

```
ProblemQueue.pop()
        ↓
  ExecutionPolicy.evaluate(problem)
        ↓
  Level 0: 记录 → markCompleted
        ↓
  Level 1: 阻断执行 → 生成 ProposalRecord
        ↓
  Level 2: 未来开放（当前不实现）
```

**目标：** 任何 ProblemSource 必须经过 ExecutionPolicy 才能进入执行。

### Phase 3B — ProposalValidator 接线

```
ProposalRecord
        ↓
  ProposalValidator.validate()
        ↓
  ConstitutionEngine.checkWrite()
```

**目标：** 恢复 Constitution 连接，使 Level 1 的 Proposal 通过 Constitution 审查。

### Phase 3C — Evidence 接入（安全版）

```
evidence.report.ready
        ↓
  EvidenceCollector
        ↓
  ProblemQueue
        ↓
  ExecutionPolicy     ← 此时已有治理门
```

**目标：** 在 ExecutionPolicy 就绪后接入 Evidence，确保不绕过治理。

### 当前完成标准（Phase 3A）

```
ProblemQueue.pop()
        ↓
  ExecutionPolicy.evaluate(problem)
        ↓
  Level 0: 记录 → markCompleted
        ↓
  Level 1: 建议 → ProposalRecord 等待审核
        ↓
  Level 2: 保留（不实现）
        +
  所有 ProblemSource 经过策略门
        +
  现有 Pipeline A 测试不变
```

---

## 8. 决策点：复用 ProposalValidator 还是新设计

当前 `Proposal`（ProposalValidator.ts）是为 Pipeline B（LLM 驱动的 4 阶段流水线）设计的。
它需要 `targetFiles`、`risk`、`expectedOutcome`。

Evidence Problem 生成的 Proposal 可能只需要：
```
ProposalRecord {
  problemId: string
  evidenceRef: string
  category: 'regression' | 'capability_drift'
  description: string
  status: 'detected' | 'reviewing'
}
```

**建议：** 新增 `ProposalRecord` 轻量类型（非 `Proposal`），待 Level 1 需要提交到 PlanManager 时，
再由适配器转换为完整 `Proposal`。避免将 Pipeline B 的复杂类型引入 Pipeline A。
