# Session Memory Observation Report v3 — Phase 3 Observation Contract

| 属性 | 值 |
|---|---|
| Report ID | `sm-obs-v3-20260724-contract` |
| ADR | ADR-013 Session Memory Architecture |
| Phase | Phase 3: Context Injection |
| Base | Phase 1 ✅ / Phase 2 ✅ Closed |
| Implementation | Phase 3.1–3.4 ✅ |
| Pre‑Observation Fixes | ✅ Token budget + traceId (2026-07-24) |
| Status | **🔒 OBSERVATION CONTRACT FROZEN** — pre-admission |

---

## Phase 3 定义

> Phase 3：Context Injection (P1)
> - MemoryContextProvider 中间层
> - ChatExecutor wiring: retrieve → format → inject → refreshMemory
> - 观察 memory.context.injected / injection_skipped 事件
> - 评估注入频率、token 利用率、来源多样性

**Phase 3 是首次将 Session Memory 注入 LLM 输入的阶段。**
Phase 3 只证明 Pipeline Health。Behavioral Value 属于 Phase 4。

---

## 实现摘要

| 组件 | 状态 | 说明 |
|------|------|------|
| `MemoryContextProvider` | ✅ | 单次 retrieve + 实际 token 估算 + budget 截断 + traceId |
| `formatMemoryContextBlock` | ✅ | `<Memory Context>` 纯文本 |
| `SessionMemory.retrieve()` mode 阻断 | ✅ | 已移除 |
| `ChatExecutor` wiring | ✅ | session switch + toolLoop refresh |
| `memory.context.injected` | ✅ | EventType + Payload 已注册 |
| `memory.context.injection_skipped` | ✅ | EventType + Payload 已注册 |
| traceId 贯通 | ✅ | `buildInjectionContext(spec, traceId?)` |

### traceId 生命周期

```
一次 run() 调用
  │ rid = requestId || createRequestId()
  │
  ├── MemoryContextProvider.buildInjectionContext(spec, rid)
  │     └── emit('memory.context.injected', ..., { traceId: rid })
  │
  └── toolLoop(messages, ctx, rid, source)          ← 同一个 rid
        │
        ├── llmService.chatWithTools(messages, rid)  ← 同一个 rid
        │     └── emit('model.invoked', ..., { traceId: rid })
        │
        ├── iteration 2 ... (重试/继续)               ← 同一个 rid
        └── iteration N
```

约束：
- 一次 `run()` = 一次 injection + N 次 model call，**共享同一个 rid**
- 一个 `memory.context.injected` 可关联 **多个** `model.invoked`
- streaming 和 retry 不生成新 rid
- session 切换 = 新 `run()` = 新 rid，不会错误跨 session 关联
- 注入事件和 model 事件的关联是 **1:N**，不是 1:1，分析时注意区分

---

## Observation Contract v2

### 分层指标

```
Tier A — Pipeline Health  (Phase 3 主要目标)
  "系统工作正常"
  证明注入链路端到端可用

Tier B — Context Utilization Baseline  (Phase 3 记录，不解锁)
  "系统产生了什么规模的 injection"
  记录注入规模、来源数量、token 消耗作为 Phase 4 baseline
  不证明 Behavioral Value（需要对照实验，Phase 4）
```

### Admission Gate（开启 Observation 的条件）

Observation Window 开启前必须满足的硬条件：

| Gate | Condition | Type | Evidence |
|------|-----------|------|----------|
| G1 | TypeScript 零错误 (`src/main/`) | BUILD | `tsc --noEmit` |
| G2 | Session memory tests 23/23 pass | TEST | `vitest run` |
| G3 | MemoryContextProvider 单元测试通过 | TEST | 模拟 retrieve + 验证 |
| G4 | Pre‑Observation fix commit 已部署 | DEPLOY | `git log` |
| G5 | 确认 inject + model 事件 traceId 字段非空 | DATA | events.db 随机抽样 ≥10 条 |
| G6 | 前 10 条 injection event 人工审查 | REVIEW | 确认 source 合理、无噪声、formatter 正常 |

### Tier A — Pipeline Health（Phase 3 退出条件）

| ID | Metric | Query | Target | 判定理由 |
|----|--------|-------|--------|---------|
| A1 | `memory.context.injected` events | `COUNT(*) WHERE type='memory.context.injected'` | ≥ 100 | 证明注入发生频率，排除低流量期偶然触发 |
| A2 | `injection_skipped` rate | `skipped / (injected + skipped)` | < 20% | 降级率可控，retrieval 有效 |
| A3 | Token overflow = 0 | `tokenEstimate > 800` 的 injected events | 0 | budget 截断有效，no 接近上限 case（实测 token 可能略低于 800，但不应超过） |
| A4 | Trace correlation rate | `COUNT(DISTINCT traceId) WHERE type='memory.context.injected' AND traceId != ''` / total injected | > 95% | 注入事件可关联到 model call |
| A5 | Unique sessions injected | `COUNT(DISTINCT sessionId) WHERE type='memory.context.injected'` | ≥ 3 | 注入不限于单一会话 |
| A6 | Injection coverage per run | ratio: runs with non-empty injection / total `run()` | documented | 非硬条件：记录 baseline，用于 Phase 4 评估 |

