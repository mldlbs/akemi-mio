# Program Execution — M3: Protocol Implementation

> **文档版本：** Program Execution v3
>
> **变更记录：** v3 将执行哲学从 Task-driven 升级为 Invariant-driven。与 Program Baseline v2 共同构成 M3 的完整治理框架。
>
> **Program Baseline v2** 冻结 Architecture 与 Protocol（五个层面：Ontology、Governance、Evolution、Roadmap、Implementation）。
>
> **Program Execution v3** 以四个不变量驱动 M3 的实施与验收。

---

## Governance Axioms（永久约束）

以下三条是本项目所有设计、ADR、PR、Review 的共同起点。任何讨论均可直接引用，不再重复解释原则。

1. **Architecture 冻结前，不写实现代码。**
   - 先 Observation → Analysis → ADR → Protocol Freeze

2. **Architecture 冻结后，不修改架构协议。**
   - Implementation 只负责协议落地
   - 不新增 Shared Abstraction
   - 不改变依赖方向
   - 不重新定义 Meaning

3. **任何违反 1 或 2 的需求，必须回到 Observation。**
   - 新证据 → ADR Revisit → 新 Protocol Freeze
   - 而不是在 PR 中顺手修改协议

### 演化闭环

```text
Observe
    ↓
Understand
    ↓
Decide
    ↓
Freeze
    ↓
Execute
    ↓
Observe
```

这是整个项目唯一允许的演化路径。Implementation 不承担架构探索职责。

---

## M3 定位

M3 不是一次架构设计，而是一次**工程验证**：

验证 Runtime 是否忠实实现了已冻结的 Progress Protocol。

- **唯一入口：** `docs/program-execution.md`
- **唯一目标：** 将 `ProgressAnalyzer.compute()` 部署到统一 Event Pipeline，保持 Producer Contract 和 Consumer Contract 不变
- **唯一完成标准：** 四个不变量全部满足

---

## M3: Implementation

**M3 Status: ✅ 完成 (2026-07-09)**

四个 Invariant 全部通过：
- I-1: Replay Consistency ✅ — 12 tests, 3 trace matrix
- I-2: Producer Purity ✅ — 4 tests (已有)
- I-3: Consumer Independence ✅ — 9 tests (已有)
- I-4: Zero Behavior Regression ✅ — 98/98 tests (全量)

### M3 Freeze Boundary

M3 冻结的对象是**协议与交付层**，不包含策略/消费/自适应逻辑。

```
Frozen (M3 Exit):
- EvaluationEvent schema
- ProgressSnapshot computation (progress.ts)
- ProgressObserver delivery contract（订阅→分发，不持有计算状态）
- ReplayInput contract ({ events, policyConfig })
- Producer Contract（幂等、不可变、纯函数）

Not frozen (M4 变化空间):
- Policy evaluation logic (阈值、信号权重、决策规则)
- Consumer implementations (Fitness / Reflection / Evolution)
- Adaptive strategy
- Guardrail event taxonomy (O-2)
```

**关于 Observer 状态的精确表述：**
> Observer is stateless with respect to evaluation semantics; it only maintains delivery lifecycle state.

即 `consumers[]` 和 `unsubscribe` 是生命周期状态，不是计算状态。未来加入 retry queue、batch buffer 等 delivery 增强不违反 M3，但任何影响 `compute()` 输出或引入 Observer 级缓存的改动必须回到 Observation。

### 协议基线（已冻结，不可修改）

| 资产 | 状态 |
|------|------|
| `docs/adr-003-unified-progress-observer.md` | ✅ 已冻结 |
| `src/main/core/evaluation/progress.ts` — ProgressSnapshot + ProgressAnalyzer + ProgressConsumer | ✅ 已冻结 |
| `src/main/core/evaluation/GuardrailTypes.ts` — 引用 progress.ts，无重复定义 | ✅ 已冻结 |
| Producer Contract（Pure Replay、幂等、不可变、Monotonicity） | ✅ 已冻结 |

### Step 3: ProgressObserver（Invariant-driven）

Step 3 不以代码量衡量，而以四个不变量衡量。每一步的 Exit Criteria 是某个不变量被证明成立，而非某个模块完成。

