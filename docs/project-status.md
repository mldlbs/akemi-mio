# Project Status — 2026-07-08

# Program Baseline v2 — 2026-07-08

```
Shared capabilities evolve in three stages:
first as facts, then as meaning, and finally as implementation.

Governance constrains dependencies,
Evolution defines process,
and the Roadmap defines direction.
```

```
Immutable Events → Observation → Analysis → ADR → Protocol Freeze → Implementation → Observation
```

## Five Axes of Architecture

Program Baseline v2 将系统描述为五个互相正交的维度。每个问题属于唯一一条轴，讨论前先定位：

| 轴 | 回答的问题 | 定义 | 修改成本 |
|----|-----------|------|---------|
| **Ontology** | 系统共享什么？ | Facts → Meaning → Decision | ★★★★★ |
| **Governance** | 它们如何依赖？ | Decision → Meaning → Facts | ★★★★★ |
| **Evolution** | 新能力如何进入系统？ | 6-stage frozen process | ★★★★☆ |
| **Roadmap** | 平台将演化到哪里？ | M1 → M5 + Exit Criteria | ★★☆☆☆ |
| **Implementation** | 代码如何组织？ | 4 层工程模型 | ★☆☆☆☆ |

任何架构讨论首先回答：**它属于哪条轴？** 这决定了讨论的前提、约束和修改成本。

## Phase 1 → Phase 2 架构抽象

> **Progress 从 Guardrail 的实现细节，提升为整个演化系统的公共基础设施。**

这是 Program Baseline v2 最核心的架构变化。

| 主线 | Phase 1 | Phase 2 |
|------|---------|---------|
| **事实层** | `EvaluationEvent` 建立 | 保持不变，成为唯一事实来源 |
| **分析层** | Guardrail 专属 Progress | 提升为独立 `ProgressAnalyzer` |
| **治理层** | Guardrail MVP | Guardrail 成为第一个 Consumer |

这三条线将在未来延续：Fitness 不会重新发明 Progress，Evolution 不会重新发明 Progress，Reflection 不会重新发明 Progress。它们都建立在同一基础设施上。

## 系统架构分层（实现模型）

> 工程目录结构视角，回答"代码放在哪里"。每一层都必须遵守 Architecture Governance 的依赖规则。

```
Facts
──────────────
EvaluationEvent
Observation
──────────────
ProgressAnalyzer        ← Infrastructure
──────────────
ProgressSnapshot
──────────────
Capabilities
Guardrail / Fitness / Reflection / Evolution / Planner / ...
──────────────
Policies / Thresholds / Adaptive Logic
```

```
Facts
──────────────
EvaluationEvent
Observation
──────────────
ProgressAnalyzer        ← Infrastructure
──────────────
ProgressSnapshot
──────────────
Capabilities
Guardrail / Fitness / Reflection / Evolution / Planner / ...
```

每一层只依赖下一层，不跨层。不会出现：Guardrail 直接读 Runtime、Fitness 直接解析 Event、Reflection 自己定义 Progress。

## Current Phase

Phase 2 Protocol Freeze — ✅ 完成。Program Baseline v2 已建立。
后续 Step 3+ 为工程实现（Event Pipeline Observer），以遵循协议为目标，不改变协议定义。

### 长期价值排序（评估）

```
1. Evolution Pattern           — 如何演化
2. EvaluationEvent             — 唯一事实
3. Progress Infrastructure     — 统一语言
4. Guardrail (first consumer)  — 第一个验证者
```

### Phase 2 架构成果

```
Layer 0:  Immutable EvaluationEvent
────────────────────────────────────
Layer 1:  Progress Infrastructure  ← Phase 2 Protocol Freeze
          (Protocol Frozen)
────────────────────────────────────
Layer 2:  Observer (Engineering Implementation)
────────────────────────────────────
Layer 3:  Consumers
          Guardrail / Fitness / Reflection / Evolution
────────────────────────────────────
Layer 4:  Policies / Thresholds / Adaptive Logic
```

三个层面解耦完成：

| 层级 | Phase 1 | Phase 2 |
|------|---------|---------|
| 数据 | EvaluationEvent | EvaluationEvent（不变） |
| 分析 | GuardrailProgressAnalyzer | ProgressAnalyzer（独立基础设施） |
| 决策 | Guardrail | Guardrail / Fitness / ... Consumers |

## Program Roadmap

整个 Program 的演化方向，按**共享能力**的建立阶段组织。每个 Milestone 回答一个核心问题：**建立了什么共享能力？**

```text
M1 — Shared Facts        ✅
M2 — Shared Meaning      ✅
M3 — Shared Observer     ⏳
M4 — Shared Policy       🔮
M5 — Shared Evolution    🔮
```

### 核心原则

