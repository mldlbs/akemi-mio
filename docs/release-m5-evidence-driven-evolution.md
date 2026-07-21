# M5 Release Review — Evidence-Driven Evolution

**Date:** 2026-07-21
**Baseline:** `652e1ce` (`feat/evaluation-bridge`)
**Predecessor:** M4 Correctness (Closed, `98f747d`)

## 状态摘要

| 模块 | 状态 | 测试 | 边界 |
|------|------|------|------|
| P1 Regression Report Infrastructure | ✅ 冻结 | 34 tests | ADR-007 |
| P2 Report Presentation | ✅ 冻结 | 21 tests | Markdown/CLI |
| **总测试** | **55 全通过** | 0 skip, 0 regression | — |

---

## 1. M5 已交付能力

### P1 — Regression Report Infrastructure

ADR-007 定义的六模块报告契约：
- **Summary** — 通过率、状态判定、耗时
- **Capability** — ThinkingPattern 级别退化分布
- **Regression** — 每个失败 case 的差异详情（FieldDiff）
- **Evidence** — 完整的预期/实际 ReasoningDirective 比对
- **Trend** — 预留（v0.1 恒为 null）
- **Metadata** — Runner/Dataset/Commit 上下文

架构：
```
ReplayRunner
    ↓
ReplayResult
    ↓
ReportGenerator (纯函数, 无 I/O, 无 Golden 依赖)
    ↓
RegressionReport (ADR-007 契约)
```

### P2 — Report Presentation

三个渲染器，全部为纯函数（`RegressionReport → string`）：

| Renderer | 输出 | 用途 |
|----------|------|------|
| `JsonRenderer` | 规范 JSON（规范 field 顺序） | 机器解析 / 存储 / diff |
| `MarkdownRenderer` | 结构化 Markdown（表格 + 分层列表 + 代码块） | 文档 / PR / Release Evidence |
| `CliRenderer` | 终端格式（box-drawing + 紧凑行） | CI 输出 / 终端查看 |

### 关键设计约束（已验证）

```
RegressionReport
      |
      v
Renderer Layer (纯变换, 无副作用)
      |
 ┌───────────────┐
 │ Json          │  machine parseable
 │ Markdown      │  human readable
 │ CLI           │  terminal compact
 └───────────────┘
```

- √ Renderer 不参与业务逻辑
- √ Renderer 不访问文件系统
- √ Renderer 不依赖 Git/网络
- √ Renderer 不修改输入 Report
- √ 55/55 测试全部 deterministic

---

## 2. 当前明确边界

### 已排除（本版本不解决）

| 能力 | 原因 |
|------|------|
| HTML Renderer | 超出 M5 范围，需要 Web 框架或附加依赖 |
| UI Dashboard | 需要前端骨架，属于产品层 |
| 自动发布流程 | CI 属于工程基础设施（P3 候选） |
| 外部 Evaluation Service | 网络依赖，当前系统为离线自闭环 |
| Trend 分析与存储 | 需历史数据库和趋势引擎 |
| 自动代码修改 | 未经验证，有破坏风险 |

### 所有权边界

| 边界 | 所有者 | 输入 |
|------|--------|------|
| Replay → Raw Result | ReplayRunner | Golden Cases |
| Raw Result → Report | ReportGenerator | ReplayResult |
| Report → Text | Renderers | RegressionReport |
| Report → Decision | **未定义** | **P3 待定** |

**关键空缺：** Report 到 Decision 之间的管道不存在。这是 P3 的核心设计问题。

---

## 3. SelfEvolution 接入候选点

### 当前链路

```
Runtime Observation
       ↓
Golden Case Replay
       ↓
ReplayRunner
       ↓
ReportGenerator
       ↓
Renderer (人类/CI 消费)
```

### 候选接入点

```
ReportGenerator
       ↓
  ┌────┴────┐
  │         │
Renderer   EvolutionCandidate (候选)
              │
          ┌───┴───┐
          │       │
        Alert  PatchProposal
                  │
              EvolutionPipeline
                  │
              (人工审批)
```

### 哪些指标可做输入信号

