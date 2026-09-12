# ADR-007：Regression Report Contract

**Status:** ✅ Design — P1.1 Contract Freeze
**Date:** 2026-07-15
**Supersedes:** None
**Superseded by:** None
**References:**
- ADR-006 — Reasoning Contract
- M4.3 Golden Schema — `docs/golden/schema-design.md`
- M4.3 Regression Policy — `docs/golden/regression-policy.md`
- Replay Runner v0.1 — `src/main/reasoning/golden/ReplayRunner.ts`

---

## Context

M4 解决了"如何保证不会退化"的问题，冻结了 Reasoning Contract、Golden Schema、Regression Policy 和 Replay Runner。M4 交付了一个可执行的 Replay 基础设施，输出 `ReplayReport` 对象，但目前该对象只有测试可以消费。

M5 要解决的问题是："如何证明正在变好？"——也就是 **Evidence-Driven Evolution**。

在 M4 输出的 Replay Result 与工程决策之间存在一个断层：

```
Replay Runner → Replay Result → ??? → 工程决策
```

`???` 就是 **Regression Report**——将 Replay 的原始输出转化为结构化证据，支持以下问题：

1. **通过率多少？** — 整体和各能力的通过/失败统计
2. **哪些能力退化？** — ThinkingPattern 级别的退化分布
3. **退化在哪里？** — 每个 case 的比对详情
4. **证据是什么？** — 完整的预期/实际输出对比
5. **趋势如何？** — 与历史版本比较（预留）
6. **上下文是什么？** — Runner 版本、Dataset 版本、Commit 信息

本 ADR 冻结 **Regression Report Contract**，在这些模块成为实现之前锁定它们的语义。

---

## Decision Scope

本 ADR 只回答一个问题：

> **Replay 的输出必须包含哪些证据，才能支持工程决策？**

本 ADR 不回答：

- Report Generator 的工程实现（P1.3）
- CLI / Markdown / JSON 渲染格式（P1.4）
- CI 集成方式（P2）
- 历史版本的存储与查询
- 退化根因自动分析（Root Cause Analysis）

---

## Frozen Contract

### 基本原则

> **Regression Report = f(ReplayResult)**

Report Generator 是 Replay Result 的纯函数。它不读取 Golden 文件、不访问文件系统、不重新执行 Replay、不依赖 Git。所有外部上下文通过参数显式注入。

### 1. 顶层契约

```typescript
/**
 * ADR-007 Frozen Contract.
 *
 * 六个信息模块：
 *   1. Summary     — 整体通过率、失败数、耗时、状态判定
 *   2. Capability  — 各能力的退化分布
 *   3. Regression  — 每个失败 case 的差异详情
 *   4. Evidence    — 每个失败 case 的完整预期/实际比对
 *   5. Trend       — 历史趋势（预留，v0.1 恒为 null）
 *   6. Metadata    — Runner 版本、Dataset 版本、Commit 上下文
 *
 * Report = f(ReplayResult) — 纯函数。
 */
export interface RegressionReport {
  reportSchemaVersion: '0.1'
  summary: SummarySection
  capability: CapabilitySection
  regression: RegressionSection
  evidence: EvidenceSection
  /** @future — v0.1 恒为 null */
  trend: TrendSection | null
  metadata: MetadataSection
}
```

### 2. 输入契约

Report Generator 的唯一输入是 Replay Result 与可选的 Commit 上下文：

```typescript
/** ReplayRunner 的输出。冻结为 ReportGenerator 的输入契约。 */
export interface ReplayResult {
  total: number
  passed: number
  failed: number
  skipped: number
  durationMs: number
  failures: ReplayFailure[]
  runnerVersion: string
  executedAt: string
}

export interface ReplayFailure {
  caseId: string
  expected: ReasoningDirective
  actual: ReasoningDirective
  diff: string   // 目前为简短字符串，如 'p: cause_effect vs hypothesis_verification'
}

/** ReportGenerator 外部注入的上下文，非自发现。 */
export interface CommitContext {
  sha: string
  branch: string
  dirty: boolean
}
```

### 3. Module 1: SummarySection

```typescript
export interface SummarySection {
  total: number           // 总 case 数
  passed: number          // 通过的 case 数
  failed: number          // 失败的 case 数
  skipped: number         // 跳过的 case 数
  durationMs: number      // 执行耗时
  passRate: number        // 0.0–1.0，passed / total
  status: 'pass' | 'fail' | 'inconclusive'
  // pass:    failed === 0 && passed > 0
  // fail:    failed > 0
  // inconclusive: passed + failed === 0
}
```

