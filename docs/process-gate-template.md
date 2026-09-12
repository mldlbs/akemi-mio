# Architecture Decision Process — Gate Template

**Status:** Living Document
**Purpose:** 确保每个 ADR 的生命周期 Gate 有唯一的判定目标、退出证据、和失败信号。

---

## Gate 定义

| Gate | 核心问题 | 判定目标 | 退出证据 | 失败信号 |
|------|---------|---------|---------|---------|
| **Observation** | 发生了什么？ | 问题是否定义清楚 | Observation 已收敛（不再扩展新事实） | 问题描述随讨论持续变化 |
| **Scope Review** | 是否值得形成 ADR？ | 是否需要 ADR | Scope Decision 确定：哪些进入，哪些 Defer | Scope 持续扩大，无法划定边界 |
| **Decision Research** | 有哪些可行方案？ | 决策空间是否完整 | Candidate Set 固定（Pattern A–F 枚举完成） | Review 中持续发现新方案 |
| **Closure Review** | 还能产生新方案吗？ | Freeze Decision Space | 无新增 Constraint / Pattern，D-4 Impact Matrix 补齐 | 新证据要求扩展 Research |
| **ADR** | 最终选择什么？ | 形成规范性决策 | ADR Frozen：Decision Statement + Invariants + Migration Plan | Decision 仍依赖口头讨论，无法独立判断 |
| **Migration** | 如何实现？ | 每个 Step 完成 | Step A–D 全部完成，对应代码 + 测试 | 实现偏离 ADR 的决策 |
| **Verification** | 是否实现正确？ | 满足验收标准 | I-1~I-4 全部通过（证据链完整） | 行为回归 / Invariant 不成立 |
| **Completion Review** | 可以结束了吗？ | 生命周期闭环 | Remaining Items 分类（Closed / Narrowed / Deferred） | 遗留问题未分类，无法判断是否可结束 |

---

## 约束条件

每条 Gate 只回答一个核心问题。禁止在 Gate 内部嵌入其他 Gate 的判断。

- **Observation** 不判断方案优劣
- **Scope Review** 不做 Research
- **Research** 不做决策
- **Closure Review** 不讨论方案优劣（只判断空间是否封闭）
- **ADR** 不重新开放 Research
- **Migration** 不修改 ADR
- **Verification** 不重新定义完成标准
- **Completion Review** 不重新开启 Migration

---

## 退出证据要求

每个 Gate 的退出证据必须：

1. **可审查** — 不依赖口头解释
2. **不可逆** — 同类证据不能在同 Gate 被推翻（如 Closure Review 后不应出现新 Pattern）
3. **独立于作者** — 换人审查应得到相同结论

---

## 来源于 ADR-004 的经验

- **Scope Review** 阻止了 O-2 提前进入 ADR，避免了 scope creep。这是流水线中第一个真正的质量 Gate。
- **Closure Review** 发现了 Pattern F，验证了 Decision Space 在 Review 后才真正封闭。如果没有这个 Gate，Research 可能无限扩展。
- **Narrowed > Closed。** Observation 不需要"解决"，只需要收敛到剩余的确切问题。
- **ADR 和代码的职责分离：** ADR 定义架构约束（DI-1~DI-3），代码注释定义实现前提（Pipeline=单Trace，Final Decision Only）。后者不应该被提升为 ADR 内容。

---

## 变更记录

| Date | Change |
|------|--------|
| 2026-07-09 | 初始版本，基于 ADR-004 完整闭环经验 |
