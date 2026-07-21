# Evidence → Evolution Bridge Design

> **Status:** 设计文档（不实现）
> **Baseline:** `a06e7ff`（Integration Baseline）
> **Phase:** Evidence → Evolution Pipeline Gap Analysis → 设计阶段
>
> 本文档定义 Evidence Report（M5）与 Evolution Pipeline（SelfEvolutionService）之间的
> 接线契约和架构边界。**当前不实现。** 所有类型定义、数据流、策略仅为设计约束。

---

## 1. 数据流总图

```
Runtime/M5 Replay Pipeline (离线)
         │
         ▼
  ┌──────────────┐
  │ ReplayRunner │
  └──────┬───────┘
         │ ReplayResult
         ▼
  ┌──────────────┐
  │ReportGenerator│  ← 纯函数，无 I/O
  └──────┬───────┘
         │ RegressionReport
         ▼
  ┌──────────────────┐
  │ RegressionReport  │
  │ Store (未来)      │  ← 持久化 + 历史对比
  └──────┬───────────┘
         │ 读取最新 Report
         ▼
  ┌──────────────┐
  │ EvidenceBridge│  ← 无状态桥接器
  └──────┬───────┘
         │ emit('evidence.report.ready', report)
         ▼
  ┌──────────────────┐
  │ EvidenceCollector│  ← SignalCollector 实现
  └──────┬───────────┘
         │ Problem (source:'evidence')
         ▼
  ┌──────────────────┐
  │   ProblemQueue   │  ← 现有 PipelineOrchestrator
  └──────┬───────────┘
         │
         ▼
  ┌──────────────────┐
  │ ExecutionPolicy  │  ← 通用安全层（非 Evidence 专属）
  └──────┬───────────┘
         │
    ┌────┴────┐
    │         │
  Proposal  Auto Execute
  (审核)    (低风险)
```

## 2. Evidence Problem Contract

### 2.1 Problem 扩展

现有 `Problem` 接口（`src/main/evolution/automation/types.ts`）新增 `source` 类型：

```typescript
// 现有 ProblemSource union 扩展
type ProblemSource =
  | 'tsc' | 'test' | 'lint' | 'log' | 'git' | 'runtime'
  | 'feature' | 'behavior' | 'tool' | 'tts' | 'file_organizer'
  | 'cicd' | 'memory' | 'agent'
  | 'evidence'                          // ← 新增

// Problem 新增可选字段（不破坏现有结构）
interface Problem {
  // ... 现有字段不变 ...

  /** Evidence 专有：关联的 RegressionReport ID */
  evidenceRef?: string

  /** Evidence 专有：退化类型分类 */
  evidenceType?: 'regression' | 'capability_drift' | 'performance'

  /** Evidence 专有：置信度 [0, 1] */
  confidence?: number

  /** 受影响的 ThinkingPattern */
  affectedCapability?: string
}
```

### 2.2 Problem → Evidence 映射规则

| RegressionReport 字段 | Problem 字段 | 规则 |
|---|---|---|
| `summary.passRate` | `severity` | `passRate < 0.5 → critical`，`< 0.8 → warning`，否则不生成 |
| `summary.status === 'fail'` | `severity` | 强制 `critical` |
| `capability.regressed[].capability` | `affectedCapability` | 每个退化 pattern 生成一个 Problem |
| `regression.count` | `occurrenceCount` | 失败 case 数 |
| `evidence.entries[].diff` | `context.raw` | 拼接差异详情 |
| `metadata.commit.sha` | `context.metadata` | 记录触发 Report 的 commit |
| — | `evidenceRef` | `report_${executedAt}_${commitSha}` |

### 2.3 约束

```
1. Problem 不包含修改方案
   → 只有事实描述，没有 targetFiles/expectedOutcome

2. Problem 不生成 patch
   → FixExecutor 不能直接消费 'evidence' source 的 Problem

3. Problem 的 severity 是单向衰减
   → critical → warning → info → 移除（不允许逆向升级）
   → 防止单次退化反复触发高优先级
```

**为什么 Problem 不能带修改方案：**
Evidence 回答"系统哪里变差"。修改方案是 Evolution 层（Proposal）的职责。
同一个 Evidence Problem 可能有多个候选 Proposal，由 ExecutionPolicy 评估后选择。

## 3. EvidenceCollector

### 3.1 设计约束

```
class EvidenceCollector implements SignalCollector {
  readonly name = 'evidence'
  readonly source: ProblemSource = 'evidence'

  // 不分析代码
  // 不生成 patch
  // 不调用 Executor
  // 只负责：RegressionReport → Problem[] 转换
}
```

### 3.2 运行时机

