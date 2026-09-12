# M5.6.5 Cutover Review Design

> **Status:** Review executed (2026-08-10): first review HOLD -> re-review PASS (post-remediation)
> **Date:** 2026-08-10
> **Upstream:** ADR-015 capability model contract; M5.6.4 migration gate PASS (2026-08-10)
> **Related:** `docs/superpowers/specs/2026-07-30-m56-capability-evolution-migration-design.md`; `docs/m56-capability-migration-closeout.md`

## 1. Purpose

Define how Evolution decides whether capability identity may become the authoritative grouping and ranking dimension for its problem pipeline, replacing tool-first grouping in the authoritative path while preserving tool evidence and executor contracts.

M5.6.4 built the shadow comparison infrastructure and the migration gate. The gate has passed on real observation data. M5.6.5 is the review that decides the next authority step - it does not itself grant capability-first execution authority.

## 2. Authority Boundary

### What capability-first authority means if granted

```text
authoritative path (today):
  ToolEvolutionCollector: problemId = tool:<toolName>:error_rate   (tool-first)
  ProblemQueue ranking: tool-level priority

capability-first path (target):
  ToolEvolutionCollector: problemId = capability:<cap>:<op>:<issue> (capability-led)
  ProblemQueue ranking: capability-level priority
  toolName retained as execution trace / debug evidence in metadata
```

### What remains frozen

- `ProblemQueue` persistence format and executor authority flow
- `ToolEvolutionExecutor` / `ToolConfigOptimizationExecutor` behavior
- `PipelineOrchestrator.runOnce()` scheduling and authority flow
- `toolName`, provider, and affected-tool evidence in every problem record
- Memory capability-identity write/recall behavior (M5.5)

## 3. Review Protocol

### 3.1 Inputs

| Input | Source | Freshness |
|---|---|---|
| Migration gate report | `reports/m56/migration/latest/migration_gate_report.json` | per run |
| Rollback readiness report | `reports/m56/migration/latest/rollback_readiness_report.json` | per run |
| Decision diff report | `reports/m56/migration/latest/decision_diff_report.json` | per run |
| Capability candidates | `reports/m56/migration/latest/capability_problem_candidates.json` | per run |
| Shadow observation runs | `%APPDATA%/akemi-mio/evolution_workspace/pipeline_data/capability_evolution_shadow_runs.json` | hourly |
| Identity gap report | `npx tsx scripts/m56-identity-gap-report.ts` | on demand |

### 3.2 Cutover Criteria

| # | Criterion | Target | Source of truth |
|---|---|---:|---|
| C1 | Capability coverage (runtime tool events with capability identity) | >= 90% | shadow run summaries / identity gap report |
| C2 | Legacy-only problem ratio | < 10% | migration comparison report |
| C3 | Shadow vs legacy decision consistency | >= 95% | decision diff report |
| C4 | Executor regression | = 0 | gate report + regression slice |
| C5 | Migration gate | PASS | gate report |
| C6 | Rollback readiness | intact (capability authority disabled, legacy authority intact, dual-write active) | rollback report |

### 3.3 Decision Semantics

- **PASS (all C1-C6):** authorize a bounded capability-led pilot (section 5). No executor authority change.
- **HOLD (C1 or C5 fail, safety invariants intact):** keep shadow + dual-write only; record evidence; do not change authoritative grouping.
- **FAIL (safety invariant break: traceability < 100% or executor regression > 0):** stop shadow generation for the affected path, investigate before any further discussion.

## 4. Current Evidence Baseline (2026-08-10)

| Criterion | Target | Actual | Result |
|---|---:|---:|---|
| C1 Capability coverage | >= 90% | 100% (25,000 / 25,000 events, 50 runs) | PASS |
| C2 Legacy-only ratio | < 10% | 0% | PASS |
| C3 Decision consistency | >= 95% | 100% | PASS |
| C4 Executor regression | 0 | 0 | PASS |
| C5 Migration gate | PASS | PASS | PASS |
| C6 Rollback readiness | intact | intact | PASS |

**Re-review outcome (2026-08-10, post-remediation): PASS.** Coverage remediation closed catalog + enrichment gaps; capability coverage reached 100%. A bounded capability-led pilot is authorized per section 5; no executor authority change.

### 4.1 Coverage Gap Breakdown (pre-remediation, 2026-08-10)

From `npx tsx scripts/m56-identity-gap-report.ts` (590-event snapshot, 2026-08-10, before remediation):

- Enrichment gaps: 539 events (tools mapped in source but events not capability-tagged)
- Catalog gaps: 51 events across 13 unmapped tool names, led by `grep_search` (27), `writing_system` (8), `browser_evaluate` (3), `connect_mcp_server` (2), `create_dev_plan` (2), `list_plans` (2)
- Source mismatch: 0