| Step | Objective | Deliverable | Exit Criteria | Status |
|------|-----------|-------------|---------------|--------|
| 3.1 | **Invariant 1: Replay Consistency** | Protocol Mapping — 确认所有实现均来源于已冻结 Protocol | 同一事件流，Replay 与 Runtime 输出完全一致 | ✅ Pass — 见 I-1 Verification (12 tests) |
| 3.2 | **Invariant 2: Producer Purity** | ProgressObserver 实现 + Producer Boundary Verification | `ProgressAnalyzer` 不因 Observer 的引入而增加状态、缓存或运行时依赖 | ✅ Pass |
| 3.3 | **Invariant 3: Consumer Independence** | Runtime Verification — 验证 Consumer 与 Producer 完全解耦 | 移除任意 Consumer，不影响 Producer 和其他 Consumer | ✅ Pass — 见 Verification Record |
| 3.4 | **Invariant 4: Zero Behavior Regression** | Governance Audit — 现有 Guardrail 行为保持不变 | Guardrail 行为与 Phase 1 保持一致，仅改变部署方式 | ✅ Pass — 全量 evaluation test suite 98/98 通过（含 I-1 新增 12 tests） |

### Step 3.2 执行结构

Step 3.2 分为两个子阶段：

**Phase A — Implementation**
- 实现 `ProgressObserver`（订阅 EventBus，分发 Snapshot 到 Consumer）
- 建立 Producer / Observer 边界（Producer 纯函数，Observer 负责调度）
- 保证 `compute()` 保持纯函数，不引入新的外部依赖
- 输出：Code + 单元测试

**Phase B — Verification**
- Producer Isolation Test：验证 `compute(events)` 不依赖系统时间、Runtime 状态、Observer、Consumer
- Producer Contract 全部满足
- Replay Consistency 保持成立
- 输出：Verification Evidence → I-2 = Pass

当四项全部满足，Step 3 完成，同时证明：

> **Runtime Integration 没有改变 Meaning Layer，只改变了 Delivery Layer。**

---

### Verification Record

每完成一个 Invariant 后在此留下验证记录。M3 的退出条件是四个 Invariant 均为 **Pass**，且具有对应的验证证据。

| Invariant | Status | Evidence | Reviewer | Date |
|-----------|--------|----------|----------|------|
| I-1: Replay Consistency | ✅ Pass | I-1 Verification (12 tests): ReplayInput={events, policyConfig} 固定输入下 pipeline 全链路 deterministic replay 验证通过。L1 snapshot toEqual, L2 decision (action/signals/reason/traceId — 排除 decidedAt), L3 runtimeAction。T-1 三种 trace (healthy/stagnant/lowOutput) 双次执行逐层一致。T-3 shuffled/reversed 排序稳定性。T-5 多 trace matrix 不互扰。详见 `i-1-replay-consistency-verification.test.ts`。 | — | 2026-07-09 |
| I-2: Producer Purity | ✅ Pass | V-1: Producer Purity (4 tests) — compute() 无 Date.now(); 同一输入等值; 无隐式状态; 仅依赖 EvaluationEvent[] | — | 2026-07-08 |
| I-3: Consumer Independence | ✅ Pass | Step D 完成：兼容层删除，Pipeline 纯 callback 路径。C-1~C-5 全部验证（9 tests）。 | — | 2026-07-08 |
| I-4: Zero Behavior Regression | ✅ Pass | I-1 新增 12 tests 后全量 evaluation test suite 98/98 通过（9 files）。Pipeline 重构仅改变 delivery 路径，未改变 Decision 语义或 Runtime 行为。所有新增 I-1 测试均为纯 fixture + replay 模式，不修改 production 代码。 | — | 2026-07-08 → 2026-07-09 |

> **注意：** Resolution Plan 完成（F-01~F-03）不等于 Invariant 验证完成。F-01~F-03 作为 Implementation Evidence 记录于此，I-2 的 Pass 状态需要等待 ProgressObserver 完成后的 Producer Boundary Verification。

> **M3 Exit = 四个 Invariant 均为 Pass，并具有对应的 Verification Record。**

---

### Verification Failure Recovery（唯一合法的失败恢复路径）

Verification 不产生设计决策，它只产生证据。

当某个 Invariant 验证失败时：

