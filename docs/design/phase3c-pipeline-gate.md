# Phase 3C Design: Pipeline Gate Integration

> **Status:** Design (not implementation)
> **Prerequisite:** Phase 3A ExecutionPolicy (frozen) + Phase 3B Constitution Wiring (verified)
> **Goal:** Insert ExecutionPolicy gate into PipelineOrchestrator without conflating policy decisions with execution results.

---

## 1. Problem: `blocked` ≠ `completed`

Current ProblemQueue state model:

```
status (implied by tracking sets):
  queued    → this.problems[]
  completed → completedIds Set
  failed    → failedIds Map
```

If Phase 3C does:

```ts
if (verdict.blocks) {
  this.queue.markCompleted(problem.id)  // WRONG
}
```

Then a policy-blocked problem looks identical to a successfully-fixed problem in the audit trail. Downstream consumers (Evidence analysis, Evolution cycle, operator review) cannot distinguish:

| Actual | Recorded as | Problem |
|---|---|---|
| Fix succeeded | `completed` | Correct |
| Policy blocked | `completed` | **Misleading** |
| No executor | `completed` | Misleading |

**Principle:** Policy decision is a first-class audit event, not a disguised execution result.

---

## 2. Verdict action: flat enum, not level

Phase 3A `ExecutionVerdict` already has `blocks: boolean` and `shouldPropose: boolean` — but those are derived from `level`, not directly actionable.

Phase 3C introduces `action`:

```ts
// New — flat, unambiguous action enum
type VerdictAction = 'execute' | 'skip' | 'block'
```

Mapping from existing level:

| Level | Action | Meaning |
|---|---|---|
| `level_0_record` | `skip` | Record silently, no execution, no signal |
| `level_1_propose` | `block` | Governance blocks execution, decision recorded |
| `level_2_execute` | **REMOVED** | See §4 |

`ExecutionVerdict` gains `action` field for consumption; existing `level`/`blocks`/`shouldPropose` remain for backward-compatible inspection.

---

## 3. Pipeline insertion point

```
queue.pop()
  │
  ▼
ExecutionPolicy.evaluate(problem)
  │
  ├── action: skip
  │     queue.skip(problem.id)    ← NEW: "skipped" state
  │     emit('policy.skip', { ...verdict })
  │     continue
  │
  ├── action: block
  │     queue.block(problem.id)   ← NEW: "blocked" state
  │     emit('policy.block', { ...verdict })
  │     continue
  │
  └── action: execute  (reserved, currently dead)

  None of the above → fall through to tryFix() for legacy behavior
```

### ProblemQueue additions

New tracking sets (no schema migration — in-memory + persisted):

```ts
private skippedIds = new Set<string>()
private blockedIds = new Set<string>()
```

New methods:

```ts
skip(problemId: string): void   // governance skip — not success, not failure
block(problemId: string): void  // governance block
```

Persisted alongside `completedIds` / `failedIds` in `problem_queue.json`.

---

## 4. Level 2 (execute) — frozen closed

Phase 3C **disables all Level 2 paths**. Rationale:

| Source | Current level | Phase 3C action | Why |
|---|---|---|---|
| `tsc` | `level_2_execute` | `execute` → **not implemented** | No policy gate for compile fixes yet |
| `test` | `level_2_execute` | same | No test-fix policy defined |
| `runtime` | `level_2_execute` | same | Too risky without scoping |
| `lint` | `level_2_execute` | same | Defer |
| `log` | `level_2_execute` | same | Defer |
| `git` | `level_2_execute` | same | Defer |

Implementation: `ExecutionPolicy.evaluate()` never returns `level_2_execute`. The error-severity promotion path (§4 in Phase 3A) is also frozen.

Existing Level 2 sources (`tsc`, `test`, `runtime`, `lint`, `log`, `git`) fall through the Phase 3C gate without action — they proceed to `tryFix()` as before, preserving backward compatibility. Only new sources (`evidence`, `memory`, `agent`, etc.) are governed by explicit skip/block.

This means Phase 3C changes zero execution behavior for existing sources.

---

## 5. Decision audit: EventBus + JSON log, no database

Phase 3C **does not introduce a database table**. Two mechanisms:

### 5a. EventBus events

```ts
eventBus.emit('policy.decision', {
  problemId: string
  source: ProblemSource
  action: 'skip' | 'block'
  level: ExecutionLevel
  reason: string
  timestamp: number
  verdict: ExecutionVerdict  // full snapshot
})
```

Consumers (future):
- Evolution analysis — detect patterns in policy blocks
- Dashboard — real-time policy visibility

### 5b. JSON audit file

```
evolution/pipeline_data/policy_decisions.json
```

Append-only log, rotated by `RetentionScheduler`. Same pattern as ProblemQueue persistence — no schema, no migration.

### What is NOT stored

- `ProposalRecord` — Phase 3C does not generate proposals
- `ExecutionPolicy.reason` only — no stack traces, no LLM context
- Per-decision only, not per-problem timeline

---

## 6. PipelineOrchestrator changes summary

| File | Change |
|---|---|
| `PipelineOrchestrator.ts` | Inject `executionPolicy`, call `evaluate()` after `pop()`, route by action |
| `ProblemQueue.ts` | Add `skip()`, `block()` methods + tracking sets + persistence |
| `ExecutionPolicy.ts` | Add `action` to `ExecutionVerdict`, freeze Level 2 paths |
| `types.ts` | No changes to `Problem`, `AssignedProblem`, `FixResult` |

---

## 7. Not in scope (Phase 3C explicitly excludes)

| Feature | Reason |
|---|---|
| `ProposalRecord` persistence | Proposal lifecycle not landed in Pipeline A |
| Human approval UI | No stakeholder for review workflow |
| `ExecutionPolicy` dynamic rules | Phase 3A default map is sufficient |
| Constitution check inside gate | Already at Phase 3B (`ProposalValidator`) |
| Pipeline B (strategic) integration | Separate pipeline, separate governance |
| Level 2 enablement | Frozen, see §4 |

---

## 8. Gate condition for Phase 3C implementation

```
[ ] ExecutionVerdict.action field added (not breaking existing consumers)
[ ] ProblemQueue.{skip,block} methods + persistence
[ ] PipelineOrchestrator pop() → evaluate() → route
[ ] Level 2 all sources disabled (fall-through only)
[ ] EventBus policy.decision event emitted
[ ] Existing ExecutionPolicy.test.ts still passes
[ ] Existing PipelineOrchestrator tests still pass
```
