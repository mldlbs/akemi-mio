# M4.2 Capability Baseline — Reasoning

**Status:** ✅ Accepted
**Date:** 2026-07-15
**Dependencies:**
- ADR-006 (M4.1 Reasoning Contract Freeze)
- A/B Evaluation (v2 达到本轮退出标准)

---

## Scope

本里程碑验证 Reasoning 层的回复逻辑性提升能力，包含 Benchmark、Planner、PromptBuilder 三阶段的完整闭环。

---

## Baseline Components

| Component | Status | Path |
|-----------|--------|------|
| ReasoningPlanner v2 | ✅ Stable | `src/main/reasoning/ReasoningPlanner.ts` |
| PromptBuilder v2 | ✅ Accepted | `src/main/llm/PromptBuilder.ts` |
| Benchmark v0.1 | ✅ Baseline (44 条) | `docs/benchmarks/reasoning-v0.1/` |
| Evaluation Bundle v0.1 | ✅ Baseline (12 条) | `docs/benchmarks/reasoning-v0.1/ab-evaluation-bundle.md` |
| Contract Tests | ✅ 14/14 | `src/main/reasoning/__tests__/ReasoningPlanner.contract.test.ts` |

---

## Verification Results

### Planner Benchmark (44 cases)
- Pattern hits: 44/44
- `none`: 0
- Remaining misclassifications: ~3 (design gaps, not bugs)
  - Creation category (no dedicated scoring factors)
  - Planning vs causal boundary (some overlap)

### A/B Evaluation (12 cases, blind)
- B (v2) better: 5
- A (v1) better: 3
- Tie: 3 (excluding 1 pattern=none case)
- Template risk: Mild — observed in `goal_constraint_tradeoff` pattern; mitigated with softened wording
- 结论：v2 优于或不劣于 v1，**达到本轮退出标准**

> 注：当前结论基于一轮 12 条样本的人工评测，后续扩大 Benchmark 或更换模型时应重新评估。

---

## Known Limitations

1. **Creation 分类覆盖不足** — No dedicated scoring factors; creation requests fall through to `goal_constraint_tradeoff` or `none`
2. **Template risk in goal_constraint_tradeoff** — Fixed with "don't fabricate unmentioned constraints" wording, but needs monitoring
3. **Single-turn only** — Current Planner does not track reasoning strategy across conversation turns
4. **No feedback loop** — Planner does not consume response quality signals for self-correction
5. **Benchmark 依赖人工评测** — 尚未建立自动化 Replay / Golden 回归机制

---

## Related

- ADR-006 — Reasoning Contract Freeze
- `docs/adr-006-reasoning-contract.md`
- `docs/benchmarks/reasoning-v0.1/`

---

## M4.3: Replay & Golden（已冻结）

M4.3 只负责回归保护，不再承担能力优化。三项交付物：

### 1. Golden Dataset
- Benchmark 输入（Prompt + Expected Capability）
- Golden 输出（人工审核通过的 Response）
- 元数据（模型、版本、Pattern）

### 2. Replay Runner
- 自动运行全部 Golden Case
- 输出 Diff（当前输出 vs Golden）
- CI 可执行

### 3. Regression Policy
- 哪些变化允许自动更新 Golden
- 哪些变化必须人工 Review
- Golden 更新流程

---

## M4 三阶段职责边界

| Phase | Title | Responsibility |
|-------|-------|----------------|
| M4.1 | Contract Freeze | 接口稳定 |
| M4.2 | Capability Baseline | 能力验证 |
| M4.3 | Replay & Golden | 行为保护 |