| 模式 | 触发 | 适用场景 |
|---|---|---|
| 事件驱动 | `evidence.report.ready` → 立即 collect | M5 回放完成后即时评估 |
| 周期轮询 | SelfEvolutionService scheduler tick | 定期的跨版本退化检测 |

**事件驱动优先。** EvidenceBridge emit 后，EvidenceCollector 在同一个 tick 内完成转换
并推入 ProblemQueue。不阻塞 ReplayRunner/ReportGenerator。

### 3.3 过滤规则

不是所有退化都产生 Problem：

| 情况 | 行为 |
|---|---|
| `passRate >= 0.8` 且无新增能力退化 | 不产生 Problem（健康） |
| `passRate < 0.8` 但 trend.direction === 'improving' | 产生 **info** Problem（恢复中） |
| 单一 case 失败（无 pattern 级退化） | 产生 **warning** Problem（可能 Golden 过期） |
| 新出现的有 `patternChanged` 的退化 | 产生 **critical** Problem（能力漂移） |
| 连续 3 次 report 相同退化集合 | 升级为 **critical**（系统性退化） |

### 3.4 去重规则

```
evidenceRef 去重：
  每个 RegressionReport (identified by executedAt + commitSha)
  最多生成一次 Problem 集合。

幂等性：
  同一个 report → EvidenceCollector.collect() 返回相同的 Problem[]
  （collect() 实现为纯变换，不依赖外部状态）
```

## 4. EventBridge

### 4.1 约束

```
ReportGenerator 保持纯函数
  → 不能 emit 事件
  → 不能访问 Store/EventBus

EvidenceBridge 负责桥接
  → 读取 RegressionReportStore 的最新 Report
  → emit 'evidence.report.ready' 事件
  → 无状态，不持久化
```

### 4.2 事件定义

```typescript
interface EvidenceReportReadyPayload {
  reportId: string           // report_${executedAt}_${sha}
  report: RegressionReport   // 完整 report 数据
  generatedAt: number        // 桥接时间戳
}

eventBus.emit('evidence.report.ready', {
  reportId: 'report_2026-07-21T19:00:00.000Z_a06e7ff',
  report: regressionReport,
  generatedAt: Date.now(),
})
```

### 4.3 RegressionReportStore（未来）

当前不需要实现。前 JSON Renderer 的 output + 文件存储可作为 Store 的 MVP：

```
.evidence/
  reports/
    report_${timestamp}_${sha}.json   ← JSON Renderer output
```

### 4.4 谁负责桥接

```
AppRuntime 启动顺序（未来）:

ReplayRunner (M5)
  ↓ (离线)
ReportGenerator
  ↓ JSON Renderer → 文件
  ↓ (如果 EvidenceBridge 已注册)
ReportGenerator 完成回调 → EvidenceBridge.bridge(report)
  ↓
EventBus emit 'evidence.report.ready'
  ↓
SelfEvolutionService.subscribeEvidenceReport(handler)
```

**ReportGenerator 本身不改变。** "完成回调"由外部调用方（ReplayRunner 或计划任务）触发。

## 5. ExecutionPolicy 分级

### 5.1 通用安全层

ExecutionPolicy 不是 Evidence 的附属品。
它应该是 Evolution 的通用闸门，在 `Problem → (Proposal | Execute)` 之间：

```
Problem
  ↓
Risk Assessment
  ↓
ExecutionPolicy
  ↓
Proposal  或  直接执行
```

### 5.2 三级模式

```
Level 0: 仅记录（默认）

  行为：
    Problem → ProblemQueue（仅收集）
    Proposal 不自动生成
  适用：
    首次出现的退化
    confidence < 0.6
    SelfEvolutionService 上升期（启动后首 24h）

Level 1: 建议（需审核）

  行为：
    Problem → ProposalValidator
    ProposalValidator 通过 → Proposal 保存
    ProposalValidator 不通过 → 回退 Level 0
  适用：
    能力退化（capability_drift）
    passRate < 0.8
    性能退化
  审核方式：
    Proposal 进入 planManager（状态 = 'reviewing'）
    不自动执行

Level 2: 低风险自动执行

  行为：
    Problem → Proposal (auto-generated)
    Risk Assessment 通过 → FixExecutor 执行
  适用：
    统计参数调整（采样率、观察窗口）
    配置修改（阈值、超时）
    非核心 Collector 调整
  禁止修改区域（Red Lines）：
    ─── 见 §6
```

### 5.3 Red Lines 强制执行

以下区域在任何 Level 都不允许自动修改：

```
核心认知架构   → ReasoningPlanner, PromptBuilder, Constitution
系统历史基线   → Golden Cases
Runtime 执行   → Scheduler, CheckpointManager, Resume logic
数据模型       → Schema, Migration, Event contract
安全边界       → Policy file, Access control, Permission
```