> **共享能力（Shared Capability）必须先成为共享语义（Shared Meaning），才能成为共享实现（Shared Runtime）。**

即：

```text
Shared Facts
        ↓
Shared Meaning
        ↓
Shared Runtime
        ↓
Shared Policy
        ↓
Shared Evolution
```

| Milestone | 核心成果 | 共享能力 | Exit Criteria | 状态 |
|-----------|----------|----------|---------------|------|
| M1: Shared Facts | EvaluationEvent, Replay, Observation v1.2 | 所有模块基于同一不可变事实流分析 | 所有 Runtime 行为均可重放为 EvaluationEvent | ✅ 冻结 |
| **M2: Shared Meaning** | **progress.ts, ADR-003, Producer Contract, Evolution Pattern** | **全系统使用同一种推进语言** | **所有 Progress 消费者共享同一 ProgressSnapshot 语义** | **✅ Program Baseline v2** |
| M3: Shared Observer | Event Pipeline Observer, Runtime Migration, Chat Runtime | 所有 Runtime 通过同一 Observer 获取 Progress | 所有 Runtime 通过统一 Observer 获得 Progress，不再自行计算 | ⏳ |
| M4: Shared Policy | 多个 Consumer 基于同一 Snapshot 独立决策 | 决策与基础设施完全解耦 | 多个 Consumer 独立消费同一 Snapshot，无重复分析逻辑 | 🔮 未来 |
| M5: Shared Evolution | 系统基于统一语义自我演化 | 治理闭环 | Policy 可基于 Observation 持续演化，且不改变协议 | 🔮 未来 |

### History（按 Commit 级别）

| Phase | 时间 | 输出 | 状态 |
|-------|------|------|------|
| Observation v1.1 | 前序 | 可信观测层建立，TraceId/SessionId/Context Attribution 验证 | ✅ 冻结 |
| Guardrail MVP | Phase 1 | GuardrailPipeline + ProgressAnalyzer + Policy | ✅ 冻结 |
| Observation v1.2 | Phase 1 | Coverage Domain 验证、Decision Saturation 确认 | ✅ 完成 |
| ADR-002 | Phase 1 | Guardrail Architecture（7 项决策） | ✅ 冻结 |
| Bug Fix: throttle 跨 Trace 残留 | Phase 1 | lastCheckedTurn 跨 Trace 残留修复 | ✅ 修复 |
| **ADR-006** | Phase 1 | **Progress Signal is infrastructure, not policy** | ✅ 冻结 |
| Phase 2 Protocol Freeze | Phase 2 | progress.ts + ADR-003 + Producer Contract + Evolution Pattern | ✅ Program Baseline v2 |

## Engineering Principles（Meta Rules）

以下为全项目的一级架构约束，后续每个 Phase 默认遵守，无需重复定义：

1. **Observation before Intervention** — 任何行为变更前必须有对应版本的 Observation 基线
2. **Decision Saturation before Architecture Change** — 架构变更前必须确认数据已收敛，而非等固定样本量
3. **ADR before Runtime Modification** — 实现前先冻结职责、边界与约束
4. **Runtime emits Facts only** — Runtime 只产生不可变 Event，不负责分析
5. **Analysis is Replayable** — 所有分析来自不可变事件流，可在历史数据上重新运行
6. **Architecture evolves through evidence** — 架构由 Observation 和 ADR 驱动，而非需求驱动

## Meta Principle

**Every shared capability must first become a shared abstraction before becoming a shared implementation.**

### 修改优先级

稳定性不是平均分布的，而是向上递增的：**越靠近共享抽象，越难修改；越靠近具体实现，越容易演化。**

| 层 | 修改成本 | 原因 |
|----|---------|------|
| Ontology | ★★★★★ | 所有共享能力的语义基础 |
| Governance | ★★★★★ | 改变整个系统依赖方向 |
| Evolution | ★★★★☆ | 改变工程流程 |
| Roadmap | ★★☆☆☆ | 调整长期目标 |
| Implementation | ★☆☆☆☆ | 最容易迭代 |

### 阶段映射
|------|----------|----------|----------|
| Evaluation | Shared Facts | EvaluationEvent | 所有 Runtime 行为可重放为不可变事件 |
| Progress | Shared Meaning | ProgressSnapshot | 所有 Consumer 共享同一推进语义 |
| **M3 →** | **Shared Observer** | **ProgressObserver** | **所有 Runtime 通过统一 Observer 获取 Progress** |
| **M4 →** | **Shared Policy** | **Consumer 独立决策** | **多个 Consumer 独立消费同一 Snapshot** |
| **M5 →** | **Shared Evolution** | **治理闭环** | **Policy 可基于 Observation 持续演化** |

