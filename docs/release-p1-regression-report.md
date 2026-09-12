# P1 Release — Regression Report Infrastructure

宣告时间：2026-07-15
基线：`12eae56` (`feat/evaluation-bridge`)
前序：M4 (Closed, `98f747d`)

## 范围

完整的 Regression Report 基础设施，将 Replay 结果转化为可序列化的分析报告。

```
ReplayResult
    ↓
ReportGenerator (pure function, stateless, no I/O)
    ↓
RegressionReport (ADR-007 Contract)
    ↓
JsonRenderer (canonical JSON, byte-identical output)
```

## 交付组件

| 组件 | 文件 | 状态 |
|------|------|------|
| ADR-007 | `docs/adr-007-regression-report-contract.md` | Frozen |
| Report Types | `src/main/reasoning/golden/types.ts` | Frozen |
| Report Generator | `src/main/reasoning/golden/ReportGenerator.ts` | Accepted |
| JSON Renderer | `src/main/reasoning/golden/JsonRenderer.ts` | Accepted |
| Replay Runner | `src/main/reasoning/golden/ReplayRunner.ts` | Maintenance |
| Index | `src/main/reasoning/golden/index.ts` | Maintenance |

## Contract Tests

3 个测试文件，34 个测试用例，全部通过（0 skip）：

| File | Count | Scope |
|------|-------|-------|
| `RegressionReport.contract.test.ts` | 17 | I-1 ~ I-10 |
| `JsonRenderer.contract.test.ts` | 10 | J-1 ~ J-5 |
| `ReplayRunner.contract.test.ts` | 7 | R-1 ~ R-4 |

## 架构原则

| 原则 | 描述 |
|------|------|
| Contract is immutable | ADR-007 语义变更必须启动新的 P1.x |
| Implementation is mutable | Bug Fix / Refactor / Perf 不受限 |
| 单向依赖 | ReplayResult → Report → JSON，无反向依赖 |
| 无 Presentation 污染 | Renderer 不能参与业务计算，不能新增语义 |
| 34/34 全年绿 | 任何变更不得导致 Contract Tests 失败 |

## 冻结的不变量

| ID | 不变量 |
|----|--------|
| I-1 | ∀ r, generate(r) = generate(r) |
| I-2 | generate(r) does not mutate r |
| I-4 | trend is null in v0.1 |
| I-5 | passRate = passed / total |
| I-6 | failed=0 ∧ passed>0 → pass, failed>0 → fail, else inconclusive |
| I-7 | evidence.entries.length = regression.count |
| I-8 | capability.affectedCaseIds ⊆ failure caseIds |
| I-10 | commit defaults to unknown |
| J-5 | Canonical JSON field order — byte-identical for equal inputs |

## 后续方向

| Priority | Module | Goal |
|----------|--------|------|
| P2 | Report Presentation | Markdown/CLI Renderer—Contract first |
| P3 | CI Integration | 自动 Replay → Report → 门禁 |
| P4 | Dataset Evolution | Golden Dataset v0.2, Versioning v0.1→v0.2→v1.0 |

---

**P1 Lifecycle: Maintenance**
**Baseline: `12eae56`**