| 指标 | 类型 | 自动阈值建议 |
|------|------|-------------|
| `summary.passRate < 0.8` | 退化信号 | 生成 Investigation Ticket |
| `capability.regressed` 新增 pattern | 能力漂移 | 生成 Evolution Candidate |
| `summary.status === 'fail'` | 门禁信号 | 拦截提交 |
| `summary.durationMs > 5× 基线` | 性能退化 | 生成观察记录 |
| `regression.entries` 重复 pattern | 系统性退化 | 生成 Patch Proposal |

### 哪些指标不能自动触发代码修改

| 指标 | 原因 |
|------|------|
| `fieldDiff.patternChanged` | 可能是意图改善而非退化 |
| 单个 case 失败 | 可能是 Golden 过期而非代码退化 |
| `trend.direction === 'declining'` | v0.1 中 trend 恒为 null，历史数据不足 |

---

## 4. 禁止自动化的区域（Red Lines）

| 区域 | 禁止原因 | 期望行为 |
|------|----------|----------|
| **自动修改 Golden Cases** | 改变基线 = 改变正确答案 | 必须人工批准 |
| **自动修改 ReasoningPlanner** | 核心认知架构，测试未覆盖完全 | 必须有 M4 Contract Test |
| **自动部署到生产** | M5 仅为观测系统，无安全闸 | 等待 Runtime Health Management 就绪 |
| **跳过审批生成代码 patch** | 未经验证的 evidence → patch 不可靠 | 生成 Proposal，等待人工 Review |

---

## 5. P3 启动判断依据

### 先决条件

| # | 条件 | 当前状态 | 需要 |
|---|------|----------|------|
| 1 | Report schema 稳定性声明 | ✅ 稳定 | — |
| 2 | Evidence 可被机器解析 | ✅ JSON Renderer 已提供 | — |
| 3 | 无误导性指标 | ⚠️ 部分 | 需验证 passRate 在 0.8~1.0 区间无歧义 |
| 4 | confidence / severity 字段 | ❌ 缺失 | RegressionReport 需要添加可选字段 |
| 5 | 历史证据存储 | ❌ 缺失 | 需要 TrendSection 的真实数据 |
| 6 | Patch 安全审批流程 | ❌ 缺失 | 需要定义 Evolution Gate |

### 建议决策

```
P3 不立即启动。

原因：
1. 缺失 infrastructure 前题（存储 / 安全流程）
2. 从 Evidence 到 Decision 的映射未经定义
3. 当前 Evolution Pipeline 在 Runtime v2 中已有独立链路
   （SelfEvolutionService / PipelineOrchestrator）
   插接前需评估是否重用而非新建

建议动作：
1. 冻结 M5 — Release Candidate
2. 恢复 Runtime v2 主链路推进
3. 当 Runtime Evolution Pipeline 稳定后，
   再回来评估 Evidence 是否作为输入端
```

---

## 6. 验证摘要

| 验证 | 结果 | 命令 |
|------|------|------|
| P1 Contract Tests | ✅ 34/34 | `vitest run src/main/reasoning/__tests__/RegressionReport.contract.test.ts src/main/reasoning/__tests__/JsonRenderer.contract.test.ts src/main/reasoning/__tests__/ReplayRunner.contract.test.ts` |
| P2 Contract Tests | ✅ 21/21 | `vitest run src/main/reasoning/__tests__/MarkdownRenderer.contract.test.ts src/main/reasoning/__tests__/CliRenderer.contract.test.ts` |
| 全量推理测试 | ⚠️ 5 pre-existing failures | `vitest run src/main/reasoning/__tests__/` |
| 类型检查 | ✅ TS6305 only (stale out/) | `tsc --noEmit` |

---

## 7. 发布检查清单

- [x] P1 + P2 全部测试通过
- [x] Contract 语义无破坏性变更
- [x] Renderer 边界正确（纯函数，无业务逻辑）
- [x] 工作树干净
- [x] Release Review 文档完成
- [ ] 决定 P3 是否启动（建议：不启动）
- [ ] 标签或分支标记 Release Candidate

---

**文档状态：** ✅ Release Review Complete
**下一步建议：** 冻结 M5 → 恢复 Runtime v2 主链路
