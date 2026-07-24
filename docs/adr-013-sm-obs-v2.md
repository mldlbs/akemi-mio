# Session Memory Observation Report v2

| 属性 | 值 |
|---|---|
| Report ID | `sm-obs-v2-20260724` |
| ADR | ADR-013 Session Memory Architecture |
| Phase | Phase 2: Retrieval Quality Metrics & Ranking Evaluation |
| Base | Phase 1 Observation ✅ (sm-obs-v1) |

---

## Phase 2 定义

Per ADR-013 §Architecture Migration Path:

> Phase 2：Retrieval Ranking + Metric (P1)
>   - Scoring 公式实现（含 Attention fallback）
>   - AttentionMatch 接入 WorkingMemory
>   - 观察 retrieval hit rate / useless context rate / token reduction
>   - ∵ 仍不注入 context，只做度量评估

**Phase 2 是纯度量评估阶段，不改变模型行为。**

---

## 设计原则

1. **零行为变更** — scoring 权重不修改，mode='context' 保持阻断
2. **事件派生** — 指标从已有 `session.digest.retrieved` / `retrieved_noop` + 新增 `memory.retrieval.scored` 事件派生
3. **确定性** — 所有指标计算是 events.db 事件的纯函数
4. **非阻塞** — 事件发射失败不影响 retrieval

---

## 度量定义

### 指标一览

| # | Metric | Source | 定义 |
|---|---|---|---|
| M1 | Retrieval hit rate | `session.digest.retrieved_noop`, `session.digest.retrieved` | 有效检索数 / 总检索数 |
| M2 | Score range | `memory.retrieval.scored.scoreDistribution` | 每次检索的 min/max/avg/median 分 |
| M3 | Attention availability | `memory.retrieval.scored.attentionAvailable` | 有 attention entities 的检索占比 |
| M4 | Token utilization | `memory.retrieval.scored.tokenUtilized / tokenBudget` | token budget 使用效率 |
| M5 | Top-score gap | `memory.retrieval.scored.topScores` | #1 与 #2 的分值差距 |
| M6 | Compaction density | main.db `session_compactions / sessions` | 有 digest 的 session 比例 |
| M7 | Attention gap | `memory.scoring.attention_gap` | attention 分支 vs fallback 分支的分差 |

### 新事件类型

#### `memory.retrieval.scored`
每次 `retrieve()` 完成后发射一次。包含评分分布、token 利用率、attention 可用性。

Payload: `MemoryRetrievalScoredPayload` (`src/main/core/evaluation/types.ts`)

#### `memory.scoring.attention_gap`
当 attention 分支与 fallback 分支均可计算时发射，记录二者的分差。

Payload: `MemoryScoringAttentionGapPayload` (`src/main/core/evaluation/types.ts`)

---

## 基线 (Phase 1 Closure)

| Metric | Phase 1 Baseline | Note |
|---|---|---|
| Compaction count | 1 | observation_threshold |
| Retrieve noop rate | 35.7% | 5 noop / 14 total |
| Passive retrievals | 9 | |
| Score distribution | — | Phase 1 未采集 |

---

## 运行时证据

### 查询工具

```bash
node scripts/query-retrieval-metrics.mjs
```

读取 events.db + main.db。需要 events.db 可读（app 未运行或已 wal_checkpoint）。

### 当前指标（采集日期：Phase 2 部署后）

| Metric | Value |
|---|---|
| `memory.retrieval.scored` events | — |
| `memory.scoring.attention_gap` events | — |
| Avg score min | — |
| Avg score max | — |
| Avg score avg | — |
| Attention availability rate | — |
| Token utilization rate | — |
| Avg result count | — |
| Top-1 to top-2 avg gap | — |
| Compaction density | — |

---

## 分析：评分公式是否产生有区分度的排名？

*待填写 — 需要运行时证据积累后分析*

检查点：
1. Top-1 与 Top-2 是否有显著差距（gap > 0.05）？
2. 评分分布是否覆盖整个 [0, 1] 区间？
3. Attention 分支是否系统性地高于 Fallback 分支？
4. Token budget 是否总是被充分利用？

---

## Exit Criteria

Phase 2 退出条件（达成后 Phase 3 Context Injection 🔓 Unlocked）：

| Criteria | Target | 现状 |
|---|---|---|
| `memory.retrieval.scored` ≥ 10 | 10 | — |
| `memory.scoring.attention_gap` ≥ 1 | 1 | — |
| Score distribution differentiated | avg max - avg min > 0.1 | — |
| Hit rate documented | baseline + current | — |
| No weight changes | invariant | ✅ |
| No context injection | invariant | ✅ |

---

## 查询工具

```bash
node scripts/query-retrieval-metrics.mjs
```

## 证据索引

- ADR: `docs/adr-013-session-memory-architecture.md`
- Event Types: `src/main/core/evaluation/types.ts` (MemoryRetrievalScoredPayload, MemoryScoringAttentionGapPayload)
- Implementation: `src/main/memory/SessionMemory.ts` (emitScoringEvent)
- Metric Script: `scripts/query-retrieval-metrics.mjs`
- **This Report**: `docs/adr-013-sm-obs-v2.md`
- Phase 1 Report: `docs/adr-013-sm-obs-v1.md`
