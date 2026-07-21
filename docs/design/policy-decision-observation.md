# Policy Decision Observation (Phase 3C.2)

**Date:** 2026-07-21
**Status:** Draft
**Upstream:** ADR-012 (Governance Gate), Phase 3C (Pipeline Gate), Phase 3C+ (Shadow Mode)
**Downstream:** ADR-012 Activation Gate

---

## Problem

Shadow mode emits `policy.decision` events on EventBus, but there is no consumer. The ADR-012 activation gate requires:

```
shadow decisions ≥ 100
execute 比例 ≥ 60%
skip 比例 ≤ 20%
block 比例 = 0
```

Without observation, these conditions cannot be verified.

## Non-Goal

This design does **not** add:
- Persistent counter or ndjson file in PipelineOrchestrator
- New state machine for shadow→enforce auto-switch
- Dashboard or monitoring integration
- Any change to PipelineOrchestrator, ExecutionPolicy, or ProblemQueue (Phase 3C frozen boundary)

## Architecture

```
PipelineOrchestrator
  ↓
eventBus.emit('policy.decision')      ← existing (Phase 3C+)
  ↓
PolicyDecisionObserver                 ← NEW (thin subscriber)
  ↓
evaluationEmitter.emit('evolution.policy.decision')
  ↓
EvaluationStore (append-only log)     ← existing
  │
  ├── ActivationGate query            ← NEW (read-side utility)
  └── MetricsEngine (future)          ← no change now
```

### Contract

| Component | Change | Status |
|---|---|---|
| `EventBus` | Unchanged | Frozen |
| `PipelineOrchestrator` | Unchanged | Frozen |
| `ExecutionPolicy` / `PolicyDecisionEvent` | Unchanged | Frozen |
| `EventType` | +1 new: `evolution.policy.decision` | NEW |
| `EventPayload` | +1 new: `PolicyDecisionPayload` | NEW |
| `PolicyDecisionObserver` | New class, ~30 lines | NEW |
| `MetricsEngine` | Unchanged | — |
| `AppRuntime` | Wire observer after pipeline init | NEW |

### Data Flow

```
PolicyDecisionEvent (EventBus)
  mode: 'shadow'
  action: 'execute' | 'skip' | 'block'
  executed: true
  source: 'evidence'
  problemId: 'uuid'
  policyVersion: '1.0.0'
  timestamp: 1712345678000
```

↓

```
EvaluationEvent (EvaluationStore)
  type: 'evolution.policy.decision'
  payload: {
    mode: 'shadow',
    action: 'execute',
    executed: true,
    source: 'evidence',
    problemId: 'uuid',
    policyVersion: '1.0.0',
    reason: 'evidence_low_confidence',
    evaluatedAt: 1712345678000
  }
  timestamp: 1712345680000
  source: 'PolicyDecisionObserver'
  sessionId: 'runtime_...'
```

## Schema

### EventType Addition

In `src/main/core/evaluation/types.ts`:

```ts
export type EventType =
  | ...
  // ── Evolution Governance (Phase 3C.2)
  | 'evolution.policy.decision'
```

### Payload

```ts
export interface PolicyDecisionPayload {
  /** Execution mode at decision time */
  mode: 'disabled' | 'shadow' | 'enforce'
  /** Policy verdict */
  action: 'execute' | 'skip' | 'block'
  /** Whether tryFix() was actually called */
  executed: boolean
  /** Problem source that triggered this decision */
  source: string
  /** Problem identifier for traceability */
  problemId: string
  /** Policy version string */
  policyVersion: string
  /** Verdict reason from ExecutionPolicy.evaluate() */
  reason: string
  /** Unix ms when the policy decision was made (may differ from event.timestamp) */
  evaluatedAt: number
}
```

### EventPayload Union

```ts
export type EventPayload =
  | ...
  | ({ type: 'evolution.policy.decision' } & PolicyDecisionPayload)
```

## PolicyDecisionObserver

A single class, one subscriber, one transform, one emit.

```ts
// src/main/core/evaluation/observers/PolicyDecisionObserver.ts

import { eventBus } from '../../EventBus'
import type { EvaluationEmitter } from '../EvaluationEmitter'

export class PolicyDecisionObserver {
  private emitter: EvaluationEmitter
  private unsub?: () => void

  constructor(emitter: EvaluationEmitter) {
    this.emitter = emitter
  }

  start(): void {
    this.unsub = eventBus.on('policy.decision', (event: any) => {
      this.emitter.emit('evolution.policy.decision', {
        mode: event.mode,
        action: event.action,
        executed: event.executed,
        source: event.source,
        problemId: event.problemId,
        policyVersion: event.policyVersion,
        reason: event.reason,
        evaluatedAt: event.timestamp,
      })
    })
  }

  stop(): void {
    this.unsub?.()
  }
}
```

### Dependencies