### 4.2 Coverage Remediation (2026-08-10)

1. Catalog gaps closed: 16 tools mapped onto existing capabilities in `src/main/bootstrap/AppRuntime.ts` (no new capability ids -> LLM function surface unchanged). See `reports/m56/cutover-review/2026-08-10-pass.md`.
2. Enrichment gaps closed: `ToolCallLogStore.backfillCapabilityIdentity()` backfilled historical tool call log records from the authoritative source mapping.
3. Shadow observation window regenerated from the corrected log (50 runs preserved, `runId`/`generatedAt` retained).
4. Post-remediation identity gap report: 590/590 events capability-tagged, 0 catalog gaps, 0 enrichment gaps, 0 mismatches; migration gate PASS with 1000 candidates.

## 5. Pilot Design (activated after PASS)

### 5.1 Scope

A bounded pilot on the authoritative path, capability-led but reversible:

1. `ToolEvolutionCollector` emits capability-led `problemId` while retaining `toolName` + provider in `context.metadata` and `legacyEvidence`.
2. `ProblemQueue` ranking uses capability priority (severity + occurrence aggregated per capability bucket), with tool-level detail preserved for execution.
3. Pilot domain: `tool`-source problems only (no change to behavior, file_organizer, memory, or blog collectors).

### 5.2 Pilot Gate

- Pilot runs in dual-write: shadow artifacts keep being generated alongside authoritative decisions.
- A pilot decision is only eligible for executor dispatch if the identical capability decision candidate also exists in the shadow report with the same rank.

### 5.3 Pilot Exit Criteria (for full cutover, M5.6.6+)

- 7 consecutive days of pilot with zero executor regression
- Capability coverage >= 90% sustained over the window
- Decision consistency >= 95% sustained over the window
- No rollback trigger fired

### 5.4 Pilot Implementation (2026-08-11)

The bounded pilot is activated as a read-only observer wired into `PipelineOrchestrator.runOnce()` (Phase 1.6):

- `CapabilityPilotDecisionGate.evaluatePilotDecisionEligibility()` derives capability-led decisions from the authoritative tool-source problems (dual-write — the authoritative `problemId` is untouched) and compares them rank-for-rank against the shadow decision candidates built from the persisted shadow observation window.
- A decision is `eligible` only when the identical capability key exists in the shadow report at the same rank (spec 5.2).
- Pilot run records are persisted under `reports/m56/pilot/` (`CapabilityPilotStore`) and emitted as `pipeline.pilot_gate.evaluated`.
- The gate never dispatches to executors and never mutates `ProblemQueue`; `ToolEvolutionCollector`/executors keep their authoritative behavior.
- Startup self-healing: `ServerManager.setCapabilityResolver()` re-reconciles capability identity on loaded tool call log records via the catalog reverse lookup, so the C1 coverage remediation survives app restarts.
- Exit monitoring: `CapabilityPilotHealthMonitor.evaluatePilotExitCriteria()` (read-only) consumes the persisted pilot run window plus the shadow window and emits `monitoring` / `exit_ready` / `rollback_required` per section 5.3 / section 6; `scripts/m56-pilot-health-check.ts` (gitignored) runs it on real data.

## 6. Rollback

Trigger: any of

- executor regression > 0
- capability coverage drops below 80% for 48h
- decision consistency drops below 90%
- any unexplained divergence between shadow and authoritative decisions

Rollback action:

- restore tool-first `problemId` grouping
- keep capability metadata and shadow artifact generation
- keep dual-write telemetry active
- log the rollback decision with evidence into `reports/m56/`

## 7. Guardrails

- No capability-first execution authority during M5.6.5.
- No changes to `ProblemQueue.ts`, `ToolEvolutionExecutor.ts`, `ToolConfigOptimizationExecutor.ts` in this phase.
- No removal of `toolName` / provider / affected-tool evidence from any legacy path.
- No change to scheduler cadence or `PipelineOrchestrator.runOnce()` authority flow.
- Coverage remediation (catalog mappings for gap tools) is prerequisite work, reviewed separately.

## 8. Status

**M5.6.5 Status:** First review (2026-08-10) -> **HOLD**; re-review after coverage remediation (2026-08-10) -> **PASS**
**Authority:** none granted (bounded capability-led pilot authorized per section 5; no executor authority change)
**Review decision records:** `reports/m56/cutover-review/2026-08-10-hold.md` (first review), `reports/m56/cutover-review/2026-08-10-pass.md` (re-review)
**Post-remediation evidence:** capability coverage 100% (25,000 / 25,000 events, 50 runs); identity gap 0; migration gate PASS
**Next:** pilot activated 2026-08-11 (section 5.4); M5.6.6+ full cutover discussion after pilot exit criteria