### 4. Module 2: CapabilitySection

以 ThinkingPattern 为维度，展示哪些能力退化：

```typescript
export interface CapabilityEntry {
  capability: string       // ThinkingPattern 名称，如 'cause_effect'
  failedCount: number      // 该能力失败的 case 数
  totalCount: number       // 该能力的总 case 数
  affectedCaseIds: string[] // 失败的 case ID 列表
}

export interface CapabilitySection {
  regressed: CapabilityEntry[]  // 至少有一个失败的 capability
  intact: string[]              // 零失败的 capability（用于完整性展示）
}
```

### 5. Module 3: RegressionSection

```typescript
export interface FieldDiff {
  patternChanged: boolean
  expectedPattern?: string
  actualPattern?: string
  goalsChanged: boolean
  constraintsChanged: boolean
  outputStyleChanged: boolean
}

export interface RegressionEntry {
  caseId: string
  category: string
  diffSummary: string    // 人类可读的差异描述
  fieldDiff: FieldDiff   // 结构化差异字段
}

export interface RegressionSection {
  count: number             // 失败的 case 数
  entries: RegressionEntry[] // 每个失败的 case 一个 entry
}
```

### 6. Module 4: EvidenceSection

```typescript
export interface EvidenceEntry {
  caseId: string
  category: string
  inputText: string                    // 触发该 case 的输入文本
  expected: ReasoningDirective          // Golden 中记录的预期 Directive
  actual: ReasoningDirective            // plan() 实际输出的 Directive
  diff: string                          // 人类可读的 diff 字符串
}

export interface EvidenceSection {
  entries: EvidenceEntry[]
}
```

### 7. Module 5: TrendSection（预留）

```typescript
/**
 * @future — v0.1 不实现，TrendSection 恒为 null。
 * 字段在此定义以确保未来不改变顶层 RegressionReport 结构。
 */
export interface TrendEntry {
  executedAt: string
  runnerVersion: string
  passRate: number
  total: number
  passed: number
}

export interface TrendSection {
  history: TrendEntry[]   // 按执行时间升序排列
  direction: 'improving' | 'stable' | 'declining' | 'unknown'
}
```

### 8. Module 6: MetadataSection

```typescript
export interface DatasetInfo {
  totalCases: number
  categories: Record<string, number>  // { "analysis": 12, "decision": 12, ... }
}

export interface CommitInfo {
  sha: string      // 'unknown' 缺省
  branch: string   // 'unknown' 缺省
  dirty: boolean
}

export interface MetadataSection {
  runnerVersion: string
  reportSchemaVersion: '0.1'
  goldenVersion: string       // 来自 manifest.goldenVersion
  goldenSchemaVersion: string // 如 '0.1'
  datasetInfo: DatasetInfo
  commit: CommitInfo           // 缺省时 sha/branch 为 'unknown'
  executedAt: string           // ISO 时间戳
}
```

### 9. ReportGenerator 接口

```typescript
export interface ReportGenerator {
  generate(result: ReplayResult, context?: CommitContext): RegressionReport
}
```

---

## 依赖方向

```
ReplayRunner
    ↓
ReplayResult（本 ADR 冻结）
    ↓
ReportGenerator（纯函数）
    ↓
RegressionReport（本 ADR 冻结）
    ↓
Renderers（CLI / Markdown / JSON，P1.4）
```

```
ReplayResult
    ↓
RegressionReport（= f(ReplayResult)，纯函数变换）

不依赖：
- Golden 文件系统
- 文件 I/O
- Git
- 网络
- 环境变量
```

---

## Invariants