ProposalValidator.checkConstitutional() 已有部分覆盖（路径保护），需扩展为 Red Lines 规则引擎。

## 6. 禁止自动修改范围

### 6.1 硬边界（禁止任何 Level）

| 区域 | 禁止原因 | 违规处理 |
|---|---|---|
| `src/main/reasoning/` | 核心认知架构，测试未覆盖完全 | Proposal 直接被 reject |
| Golden Case 文件 | 改变基线 = 改变正确答案 | Proposal 直接被 reject |
| `src/main/scheduler/` | Runtime 执行语义 | Proposal 需人工审批 |
| `src/main/runtime/checkpoint*` | 恢复系统契约 | Proposal 需人工审批 |
| `src/main/db/schema/` | 数据模型变更 | Proposal 需人工审批 |
| Constitutional Policy | 安全边界 | Proposal 直接被 reject |

### 6.2 软边界（Level 2 不可修改）

| 区域 | 允许 Level | 原因 |
|---|---|---|
| `src/main/evolution/config/` | Level 1-2 | 进化参数调整风险低 |
| Evolution Collector/Executor | Level 1 审核 | 新增/修改收集器需审查 |
| TTS/ASR 配置 | Level 1-2 | 非核心链路 |
| `src/main/tts/piper/` | Level 1 | 声音参数涉及用户体验 |

## 7. 后续实现拆分

### Phase 0：ProblemSource + Contract（边界定义）

```
文件更改：
  src/main/evolution/automation/types.ts
    → ProblemSource union 添加 'evidence'
    → Problem 添加可选 evidenceRef/evidenceType/confidence
```

### Phase 1：EvidenceCollector

```
新增文件：
  src/main/evolution/automation/EvidenceCollector.ts
    → implements SignalCollector
    → collect() 读取 RegressionReport → Problem[]
    → 纯变换，无 I/O（除读取 Report Store）

更改文件：
  src/main/evolution/automation/index.ts
    → re-export EvidenceCollector
```

### Phase 2：EvidenceBridge

```
新增文件：
  src/main/evolution/automation/EvidenceBridge.ts
    → listen('evidence.report.ready')
    → 调用 EvidenceCollector
    → 推入 ProblemQueue

更改文件：
  src/main/evolution/SelfEvolutionService.ts
    → 订阅 'evidence.report.ready'
    → 按 scheduler 调度

  src/main/bootstrap/AppRuntime.ts
    → 在 M5 pipeline 完成后调用 EvidenceBridge
```

### Phase 3：ExecutionPolicy

```
新增文件：
  src/main/evolution/automation/ExecutionPolicy.ts
    → 分级评估
    → Red Lines 规则引擎
    → Proposal 自动生成 / 阻断

更改文件：
  src/main/evolution/automation/PipelineOrchestrator.ts
    → runOnce() 中插入 ExecutionPolicy
    → Problem → Policy → Proposal/Execute
```

### Phase 4：RegressionReportStore（可选）

```
新增目录：
  .evidence/reports/
    → JSON Renderer output

新增文件：
  src/main/evolution/automation/EvidenceStore.ts
    → 读写 report 文件
    → 历史对比支持
```

## 8. 架构不变项

```
1. ReportGenerator 始终是纯函数。不 emit 事件，不写文件。

2. PipelineOrchestrator 不直接感知 Evidence。
   它只感知 ProblemQueue 和 ExecutionPolicy。

3. EvidenceCollector 不生成修改方案。
   只做 RegressionReport → Problem[] 的转换。

4. ExecutionPolicy 是通用层，不是 Evidence 专属逻辑。
   所有 ProblemSource 共用一套安全策略。

5. 不限用现有模型。
   复用 Problem / Proposal / ProposalValidator / SignalCollector，
   不新增 EvolutionCandidate 类型或新数据库表。
```

---

## 附录：与现有抽象的关系

| 现有抽象 | 如何使用 | 不做什么 |
|---|---|---|
| `Problem` (types.ts) | 扩展 `ProblemSource` + 新增可选字段 | 不改变现有 Problem 必需字段 |
| `SignalCollector` (types.ts) | `EvidenceCollector implements SignalCollector` | 不需要新 Collector 接口 |
| `ProblemQueue` | 直接接收 Evidence Problem | 不改 Queue 逻辑 |
| `Proposal` (ProposalValidator.ts) | Policy 通过后生成，关联 evidenceRef | 不改 Proposal 结构 |
| `ProposalValidator` | 复用 checkConstitutional / checkScope | 不改 Validator 逻辑 |
| `ExecutionPolicy` | **新增**（Phase 3） | 不为 Evidence 新建专属 Policy |
| `FixExecutor` | Level 2 可消费低风险 Problem | **不**为 evidence 新增 Executor |
