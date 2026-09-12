# M5.7 Passive Observation Monitor Design

> This document defines a read-only review monitor for M5.7. It does not reopen the frozen coverage review, modify runtime behavior, change the behavioral evidence contract, or authorize M5.8 work.

**Goal:** Add a lightweight offline monitor that compares the frozen M5.7 behavioral baseline with current evidence and emits a review signal when new evidence requires human reassessment.

**Status:**

```text
M5.7 v1: Frozen, Review Complete
Passive Monitor: Design Approved
Runtime: Unchanged
```

## 1. Purpose

The passive monitor turns the completed M5.7 evidence review into a repeatable observation mechanism. It reads existing evidence, compares the current observation window with the frozen baseline, and writes a review artifact.

The monitor may produce only:

```text
Continue Freeze
Evidence Review Required
```

It must never modify runtime state, policy, catalog data, `evaluation_events`, or the existing behavioral observation artifact.

## 2. Data Flow

```text
evaluation_events
        +
behavioral-observation.json
        +
frozen baseline
        |
        v
Passive Observation Analyzer
        |
        v
reports/m57/observation/passive-review.json
```

`evaluation_events` remains the source of truth. `behavioral-observation.json` remains a derived evidence projection. The passive report is a second derived review projection and must be reproducible from its inputs.

## 3. Baseline Contract

The frozen behavioral baseline is the Evidence Review snapshot:

```text
baselineSampleCount = 103
baselineIncompleteEvidenceRate =
  baselineIncompleteEvidenceCount / baselineTraceCount
```

The implementation must not infer the baseline from the current run. It must receive the baseline explicitly, either through a checked-in baseline configuration or a baseline artifact reference.

The baseline must include:

```json
{
  "sampleCount": 103,
  "incompleteEvidenceCount": 201,
  "traceCount": 304,
  "fingerprintDistribution": {}
}
```

The denominator for `incompleteEvidenceRate` is `traceCount`, not `sampleCount`, because incomplete evidence is measured across all observed trace windows. The frozen baseline rate is `201 / 304 = 0.661184`.

## 4. Current Metrics

Each monitor run must report:

```json
{
  "sampleCount": 0,
  "traceCount": 0,
  "incompleteEvidenceCount": 0,
  "incompleteEvidenceRate": 0,
  "fingerprintDistribution": {},
  "newFingerprintCount": 0,
  "divergenceCount": 0,
  "decisionImpactCount": 0,
  "blindSpotCount": 0
}
```

The monitor may reuse the current `behavioral-observation.json` aggregates, but it must calculate comparison fields from the current and baseline distributions rather than copying a precomputed trigger decision.

## 5. Trigger Matrix

The monitor emits `Evidence Review Required` when any independent signal is present:

| Signal | Trigger |
| --- | --- |
| Divergence | `divergenceCount > 0` in the current evidence input |
| Decision impact | `decisionImpactDerived > 0` |
| New behavioral blind spot | A current sequence/fingerprint cannot be explained by the frozen baseline and is marked as a blind spot |
| Incomplete evidence regression | `(currentRate - baselineRate) >= 0.10` and `newIncompleteEvidenceCount >= 5` |

All other runs emit `Continue Freeze`.

The incomplete-evidence rule is intentionally conjunctive:

```text
currentRate - baselineRate >= 10 percentage points
AND
newIncompleteEvidenceCount >= 5
```

The monitor must preserve the raw rates and deltas so a reviewer can distinguish a real regression from a small-denominator fluctuation.

## 6. Fingerprint Comparison

`newFingerprintCount` is the count of current fingerprint families absent from the frozen baseline.

A new fingerprint is a review signal only when it is repeated at least three times in the current window. A single new fingerprint is recorded but does not trigger review by itself.

The monitor must not label distribution concentration as a blind spot. Concentration is a reported observation; it becomes a review signal only when a new unexplained family, divergence, or decision impact is present.

## 7. Report Contract

The first implementation writes:

```text
reports/m57/observation/passive-review.json
```

The report must contain:

```json
{
  "schemaVersion": 1,
  "generatedAt": "ISO-8601 timestamp",
  "baseline": {
    "sampleCount": 103,
    "traceCount": 304,
    "incompleteEvidenceRate": 0.661184
  },
  "current": {
    "sampleCount": 103,
    "traceCount": 304,
    "incompleteEvidenceCount": 201,
    "incompleteEvidenceRate": 0.661184,
    "fingerprintDistribution": {},
    "newFingerprintCount": 0,
    "divergenceCount": 0,
    "decisionImpactCount": 0,
    "blindSpotCount": 0
  },
  "comparison": {
    "newIncompleteEvidenceCount": 0,
    "incompleteEvidenceRateDelta": 0,
    "repeatedNewFingerprintCount": 0
  },
  "decision": "Continue Freeze",
  "triggers": []
}
```

The example values are illustrative except for the frozen baseline sample count. The implementation must preserve numeric precision in the actual report.

## 8. Periodic Snapshots

The monitor supports explicit snapshot output without scheduling or runtime integration:

```text
reports/m57/observation/passive-observation/
  2026-08-03.json
  2026-08-10.json
  2026-08-17.json
```

Snapshot naming is supplied by the caller or CLI. The monitor must not create timers, background jobs, or app lifecycle hooks.

## 9. Error Handling

- Missing current artifact: fail the command and do not emit a misleading `Continue Freeze` report.
- Missing baseline: fail the command and require an explicit baseline.
- Malformed fingerprint distribution: fail validation with a field-specific error.
- Missing optional divergence or decision-impact fields: treat them as unavailable and emit `Evidence Review Required`, not zero.
- Write failure: return a non-zero process exit and preserve the source artifacts unchanged.

## 10. Testing

Tests must cover:

- stable baseline produces `Continue Freeze`
- repeated new fingerprint produces `Evidence Review Required`
- one-off new fingerprint does not trigger review
- divergence triggers review
- decision impact triggers review
- blind spot triggers review
- incomplete evidence triggers only when both threshold conditions are met
- incomplete rate increase below 10 percentage points does not trigger
- incomplete count increase below 5 does not trigger
- missing baseline/current artifact fails closed
- report writing is deterministic except for `generatedAt`

The monitor tests must use in-memory or temporary input fixtures and must not write to the live user database.

## 11. Non-Goals

- no runtime event changes
- no new capability or tool
- no event schema migration
- no changes to `BehavioralEvidenceAnalyzer`
- no changes to `DecisionIdentity`
- no automatic policy tuning
- no automatic M5.7 v2 or M5.8 transition
- no scheduler or daemon

## 12. Review Boundary

The passive monitor is a signal generator, not a decision maker:

```text
Passive Observation
        |
        v
Monitor Signal
        |
   +----+----+
   |         |
 No        Yes
   |         |
Continue   Evidence Review
Freeze
```

Only a later human Evidence Review may choose among:

```text
Continue Freeze
Open M5.7 v2
Trigger Policy Analysis
```