这就是为什么 Phase 2 会出现 Protocol Freeze：
> **协议冻结的对象不是代码，而是共享抽象（Shared Abstraction）。共享抽象必须先冻结，共享实现才能安全引入。**

## Architecture Governance

### 三层依赖模型（治理视角）

治理视角只关心一个问题：**系统之间允许怎样依赖？**

```text
Facts
    ↑
Meaning
    ↑
Decision
```

### 唯一允许的依赖方向

```text
Decision → Meaning → Facts
```

即：
- **Decision Layer 可以消费 Meaning Layer**
- **Meaning Layer 可以消费 Facts Layer**
- **反过来不允许**

### 禁止规则

| 违规 | 表现 | 示例 |
|------|------|------|
| Meaning → Decision | Meaning 层引用 Decision 层类型 | `progress.ts` import Guardrail |
| Facts → Meaning | Facts 层引用 Meaning 层类型 | `types.ts` import Progress |
| Decision → Facts（绕过 Meaning） | Decision 层自行解释 Facts | Consumer 直接扫描 EvaluationEvent |

### 核心约束

> **Decision Layer 不得重新解释 Facts。**

所有 Consumer（Guardrail、Fitness、Reflection、Planner、Evolution）都必须通过 ProgressSnapshot 获取推进语义，不得自行扫描 EvaluationEvent 计算"进展"。这是 Progress Infrastructure 存在的根本理由——确保全系统使用**同一种推进语言**。

### 治理规则与工程模型的关系

- Architecture Governance 是**逻辑模型**，约束依赖方向（允许什么）
- Implementation Layers（见下文）是**工程模型**，组织代码位置（放哪里）
- 两者互补不冲突：工程模型中的每一层都必须遵守 Governance 的依赖规则

## Evolution Pattern（Frozen）

每个基础设施能力必须按以下阶段演化，不得跳跃或倒置。该模式经 Phase 1-2 实践验证：

```
1. Observation     — 建立基线，收集证据
2. Analysis        — 验证假设，寻找模式
3. ADR             — 冻结职责、边界、约束
4. Protocol Freeze — 确立接口与语义
5. Implementation  — 按协议实现
6. Observation     — 验证实现，开始下轮迭代
```

**规范：**
- Implementation MUST NOT precede Protocol Freeze
- Protocol Freeze 是 Architecture 与 Engineering 的分界线
- 跨越 Protocol Freeze 后，实现阶段不改变协议定义
- 本模式适用于：Fitness、Memory Evolution、Planner、Adaptive Policy 等所有未来基础设施能力

Review 一个 PR 时，对应问题：**它处于 Evolution Pattern 的第几步？**

### M3 工作纪律

Phase 2 Step 3+（ProgressObserver 实现）为 **Protocol Implementation** 阶段，必须遵守：

> **Protocol Implementation MUST NOT introduce new shared abstractions.**

M3 中可以：
- 新增 `ProgressObserver`（交付机制）
- 修改 Runtime 接入方式
- 迁移 Guardrail 到 Consumer 模式

M3 中禁止：
- 引入 `ProgressScore`、`HealthScore`、`ConfidenceGraph`、`SemanticProgress v2` 等新的 Ontology 概念
- 任何新的 Shared Abstraction 都必须重新走 Evolution Pattern（Observation → Analysis → ADR → Protocol Freeze → Implementation）

这条纪律保护刚冻结的治理模型不被实现阶段的临时需求突破。

### ADR 与 Baseline 的职责边界

- **ADR** 回答"为什么这样设计"——设计决策的理由、方案权衡、上下文
- **Baseline** 回答"系统现在遵循什么规则"——当前冻结的约束、不变量、架构

ADR 不变成规范手册，Baseline 不变成设计历史。ADR 记录了"通往规则的过程"；Baseline 记录"当前生效的规则"。两者不互相替代。

### History（按 Commit 级别）

以下组件已冻结，修改前需经 Decision Gate + 新 ADR：

### Phase 1 冻结（Guardrail MVP）

- `GuardrailPipeline.ts` — 流程
- `GuardrailProgressAnalyzer.ts` — 算法
- `GuardrailPolicy.ts` — 阈值
- `GuardrailTypes.ts` — 协议
- `types.ts` (EventType / EventPayload) — Schema
- `EvaluationEmitter.ts` — 事件输出

### Phase 2 冻结（Unified Progress Observer）

- `ADR-003` — 接口与语义（见 docs/adr-003-unified-progress-observer.md）

## Active ADRs

| ADR | 决策 | 当前 Phase |
|-----|------|------------|
| ADR-002 | Agent Progress Guardrail + Progress Signal 原则 | Phase 1 冻结 |
| ADR-003 | Unified Progress Observer 接口冻结 | Phase 2 冻结 |


