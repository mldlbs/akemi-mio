# Golden Schema — v0.1

**Status:** ✅ Frozen (M4.3)
**Date:** 2026-07-15
**Dependencies:**
- ADR-006 (Reasoning Contract)
- M4.2 Capability Baseline
- Benchmark v0.1 (44 cases)

---

## Context

M4.3 is the "Replay & Golden" phase. Its goal is behavioral protection of the proven capability: when someone changes `ReasoningPlanner` or `PromptBuilder`, they should instantly see which benchmark cases regressed and which improved.

The Golden Schema is the foundation. It defines *what* we snapshot, *how* we compare, and *how* we update. The Runner, Dataset, and CI integration all depend on this schema.

---

## Scope

This document freezes the Golden Case data model (v0.1). It answers three questions:

1. **What does Golden fix?** — Level 1 (directive) only in v0.1
2. **What changes are allowed?** — Exact match for Level 1
3. **How is Golden updated?** — Append-only revision history

**Out of scope:**
- The Replay Runner (M4.3-004)
- Regression Policy (M4.3-002)
- Populating golden files (M4.3-003)

---

## Three Key Decisions

### 1. What does Golden fix?

Two levels, v0.1 implements only Level 1:

| Level | Target | Deterministic? | Comparison | v0.1 Status |
|-------|--------|---------------|------------|-------------|
| 1 | `ReasoningDirective` | Yes (`plan()` is pure) | Exact match (`toEqual`) | ✅ Implemented |
| 2 | LLM Response | No | Semantic similarity (future) | 🔮 Designed, not implemented |

**Why Level 1 only in v0.1:**
- `plan()` is a pure function with no external dependencies — the same input always returns the same directive.
- This means any diff IS a regression (or an intentional planner change).
- Binary pass/fail for Level 1 is trivially computable and does not require a comparison algorithm.

**Level 2 is designed into the schema** (the `level2` field exists) but is always `null` in v0.1. When we need it, the data model is ready without a schema migration.

### 2. What changes are allowed?

| Change category | Level 1 | Level 2 (future) |
|----------------|---------|-----------------|
| Whitespace / formatting | N/A (structured) | Allowed |
| Synonym rephrasing | N/A | Allowed within threshold |
| Output order | Blocked (deterministic) | Blocked for structured, allowed for prose |
| Markdown format | N/A | Allowed |
| Semantic drift | Blocked (any diff = regression) | Blocked beyond threshold |

**Level 1 principle:** `plan()` is a pure function. Any change to its output for the same input is either a regression or an intentional update. There is no "tolerance" — comparison is binary.

### 3. How is Golden updated?

| Aspect | Rule |
|--------|------|
| **Who** | Developer running `--update-golden` flag |
| **When** | After intentional, verified changes to `ReasoningPlanner` or `PromptBuilder` |
| **How** | Append to `changelog[]` + overwrite the file. Never in-place without a log entry. |
| **What to record** | Date, reason, author, level affected, previous directive hash |

**No auto-update in CI.** The Replay Runner produces a diff report; only a human can decide to accept the new output as the new golden.

---

## Schema Definition

### TypeScript Interface

File: `src/main/reasoning/golden/types.ts`

```typescript
export interface GoldenCase {
  caseId: BenchmarkCaseId
  caseRef: { text: string; expectations: string[] }
  level1: GoldenDirectiveSnapshot
  level2: GoldenResponseSnapshot | null   // @future
  changelog: GoldenChangelogEntry[]
  createdAt: string
  updatedAt: string
}
```

The full interface is defined in `src/main/reasoning/golden/types.ts` and validated against `docs/golden/golden-schema.json`.

### Storage Format

**JSON** — machine-parseable, git-diffable, directly importable by TypeScript, and compatible with JSON Schema validation.

### Directory Structure

```
docs/golden/
├── golden-schema.json      # JSON Schema for validation
├── manifest.json           # Index of all golden cases
├── schema-design.md        # This document
├── analysis/               # Analysis pattern cases
│   ├── Q01.json
│   └── ...
├── decision/               # Decision pattern cases
│   ├── D01.json
│   └── ...
├── planning/               # Planning pattern cases
│   ├── P01.json
│   └── ...
└── creation/               # Creation pattern cases
    ├── C01.json
    └── ...
```

### File Naming

`{caseId}.json` where `caseId` matches the benchmark definition (e.g., `Q01`, `D-D05`).

---

## Invariants

| # | Rule | Verification |
|---|------|-------------|
| I-1 | Every BenchmarkCase has exactly one active GoldenCase | Runner checks manifest completeness |
| I-2 | Level 1 directive must exactly match `plan()` output | `toEqual` in tests |
| I-3 | Every update appends to changelog; no silent overwrites | CI checks changelog length |
| I-4 | All golden files must pass JSON Schema validation | `validate-golden-schema.ts` |

---

## Consequences

### Positive

1. **Schema is frozen before any implementation** — the Runner is designed against a stable contract, not a moving target
2. **Level 2 is designed but optional** — adding it later requires no data migration
3. **JSON is both machine-readable and human-reviewable** — diffs in PRs are clear

### Negative

1. **44 JSON files** — this is a lot of files for one dataset. Mitigation: only regenerated when the planner changes.
2. **No automatic golden updates** — every golden update requires human intervention. This is intentional but adds friction.

---

## Related

- ADR-006 — Reasoning Contract Freeze (`docs/adr-006-reasoning-contract.md`)
- M4.2 Capability Baseline (`docs/milestone-m4.2-capability-baseline.md`)
- Benchmark v0.1 (`docs/benchmarks/reasoning-v0.1/`)
- Golden Case types (`src/main/reasoning/golden/types.ts`)
