# M5.6.4 Capability Evolution Migration Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze the migration contract that moves Evolution from tool identity to capability identity without changing runtime behavior yet.

**Architecture:** Keep the current tool-based Evolution pipeline intact while defining a shadow capability-first decision model in parallel. Capability is the optimization subject; tool remains execution evidence. The design freezes dual-write, shadow decision, cutover, and rollback semantics before any behavior change.

**Tech Stack:** TypeScript, existing Evolution collectors/executors, shadow observation store, telemetry records, ADR-015 contract language.

---

## 1. Scope

This phase freezes the migration contract only. Capability authority activation requires a separate cutover review phase after M5.6.4 and is not granted by this document.

### In Scope

- Collector migration contract
- Problem identity contract
- Executor contract
- Rollout contract
- Migration gate metrics

### Out of Scope

- Collector implementation changes
- ProblemQueue implementation changes
- Executor implementation changes
- capability-first execution authority
- tool identity removal

## 2. Existing Migration Assets

The following assets already exist and serve as migration prerequisites:

- `CapabilityEvolutionShadowCollector`
- `CapabilityEvolutionShadowStore`
- shadow observation report
- `Problem.affectedCapability`
- `ToolCallIdentity` shadow contract
- M5.6.3 observation evidence

## 3. Collector Migration Contract

### Current

```text
toolName
  -> aggregation
  -> Problem
```

### Target

```text
capability
+ operation
+ issueType
  -> Problem candidate
```

### Contract Rules

- Legacy and capability collectors run in parallel.
- Legacy output remains unchanged.
- Capability output is observational until cutover.
- `toolName` remains as trace data, not the primary grouping key.

## 4. Problem Identity Contract

### Target Shape

```ts
interface CapabilityProblemIdentity {
  capability: string
  operation: string
  issueType: string
  version?: string
}
```

### Metadata

```ts
{
  affectedTools: string[]
  providers?: string[]
  legacyToolNames?: string[]
}
```

### Rules

- capability defines the problem boundary
- operation refines the boundary
- issueType defines the optimization category
- version exists for replay and migration comparison
- tool defines execution trace only

## 5. Executor Contract

Capability problems must resolve through an indirection layer before any existing executor runs.

```text
Capability Problem
        |
        v
Capability Resolution
        |
        v
Affected Tool Set
        |
        v
Existing Executor
```

### Prohibitions

- No capability executor rewrite in this phase
- No direct replacement of tool-level actions
- No executor trigger without tool traceability

## 6. Rollout Strategy

### 6.1 Dual Write Window

Both legacy tool aggregation and capability shadow aggregation run together.

Exit condition:

- capability coverage `>= 90%`
- capability -> tool traceability `= 100%`

### 6.2 Shadow Decision

Capability identity may participate in ranking, aggregation, and trend analysis, but must not trigger execution.

### 6.3 Cutover Review

Capability authority can only be considered after a separate cutover review phase, with all of the following:

- capability coverage `>= 90%`
- legacy-only problem ratio `< 10%`
- shadow vs legacy decision consistency `>= 95%`
- executor regression `= 0`

### 6.4 Rollback Path

Rollback disables capability authority, restores legacy tool authority, and keeps dual-write telemetry active.

## 7. Migration Gate

| Metric | Target |
|---|---:|
| Observation Window | `>= 1000` candidates or `>= 7 days` |
| Identity Coverage | `>= 90%` |
| Capability Traceability | `100%` |
| Legacy-only Ratio | `< 10%` |
| Decision Consistency | `>= 95%` |
| Executor Regression | `0` |

### Decision Consistency

Decision consistency is defined over the same observation window as:

```text
matched capability decision candidates
/
legacy decision candidates that are eligible for capability mapping
```

This keeps the denominator anchored to the current legacy authority path and avoids ambiguity between intersection-only and union-based overlap formulas.

### Gate Semantics

- `pass`: allow cutover review
- `hold`: keep dual-write and shadow decision only
- `fail`: keep dual-write only and investigate safety invariant breaks before any cutover discussion

## Artifacts

M5.6.4 shadow runs produce:

- `legacy_problem_candidates`
- `capability_problem_candidates`
- `comparison_report`
- `legacy_decisions`
- `capability_decisions`
- `decision_diff_report`
- `migration_gate_report`
- `rollback_readiness_report`

## Status

**M5.6.4 Status:** Implementation Complete  
**Authority:** No capability-first execution authority granted  
**Next:** M5.6.5 Cutover Review

## M5.6.4 Migration Gate - 2026-08-10

**Gate: PASS** on real observation data from the runtime shadow store (50 runs, 7.01 days).

| Metric | Target | Actual | Result |
|---|---:|---:|---|
| Observation Window | >= 1000 candidates or >= 7 days | 250 candidates / 7.01 days | PASS |
| Identity Coverage | >= 90% | 100% | PASS |
| Capability Traceability | 100% | 100% | PASS |
| Legacy-only Ratio | < 10% | 0% | PASS |
| Decision Consistency | >= 95% | 100% | PASS |
| Executor Regression | 0 | 0 | PASS |

**Artifact outputs (latest):**

- `legacy_problem_candidates`: 250 candidates hydrated from `capability_evolution_shadow_runs.json`
- `capability_problem_candidates`: 4 candidates (browser.automation, file.management, search.retrieval, system.execution)
- `comparison_report`: eligible 250 -> 4 candidates, fragmentation reduction 98.4%
- `legacy_decisions` / `capability_decisions`: full dual-key decision lists
- `decision_diff_report`: 4 matched keys, 0 legacy-only, 0 capability-only, consistency 1.0
- `migration_gate_report`: status pass
- `rollback_readiness_report`: capability authority disabled, legacy authority intact, dual-write active

**Next:** M5.6.5 Cutover Review (authority decision remains out of scope for M5.6.4).