| # | Invariant | 验证方式 |
|---|-----------|----------|
| I-1 | **Referential Transparency（引用透明）：** `∀ r, generate(r) = generate(r)`。相同 `ReplayResult` 必然产生完全相同的 `RegressionReport`。 | Contract Test |
| I-2 | **Immutability：** `generate(r)` 不修改输入 `r`。输入在调用前后保持不变。 | Contract Test |
| I-3 | ReportGenerator 不读取 Golden 文件、不访问文件系统、不重新执行 Replay、不依赖 Git。 | 代码审查 + 依赖审计 |
| I-4 | `trend` 在 v0.1 恒为 `null`。不存在任何其他代码路径填充它。 | Contract Test |
| I-5 | `summary.passRate === passed / total` 恒成立。 | Contract Test |
| I-6 | `summary.status` 由 [Status Decision Matrix](#3a-status-decision-matrix冻结) 决定（来源：ADR-007，非 Contract Tests）。 | Contract Test |
| I-7 | `regression.entries` 与 `evidence.entries` 中每条记录都有对应的 `caseId` 相互引用。 | Contract Test |
| I-8 | `capability.regressed` 中的 `affectedCaseIds` 必须是总失败 case ID 的子集。 | Contract Test |
| I-9 | ReportGenerator 只产生类型对象，不负责序列化（JSON/Markdown/CLI 是 P1.4 的职责）。 | 代码审查 |
| I-10 | CommitContext 省略时，`metadata.commit.sha` 为 `'unknown'`，`metadata.commit.branch` 为 `'unknown'`。 | Contract Test |

---

## Not Frozen

以下变更**不属于** Breaking Change，无需新的 ADR：

- ✓ 在 `EvidenceEntry` 中添加新字段（如 `stackTrace`、`errorCode`）— 该模块为输出数据容器
- ✓ 在 `MetadataSection` 中添加新字段（如 `os`、`nodeVersion`）— 元数据为运行时上下文
- ✓ 增强 `FieldDiff` 的差异细节（如添加 `outputStyleDetail`）— 差异描述可丰富
- ✓ 在 `SummarySection` 中添加便利性派生字段（如 `durationSeconds`）— 不改变现有字段语义
- ✓ 修改 `RunnerVersion` 字符串格式 — 自由字符串，无结构约束
- ✓ `regression.entries` 或 `evidence.entries` 的排序方式 — 消费者不应依赖排序
- ✓ 报告渲染格式（CLI 表格 / Markdown / JSON / HTML）— 本契约冻结的是类型对象

---

## Breaking Changes

以下操作必须通过新的 ADR 审核：

- ✗ 删除或重命名顶层模块（`summary`、`capability`、`regression`、`evidence`、`trend`、`metadata`）
- ✗ 修改 `summary.passRate` 的类型（当前为 `number`，0.0–1.0）
- ✗ 从任意 Section 接口中删除必选字段
- ✗ 将 `trend` 从 `TrendSection | null` 改为非空类型（改变空安全契约）
- ✗ 修改 `ReportGenerator.generate()` 签名（参数列表变更）
- ✗ 使 ReportGenerator 变为有状态或非纯函数（增加文件系统/Golden/Git 依赖）
- ✗ 为 `generate()` 添加破坏现有调用方的必选参数

---

## Verification

| Check | Status | Evidence |
|-------|--------|----------|
| Type Contract | ✅ 设计阶段 | `tsc --noEmit` 0 errors（P1.2 验证） |
| 纯函数不变量 | ✅ 契约定义 | P1.3 属性测试 |
| passRate 公式 | ✅ 契约定义 | P1.3 Contract Test |
| status 决策矩阵 | ✅ 契约定义 | P1.3 Contract Test |
| Trend null in v0.1 | ✅ 契约定义 | P1.3 Contract Test |
| Golden 无依赖 | ✅ 契约定义 | P1.3 代码审查 |
| CommitContext 缺省值 | ✅ 契约定义 | P1.3 Contract Test |

---

## Consequences

### Positive

1. **Contract-first 纪律。** 六个模块在实现前冻结，防止实现阶段的范围膨胀。
2. **纯函数可测试性。** ReportGenerator 只需要构造 `ReplayResult` 即可测试，无需 Runner、无需 Golden 文件。
3. **Trend 预留而非遗忘。** 完整 `TrendSection` 从第一天起接口即定型，未来无需 Schema Migration。
4. **Capability 分组为一级关注点。** 消费者可以直接回答"哪个认知能力退化？"而不需要二次处理原始 Failures。
5. **Evidence 完整可审计。** 每个失败的完整 `expected`/`actual` Directive 均可导出给外部 diff 工具。

### Negative

1. **六个模块导致契约较大。** `RegressionReport` 包含 6 个嵌套 Section，结构复杂但必要。
2. **Trend 为 stub。** `TrendSection | null` 模式清晰，但 `history` 暗示了尚不存在的追加式日志。
3. **FieldDiff 是对差异结构的一种意见。** 当前假设 ThinkingPattern 的六个维度（pattern/goals/constraints/outputStyle）是 diff 分析的正确粒度。后续 Level 2 比较可能需要扩展。

---

## Related

- [Regression Policy](../docs/golden/regression-policy.md) — 定义何为退化
- [Replay Runner](../src/main/reasoning/golden/ReplayRunner.ts) — 产生 ReplayResult
- [Golden Schema](../docs/golden/schema-design.md) — Golden Case 数据类型
- [Reasoning Directive Types](../src/main/reasoning/types.ts) — ReasoningDirective 定义
