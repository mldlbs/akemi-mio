# ADR Scope Review 001

> **Phase:** M3 Step 3.3 — Post-Mapping ADR 判定
> **Date:** 2026-07-08
> **References:**
> - [AOR-001](docs/aor-001-decision-delivery-and-event-domain.md) — O-1: Decision Delivery Contract, O-2: Consumer Event Domain
> - ADR-003 — 已冻结的 Progress Observer Protocol
> - GuardrailPipeline.ts — 当前绕过 Observer 的实现

---

## Scope Review

### Observation Recap

| ID | Observation | Type | Root Cause |
|----|-------------|------|------------|
| O-1 | ADR-003 冻结了 `consume(snapshot): void`，但未定义 Decision 如何到达 Runtime | 协议空白 | ADR-003 未定义 Decision Delivery 路径 |
| O-2 | `guardrail.*` 事件作为 Consumer Observation 写入 Evaluation Event 流 | 协议空白 / 症状 | Decision 无定义承载方式 → 借用 Evaluation Event |

### Root Cause Analysis

O-1 是根因，O-2 是其派生症状。

```
Root Cause:
  Decision Delivery Contract Missing
                  │
                  ▼
  GuardrailPipeline 无法通过 Observer 路径将 Decision 送达 Runtime
                  │
                  ▼
  Pipeline 继续保留同步 analyze() 调用，绕过 Observer
                  │
                  ▼
  guardrail.checked / guardrail.terminated 通过 as any 强制写入
  Evaluation Event 流（唯一现存的 Event 通道）
                  │
                  ▼
  O-2: Event Domain 冲突显现
```

### 判定标准

> **如果 ADR-004 定义了一种新的 Decision Delivery Contract，O-2 是否自然消失？**

#### Case A（推荐 — 概率最高）

**答案：是。**

如果 ADR-004 定义独立的 Decision Channel（无论采用回调、事件流还是 mailbox）：

- `guardrail.*` 不再需要借用 Evaluation Event 流
- Consumer Observation 与 Producer Fact 自然分离
- Event Domain 问题不再存在

→ **O-2 自动关闭，无需 ADR-005。**

#### Case B

**答案：否。**

如果 ADR-004 结束后仍需明确规定：

- Evaluation Event 流可以混合多 Domain 事件
- Event Schema 的 Domain 分类规则
- Consumer Observation 的 Schema 标准

→ **O-2 升级为 ADR-005。**

### Scope Decision

| Observation | ADR | Status | Condition |
|-------------|-----|--------|-----------|
| O-1: Decision Delivery Contract | **ADR-004** | ✅ 已冻结 | — |
| O-2: Consumer Event Domain | **ADR-005** | 🔄 Narrowed | ADR-004 解决了 Decision Channel 独立，但 Audit Event Ownership 仍开放。见 [AOR-001 更新](docs/aor-001-decision-delivery-and-event-domain.md) |

### Decision Documented

> ~~ADR-005 的必要性由 ADR-004 的结果决定。在 ADR-004 完成并重新评估 O-2 之前，不启动 ADR-005。~~

**更新（2026-07-08, ADR-004 冻结后）：** O-2 被部分解决。Decision Delivery 已脱离 Evaluation Event 流（Consumer → Pipeline callback），但 `guardrail.*` Audit Event 的归属仍由 Pipeline 通过 EvaluationEmitter 处理。Audit Event Ownership 作为开放问题保留，但不阻塞 I-3 验证。当出现以下条件时可触发 ADR-005：

- 引入第二个产生结构化 Audit 输出的 Consumer
- 或 Audit Event 需要独立 Channel（如决策审计要求 Event Schema 不可混合域）

---

## 对 M3 状态的影响

| Invariant | Status | 说明 |
|-----------|--------|------|
| I-1: Replay Consistency | ⏳ Pending | 不受影响 |
| I-2: Producer Purity | ✅ Pass | 不受影响 |
| **I-3: Consumer Independence** | **🔴 Blocked** | 等待 ADR-004 冻结新 Contract 后恢复 |
| I-4: Zero Behavior Regression | ⏳ Pending | 等待 I-3 解除 Blocked |

### 依赖链

```
M3 Resume
    │
    └── I-3 = Pass
            │
            └── C-1~C-5 全部 Verifiable
                    │
                    └── ADR-003 Step 4 可实施
                            │
                            └── ADR-004 定义 Decision Delivery Contract
```

---

## 下一步

1. **ADR-004: Decision Delivery Contract** — 起草、Review、Freeze
2. **Re-evaluate O-2** — 根据 ADR-004 的结果 Close 或升级为 ADR-005
3. **恢复 M3 Step 3.3** — 在冻结的新 Baseline 上实施 Consumer Independence Verification