```text
Verification Fail
    │
    ▼
Observation（产生新 Facts，而非新 Protocol）
    │
    ▼
ADR Revisit（基于新证据重新决策）
    │
    ▼
New Program Baseline（新的协议冻结）
    │
    ▼
Implementation（在新 Baseline 上重新实现）
    │
    ▼
Verification
```

禁止的行为（**Governance Axioms 在此适用**）：

- ❌ 验证失败后直接修改代码绕过问题
- ❌ 验证失败后在当前 PR 中修改 Protocol
- ❌ 验证失败后降低 Invariant 标准让测试通过
- ❌ 验证失败后以"时间不足"为由跳过 Observation

唯一合法的路径是回到 Observation，经 ADR 形成新的 Baseline，再重新实现和验证。

### 完整状态机

```text
Protocol Frozen
    │
    ▼
Implementation
    │
    ▼
Verification
    ├──────────────┐
    │ Pass         │ Fail
    ▼              ▼
Evidence      Observation
    │              │
    ▼              ▼
M3 Exit        ADR Revisit
                  │
                  ▼
          New Program Baseline
                  │
                  ▼
          Implementation (re-entry)
```

每个状态只有明确的进入条件和退出条件，不存在隐式回退或跨层修改。

---

### Governance Enforcement（治理执行映射）

> **原则：任何治理规则都必须具有对应的工程执行点（Enforcement Point），否则视为未完成治理。**

当前治理模型在 Normative 层面已闭合。以下映射标识各规则当前的执行状态：

| Governance | Enforcement | Status |
|-----------|------------|--------|
| Baseline Freeze — Protocol 不可修改 | ADR 审批流程（人工） | ⚠️ 依赖人工 |
| Review Gate — 四项准入检查 | PR 模板 + Review Checklist | ⚠️ 依赖人工 |
| Verification Pass — Invariant 全部通过 | CI / Test Gate | 🔲 待建设 |
| Verification Fail — 禁止 Merge | CI Block + Merge Rule | 🔲 待建设 |
| M3 Exit — Verification Record 全部 Pass | EVR 审计 + Phase Gate | 🔲 待建设 |

> **注意：** 上表中 ⚠️ / 🔲 的条目意味着对应规则目前只有 Normative 定义，缺乏自动 Enforcement。在 Enforcement Point 到位之前，不能认为治理已封闭。这是从 Governance Definition Complete 到 Governance Closed 之间的差距。

### M3 执行策略

**策略：Normative First，Enforcement Incremental，Critical Gates Synchronized。**

即规范先闭合（已达成），执行点渐进建设，但影响治理边界的关键 Gate 必须与对应实现同步落地。

#### Enforcement 分类

| 类型 | 要求 |
|------|------|
| **Critical** — 影响治理边界（Freeze、Merge、Verification） | 与对应实现同步建设，不允许长期缺失 |
| **Optimization** — 提升效率（自动报告、统计、Dashboard） | 可在 M3 后半段补齐 |

#### 原则：No Long-lived Manual Governance

任何人工治理只能作为临时措施，必须对应一个明确的自动化迁移目标。禁止以下情况：

- ❌ 长期依赖人工 Review 代替 CI Gate
- ❌ 长期依赖口头检查代替 Verification Gate
- ❌ 长期依赖"大家记得遵守"代替 Enforcement Point

#### Enforcement 迁移路径

```text
M3 启动                    M3 中期                    M3 Exit
  │                         │                         │
  ├─ Review Gate (人工)      ├─ Review Gate (人工)      ├─ Review Gate → CI Lint
  ├─ Baseline Freeze (人工)  ├─ Baseline Freeze (人工)  ├─ Baseline Freeze (ADR审批)
  ├─ Verification (无)       ├─ Verification Pass → PR  ├─ Verification → CI Gate
  └─ EVR (无)                ├─ EVR 表格                └─ EVR → Phase Gate
                             └─ Verification Fail (人工阻
                                断)
```

即 M3 结束前，所有 Critical Gate 必须完成自动化迁移。

### 治理停止准则（Governance Stop Rule）

> **除非实施阶段产生新的 Observation，否则不新增 Governance 概念。**

防止治理持续膨胀（Governance Creep）。整个演化节奏固定为：

```text
Implement
    ↓
Observe
    ↓
ADR（如需要）
    ↓
Update Governance（如需要）
```

而不是：