**A1–A5 全部通过 → Pipeline Health 确认。**

### Tier B — Context Utilization Baseline (Phase 3 记录，不解锁)

记录注入规模、来源数量、token 消耗。**不证明 Behavioral Value。**
Behavioral Value 需要对照实验（injected vs skipped 条件下模型行为差异），属于 Phase 4。

| ID | Metric | Phase 3 Decision | Reasoning |
|----|--------|-----------------|-----------|
| B1 | Avg `tokenEstimate` | **Document only** | 描述注入规模，非 Behavioral Value |
| B2 | Avg `sourceSessions` | **Document only** | 来源多样性描述，非 Behavioral Value |
| B3 | Injected vs skipped response diff | **⏸ DEFERRED (Phase 4)** | 需要对照实验设计 |
| B4 | User follow-up repetition rate | **⏸ DEFERRED (Phase 4)** | 需要跨 session 行为分析 |

Phase 3 Observation 结束时必须输出：
- B1, B2 的观测指标（用于 Phase 4 baseline）
- B3, B4 作为 Known Gap 记录在退出报告中

**Phase 3 不要求 Tier B 达标才能退出。**

---

## Observation Window 流程

```
Admission Gate (G1–G6)
       ↓ 全部通过
Observation Window 🔓
       ↓ ≥7 天 + A1–A5 全部达标 + A6 documented
Pipeline Health ✅ CLOSE Phase 3
       ↓
Phase 4 Design: Behavioral Value Evaluation
```

### 关闭条件（必须全部满足）

1. **G1–G6 全部通过**（Admission Gate）
2. **A1–A5 全部达标**，连续 ≥7 天
3. **A6 基线数据已记录**（注入覆盖率 baseline）
4. **B1, B2 数据已记录**（Phase 4 baseline）
5. **B3, B4 已声明为 Known Gap**

### Observation 时长条件

非固定 48h。实际条件：

```
wait_condition: A1 ≥ 100 AND A5 ≥ 3 AND A4 > 95% AND A2 < 20%
sample_size:  injected events > 100
time_minimum: 48h (最小安全窗口)
close: wait_condition AND sample_size AND time_minimum
```

即：至少 48h + 100 次 injection + 3 个 unique session + 指标达标。

---

## 查询脚本

```bash
node scripts/query-injection-metrics.mjs
```

### 新增查询指标（与脚本同步更新）

| Section | Query |
|---------|-------|
| A3 overflow | `SELECT COUNT(*) FROM evaluation_events WHERE type='memory.context.injected' AND json_extract(payload, '$.tokenEstimate') > 800` |
| A5 unique sessions | `SELECT COUNT(DISTINCT sessionId) FROM evaluation_events WHERE type='memory.context.injected'` |
| A6 injection ratio | `SELECT type, COUNT(*) FROM evaluation_events WHERE type IN ('memory.context.injected','memory.context.injection_skipped') GROUP BY type` — 同时需计算总 `run()` 次数 |

需要在新查询中补充 `model.invoked` 和 `memory.context.injected` 的 traceId 交叉引用，计算 `1:N` 比例作为文档输出。

---

## Known Gaps（Phase 4 入口条件）

| Gap | 说明 | Phase 4 要求 |
|-----|------|-------------|
| Behavioral Value 不可判定 | Phase 3 只有注入后的 observation，无控制组 | 需要 injected/skipped 对照实验设计 |
| Attention 数据为空 | WorkingMemory 重建导致 AttentionSet 丢失，Phase 2 已 defer | 需要 FactExtractor 接入（P0） |
| Token budget 未优化 | 固定 800，可能浪费或不足 | 动态 budget（Phase 4） |
| Scoring vs injection 关系 | 高分 compaction 是否更常被注入？当前可以查但属于相关性分析 | Phase 4 因果分析 |

---

## 证据索引

- Provider: `src/main/memory/MemoryContextProvider.ts`
- Wiring: `src/main/agent/ChatExecutor.ts`
- Events: `src/main/core/evaluation/types.ts`
- Metric Script: `scripts/query-injection-metrics.mjs`
- **This Contract (v3.2):** `docs/adr-013-sm-obs-v3.md`
- Phase 2 Close: `docs/adr-013-sm-obs-v2.md`
- Phase 1 Report: `docs/adr-013-sm-obs-v1.md`
