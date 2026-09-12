# Regression Policy — v0.1

**Status:** ✅ Frozen (M4.3)
**Date:** 2026-07-15
**Dependencies:**
- Golden Schema v0.1 (`docs/golden/schema-design.md`)
- ADR-006 Reasoning Contract (`docs/adr-006-reasoning-contract.md`)
- Benchmark v0.1 (`docs/benchmarks/reasoning-v0.1/`)

---

## Core Principle

> **Replay 判断的是"行为是否回归"，而不是"实现是否变化"。**
>
> Replay judges whether BEHAVIOR regressed, not whether IMPLEMENTATION changed.

This is the single source of truth from which all rules in this document are derived. A rule that cannot be traced back to this principle is either redundant or contradictory.

**What this means:**
- Refactoring `ReasoningPlanner` → not a regression, unless the output changes
- Rewriting `PromptBuilder` → not a regression, unless the directive output changes
- Upgrading the model → not a regression, unless the directive output changes
- Changing golden file content without `revisionHistory` → **always** a policy violation

---

## Derived Rules

### 2.1 Regarding Planner Changes

| # | Rule | Derivation |
|---|------|------------|
| R1 | `ReasoningPlanner` can be refactored, optimized, or extended. Replay catches behavioral regressions. | Behavior ≠ Implementation |
| R2 | Adding a new `ThinkingPattern` requires new Golden cases. The existing 44 cases must still PASS. | Existing behavior MUST NOT regress when adding new patterns |
| R3 | Modifying scoring factors (keyword matching, tag weights) is allowed. If 44/44 still PASS, no regression. | Behavior ≠ Implementation |
| R4 | Removing a `ScoringFactor` that changes output for a GoldenCase is a FAIL. | Behavior changed = regression |

### 2.2 Regarding Prompt Changes

| # | Rule | Derivation |
|---|------|------------|
| R5 | `PromptBuilder` can be rewritten for any reason (model upgrade, wording improvement, language switch). | Behavior ≠ Implementation |
| R6 | Prompt changes that affect `ReasoningDirective` output (e.g., changing which Pattern is selected) are caught by Replay as FAIL. | Behavioral regression is actionable |
| R7 | Prompt changes that affect only the final LLM response (Level 2) are NOT detected by v0.1 Replay. This is acceptable — Level 2 is future scope. | v0.1 scope constraint |

### 2.3 Regarding Model Changes

| # | Rule | Derivation |
|---|------|------------|
| R8 | Model upgrades are transparent to Replay v0.1. `plan()` is model-agnostic. | Level 1 is deterministic, independent of model |
| R9 | If a model upgrade changes the system prompt injection path (affects how `PromptBuilder` output reaches the model), Level 1 may still PASS. Re-run the AB Evaluation Bundle for quality verification. | Golden protects regression, not quality — separate concern |

### 2.4 Regarding Golden Updates

| # | Rule | Derivation |
|---|------|------------|
| R10 | Golden MUST NOT auto-update in CI. Replay produces a diff report; only a human can accept new output as the new golden. | Golden is normative, not observational |
| R11 | Every golden update MUST append to `revisionHistory`. In-place overwrite without a log entry is a policy violation. | Traceability is mandatory |
| R12 | A golden update requires: (a) intentional change to Planner or PromptBuilder, (b) human review of the diff, (c) `revisionHistory` entry with reason + author. | Updates must be deliberate and auditable |
| R13 | Bulk golden regeneration (all 44 cases) is allowed only when the core principle is satisfied — the behavior is intentionally changed, not drifted. | Behavior ≠ Implementation, but intentional change is valid |

### 2.5 Regarding Replay Results

| # | Rule | Derivation |
|---|------|------------|
| R14 | ReplayResult MUST NOT be written back to GoldenCase. | M4.3-001 I-5 (separation of concerns) |
| R15 | A Replay FAIL blocks the change. The developer must either fix the regression or accept the new output as the new golden (following R11–R12). | Behavioral regression is actionable |
| R16 | A Replay PASS does NOT guarantee output quality. Quality regression requires AB Evaluation or manual review — separate from Replay. | Golden detects regression, not quality |
| R17 | When Replay PASSes but output quality observably degrades, file a new Benchmark case covering the degraded scenario, then address in a future iteration. | Quality gaps are coverage gaps, not Replay false negatives |

---

## Decision Matrix

| Change Type | Replay Outcome | Action |
|-------------|---------------|--------|
| Planner refactor (no output change) | PASS | Safe to merge |
| Planner refactor (output changes) | FAIL | Fix or update Golden |
| New Pattern added | PASS on existing 44, PENDING on new cases | Add Golden for new cases |
| PromptBuilder rewrite (no directive change) | PASS | Safe to merge |
| PromptBuilder rewrite (directive changes) | FAIL | Fix or update Golden |
| Model upgrade | PASS (Level 1 unaffected) | Run AB Evaluation separately |
| Golden regeneration (bulk) | N/A (Golden is the new reference) | Requires human review |
| New Benchmark case added | PENDING (no Golden yet) | Manually classify as PASS/FAIL |

Three outcome classes:

- **PASS** — `actualDirective` deep-equals `goldenDirective`. No regression.
- **FAIL** — `actualDirective` differs from `goldenDirective`. Regression detected.
- **PENDING** — No Golden exists for this case (new Pattern or new Benchmark). Requires manual classification. PENDING is not a regression — it is a coverage gap.

---

## Escalation

When the policy is ambiguous:

1. The change author writes a brief analysis: which rule applies, why, and what outcome they expect.
2. A second reviewer (or the decision log from a prior ADR) resolves the ambiguity.
3. If the ambiguity reveals a gap in this policy, open a PR to update it.

**Examples of ambiguous situations:**
- Replay FAILs but the new output is objectively better. → This is an intentional improvement, not a regression. Follow R11–R12 to update Golden.
- Replay PASSes but the developer suspects behavioral drift. → File a new Benchmark case (R17). Replay does not measure quality.
- A change touches BOTH Planner AND PromptBuilder. → Run Replay. If PASS, safe. If FAIL, either fix or update Golden.

---

## Related

- Golden Schema v0.1 (`schema-design.md`)
- ADR-006 Reasoning Contract (`../adr-006-reasoning-contract.md`)
- Benchmark v0.1 (`../benchmarks/reasoning-v0.1/`)