```text
Implement
    ↓
继续完善 Governance
    ↓
继续完善 Governance
    ↓
再 Implement
```

### Governance Freeze Rule（阶段性冻结）

M3 期间不主动扩展治理模型。只有当实施过程中产生新的 Observation，且经 ADR 证明现有治理无法覆盖时，才允许修改治理文档并形成新的 Baseline。

```text
Implementation
      │
      ▼
Verification
      │
      ├── Pass ─────────► Evidence
      │
      └── Fail
              │
              ▼
      Observation → ADR → New Baseline
                            │
                            ▼
                    Update Governance（如需要）
```

治理冻结是阶段性的，不是绝对的。它与演化机制一致：任何修改必须有 Observation 作为前驱，不能凭空新增规则。

### Governance vs Delivery 边界

M3 的目的是验证 Protocol Implementation，而不是开发治理基础设施。

| 类型 | 是否允许成为 M3 的阻塞项 |
|------|------------------------|
| **Critical Gate** — Baseline Freeze、Review Gate、Verification Pass/Fail、M3 Exit | 是 |
| **Delivery Tooling** — Dashboard、统计、可视化、辅助报告工具 | 否 |

判断标准：**如果缺少它会破坏 Governance，则属于 Critical。否则属于 Delivery。**

> **当前 Governance 体系已达到 M3 冻结点。下一步的主要风险不再是治理设计不足，而是能否通过实施验证治理设计的有效性。**

---

### Architecture Review Gates（PR 准入）

每一个 Step 3 的 PR 必须满足以下四项检查：

- □ **New shared abstraction?** → No
- □ **Dependency direction preserved?** → Yes
- □ **Evolution Pattern followed?** → Yes
- □ **Evidence comes from Observation?** → Yes

任一回答不是预期答案 → 停止实现，进入 ADR Revisit。

---

## 当前禁止事项

- ❌ 不修改 GuardrailPolicy 阈值
- ❌ 不修改 ProgressAnalyzer 算法
- ❌ 不修改 GuardrailPipeline 流程
- ❌ 不修改 Event Schema / Metrics
- ❌ 不新增任何 Runtime 能力
- ❌ 不扩展 Coverage Domain（直到 Step 5）
- ❌ 不实现任何 Consumer（Guardrail 外的 Fitness/Reflection/Evolution）直到 ProgressObserver 稳定
- ❌ 不引入新的 Shared Abstraction
- ❌ 不修改架构协议

---

## Active Observations

| Observation | 状态 | Principal Finding |
|-------------|------|-------------------|
| v1.2 | ✅ 完成 | Guardrail MVP 在 Tool Runtime 有效；Chat Runtime 不在检测域内 |
| v1.3-post-fix | 🔄 待开始 | Guardrail 修复（reset 跨 Trace 残留 bug）部署后的 Baseline 验证 |
| O-1: Decision Delivery Contract | ✅ ADR-004 Frozen | Callback-based Decision Delivery。[AOR-001](docs/aor-001-decision-delivery-and-event-domain.md) → [ADR-004](docs/adr-004-decision-delivery-contract.md) |
| O-2: Consumer Event Domain | 🔄 Narrowed | ADR-004 已解决 Decision Channel 独立问题。Audit Event Ownership（`guardrail.*` 归属）仍待定。[AOR-001](docs/aor-001-decision-delivery-and-event-domain.md) |

---

## Decision Gates（待触发）

- [ ] Runtime Hook 成为 ChatExecutor 性能瓶颈
- [ ] Adaptive Policy 需要历史重放且 Runtime Hook 无法满足
- [ ] 新 Runtime 无法复用现有 Guardrail

### 已触发 — 进入 ADR 流程

- [x] **ADR-004: Decision Delivery Contract** — ✅ 已冻结。Callback-based Decision Delivery。[文档](docs/adr-004-decision-delivery-contract.md)

---

## Analysis Assets

`docs/analysis-manifest.md` — 6 个可复用脚本。

---

## 下一阶段预览

| 方向 | 依赖条件 |
|------|----------|
| Step 5: Chat Runtime 覆盖 | ProgressObserver 稳定 |
| Adaptive Policy | Observation 基线充足 + Architecture Pattern 迁移完成 |
| Cost Guardrail | Phase 3（独立信号） |