| Dependency | Direction | Reason |
|---|---|---|
| `eventBus` | import | Subscribe to `policy.decision` |
| `EvaluationEmitter` | constructor injection | Write `EvaluationEvent` to store |

No dependency on `PipelineOrchestrator`, `ExecutionPolicy`, `ProblemQueue`, or any frozen Phase 3C component.

## Activation Gate Query

### Raw SQL (EvaluationStore rawDb)

```sql
-- Total shadow decisions
SELECT COUNT(*) AS total
FROM evaluation_events
WHERE type = 'evolution.policy.decision'
  AND json_extract(payload, '$.mode') = 'shadow'
  AND timestamp >= <observation_start>

-- Execute ratio
SELECT COUNT(*) AS execute_count
FROM evaluation_events
WHERE type = 'evolution.policy.decision'
  AND json_extract(payload, '$.mode') = 'shadow'
  AND json_extract(payload, '$.action') = 'execute'

-- Skip ratio
SELECT COUNT(*) AS skip_count
FROM evaluation_events
WHERE type = 'evolution.policy.decision'
  AND json_extract(payload, '$.mode') = 'shadow'
  AND json_extract(payload, '$.action') = 'skip'

-- Block count
SELECT COUNT(*) AS block_count
FROM evaluation_events
WHERE type = 'evolution.policy.decision'
  AND json_extract(payload, '$.mode') = 'shadow'
  AND json_extract(payload, '$.action') = 'block'
```

### Utility Function (optional)

```ts
// ActivationGateChecker — read-only, for runtime use
interface ActivationGateStatus {
  ready: boolean
  shadowDecisions: number
  executeRatio: number
  skipRatio: number
  blockCount: number
  evolutionCycleCompleted: boolean
}

async function checkActivationGate(
  store: EvaluationRepository,
  observationStart: number
): Promise<ActivationGateStatus> { ... }
```

Not required for Phase 3C.2 — only the raw data needs to exist. The checker is added when the gate is ready to be evaluated.

## Wiring (AppRuntime)

In the `lazyInit` evolution service block (`AppRuntime.ts:1438`), after pipeline is created:

```ts
// Phase 3C.2: Observe policy decisions → EvaluationStore
import { PolicyDecisionObserver } from '../core/evaluation/observers/PolicyDecisionObserver'
const policyObserver = new PolicyDecisionObserver(evaluationEmitter)
policyObserver.start()
```

Registration order:
1. Pipeline created + `setExecutionPolicy(Shadow)` → starts emitting `policy.decision`
2. Lazy evolution block runs → creates observer → starts subscribing
3. Pipeline first `runOnce()` happens after lazy init → no race

**Guarantee:** observer starts before any pipeline cycle runs, because:
- Lazy evolution block runs at `delayMs: 200`
- Pipeline is scheduled by `evolution.scheduleEvolution(2)` which uses TaskRunner (second-level delay)
- The first `pipeline.runOnce()` is triggered by the evolution tick timer, not immediately

## Frozen Boundaries

### What Phase 3C.2 does NOT change

| Boundary | Status |
|---|---|
| `PipelineOrchestrator` source | Untouched |
| `ExecutionPolicy` source | Untouched |
| `ProblemQueue` source | Untouched |
| `PipelineMetrics` | Unchanged |
| `PolicyDecisionEvent` schema | Unchanged |
| `ExecutionMode` | Unchanged |
| Shadow mode behavior | Unchanged |

### What Phase 3C.2 adds

| Addition | Scope |
|---|---|
| `EventType: evolution.policy.decision` | 1 line in types.ts |
| `PolicyDecisionPayload` | 7 lines in types.ts |
| `EventPayload` union update | 1 line in types.ts |
| `PolicyDecisionObserver` | New file, ~30 lines |
| AppRuntime wiring | 2 lines |

## Verification

### Contract Tests

```
Phase 3C.2: PolicyDecisionObserver
  ✓ subscribes to policy.decision events
  ✓ transforms PolicyDecisionEvent → EvaluationEvent
  ✓ emits evolution.policy.decision to EvaluationEmitter
  ✓ shadow decisions are queryable from EvaluationStore
  ✓ stop() unsubscribes from EventBus
  ✓ does not affect pipeline behavior (shadow mode unchanged)
  ✓ observer starts before first pipeline runOnce()
```

### Integration Test

```ts
// Arrange: create real observer + real EvaluationStore
// Act: emit policy.decision via EventBus
// Assert: evaluation_events table contains matching row
```

## References

- ADR-012: Runtime Evolution Governance Gate
- Phase 3C Design Note: `docs/design/phase3c-pipeline-gate.md`
- Evaluation Event Protocol: `src/main/core/evaluation/types.ts`
- Shadow Mode wiring: `src/main/bootstrap/AppRuntime.ts:1438`
- PolicyDecisionEvent schema: `src/main/evolution/automation/ExecutionPolicy.ts:60`
