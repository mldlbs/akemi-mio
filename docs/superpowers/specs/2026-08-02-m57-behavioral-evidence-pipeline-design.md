# M5.7 Behavioral Evidence Pipeline Design

> **For agentic workers:** This document defines the behavioral evidence contract for M5.7 only. It does not reopen the frozen coverage review, does not authorize runtime behavior changes, and does not permit implicit scope narrowing.

**Goal:** Restore a durable behavioral evidence pipeline for M5.7 so that sequence, fingerprint, divergence, and decision-impact evidence can be accumulated under a stable measurement contract.

**Status Baseline (updated 2026-08-03):**

```text
Coverage Review: Passed
Behavioral Gate: Passed (`sampleCount = 103`)
Evidence Review: Continue Freeze
M5.7 v1: Frozen, Review Complete
```

**Architecture Direction:** `evaluation_events` remains the sole source of truth. Runtime writes only factual events. Offline analysis derives behavioral evidence and materializes review snapshots under `pipeline_data`.

## 1. Purpose

M5.7 has completed coverage validation at the tool-event layer and reached the behavioral evidence gate. The resulting review decision is to continue the freeze; this contract remains the reference for future natural-traffic observations.

This design restores the missing behavioral evidence chain:

```text
trace
  -> sequence
  -> fingerprint
  -> divergence detection
  -> decision-impact evidence
```

The purpose of this phase is to freeze the behavioral measurement contract before any implementation details are chosen. The contract must be stable enough that future analyzer revisions can replay old evidence without changing runtime semantics.

## 2. Scope

### In Scope

- defining the behavioral evidence source of truth
- defining the event contract required for behavioral reconstruction
- defining the sample contract for `observationCount`
- defining derived behavioral artifacts and traceability rules
- defining gate semantics for behavioral evidence review

### Out of Scope

- runtime dual-write to JSON artifacts
- embedding sequence or fingerprint metadata into `DecisionIdentity`
- reopening the frozen coverage baseline
- catalog patching for `browser_evaluate`
- schema migration details
- analyzer class structure or implementation algorithm details
- policy interpretation logic

## 3. Evidence Source Contract

The behavioral evidence ledger must use the following split:

```text
Runtime
   -> EvaluationEmitter
   -> evaluation_events          // source of truth

Offline analyzer
   -> pipeline_data/*.json       // derived review materialization
```

Rules:

- `evaluation_events` is the only fact source.
- Runtime writes factual events only.
- `pipeline_data` artifacts are derived projections and may be regenerated.
- No runtime dual-write is allowed.
- No behavioral measurement metadata may be added to `DecisionIdentity`.

This preserves replayability and prevents experimental interpretation from contaminating the execution path.

## 4. Behavioral Sample Contract

### 4.1 Canonical Sample Unit

A behavioral observation sample is one closed chat trace, not one tool event.

```text
BehavioralSample =
  task.started(kind='chat')
  + traceId
  + task.completed(kind='chat')
  + complete event window for that trace
```

`observationCount` is defined as the number of valid `BehavioralSample` records.

### 4.2 Valid Sample Rules

A trace counts toward `observationCount` only when all of the following are true:

- `task.started(kind='chat')` exists
- `task.completed(kind='chat')` exists for the same `traceId`
- the trace window is closed and queryable from `evaluation_events`
- required event timestamps are internally ordered well enough for sequence reconstruction

### 4.3 Invalid or Excluded Samples

The following do not count toward `observationCount`:

- traces missing either chat boundary event
- partial traces cut off by collection-window boundaries
- traces abandoned before `task.completed`
- traces whose required evidence is incomplete for sequence reconstruction

These traces are not discarded from storage. They remain in `evaluation_events` and may appear in the derived artifact as rejected or incomplete samples, but they do not satisfy the behavioral gate.

### 4.4 Failure and Timeout Semantics

- `task.completed(kind='chat', outcome='failed')` may be retained as a closed trace for audit purposes.
- A failed trace does not automatically count as a valid behavioral sample.
- It counts only if the event sufficiency contract for sequence reconstruction is still satisfied.
- Timeouts or execution failures without a closed trace are classified as incomplete evidence, not negative behavioral proof.

This keeps `observationCount` tied to evidence quality rather than raw runtime volume.

## 5. Event Sufficiency Contract

Behavioral evidence must not be fabricated from sparse telemetry. If the required event set is missing, the result is `incomplete evidence`.

### 5.1 Required Event Families

The behavioral pipeline relies on these canonical event families:

- `task.started`
- `task.completed`
- `tool.invoked`
- `tool.completed`
- `capability.invoked`
- `capability.completed`
- `guardrail.action_delivered`
- `guardrail.action_delivery_failed`
- `agent.response`
- `evolution.policy.decision`
- `guardrail.outcome.observed`

### 5.2 Reconstruction Rules

- `sequence` may be derived only from events present inside one closed `traceId`.
- `fingerprint` may be derived only from a valid reconstructed `sequence`.
- `divergence` may be detected only from comparable fingerprints or sequence families.
- `decision impact` may be derived only through explicit `traceId` and `decisionId` linkage.

### 5.3 Missing Evidence Semantics

If one or more required event families are missing, the analyzer must produce one of the following states instead of synthesizing behavior:

- `incomplete_sample`
- `insufficient_for_fingerprint`
- `insufficient_for_divergence`
- `insufficient_for_decision_impact`

Absence of evidence is not evidence of stability.

## 6. Derived Behavioral Contract

Sequence, fingerprint, and divergence are behavioral evidence products, but they do not belong in runtime identity.

### 6.1 Sequence

`sequence` is a normalized representation of a closed trace's behavioral path, derived from factual events for that `traceId`.

The sequence contract should be stable at the semantic level:

- preserve event order relevant to behavior
- normalize tool and capability steps into a replayable path description
- keep references back to source event ids or sequence positions

### 6.2 Fingerprint

`fingerprint` is a stable encoding of a normalized sequence family.

Rules:

- fingerprint generation is analyzer-owned
- fingerprint versions may evolve without changing runtime events
- historical traces must remain replayable under newer analyzer versions

### 6.3 Divergence

The analyzer is responsible for divergence detection only.

It may:

- detect that a trace differs from the expected sequence family
- classify divergence at a technical level such as new sequence family or unexpected branch

It may not:

- interpret whether divergence is good, bad, or policy-relevant
- decide whether a divergence justifies M5.7 v2

Interpretation belongs to the review layer.

### 6.4 Decision Impact

Behavior evidence must remain separate from `DecisionIdentity`.

`decision impact` is a derived join over:

- `traceId`
- `decisionId`
- `policyVersion`
- `evolution.policy.decision`
- `guardrail.action_delivered` or `guardrail.action_delivery_failed`
- `guardrail.outcome.observed`

If this join cannot be completed, the correct result is `insufficient_for_decision_impact`, not `no impact`.

## 7. Derived Artifact Contract

The derived behavioral artifact is a review projection, not a source ledger.

Recommended materialization:

```text
pipeline_data/behavioral-observation.json
```

Example shape:

```json
{
  "sampleCount": 0,
  "rejectedSampleCount": 0,
  "incompleteEvidenceCount": 0,
  "sequenceFamilies": {},
  "fingerprintDistribution": {},
  "divergenceSummary": {},
  "decisionImpactSummary": {},
  "traceRefs": []
}
```

Rules:

- every derived aggregate must be traceable back to one or more `traceId` values
- every `traceId` must be replayable back to `evaluation_events`
- artifacts may summarize, but may not invent facts not present in the ledger
- artifact regeneration must be possible from the event ledger alone

## 8. Gate Relationship

The M5.7 behavioral gate remains unchanged:

```text
observationCount >= 100
```

This gate applies to valid behavioral samples only. It must not be replaced by tool-event volume, wall-clock duration, or artifact file count.

### 8.1 What Coverage Review Already Answers

Coverage review already established:

- tool-event coverage surface is stable
- `browser_evaluate` is a fixed catalog completeness edge case
- no source mismatch is present
- no systemic mapping failure has been observed

These findings remain frozen and are not reopened by this design.

### 8.2 What Behavioral Gate Still Needs

Behavioral validation remains pending until enough valid samples exist to assess:

- sequence family stability
- fingerprint distribution behavior
- divergence presence or absence
- decision-impact evidence

## 9. Non-Goals and Invariants

This design freezes the following invariants:

- M5.7 v1 remains frozen, not closed
- coverage review remains passed and unchanged
- analyzer revisions must not require runtime fact-schema reinterpretation beyond declared event contracts
- runtime must not emit experiment interpretation as fact
- review may interpret divergence, but the analyzer may only detect it

This design explicitly does not do the following:

- close M5.7 based on coverage evidence alone
- narrow M5.7 to coverage-only without an explicit scope decision
- patch catalog gaps during the observation-only window
- redefine the behavioral gate using auxiliary metrics

## 10. Next Step

After this contract is approved, the next stage is implementation planning for:

- restoring required chat-boundary facts into `evaluation_events`
- building the offline analyzer that validates sample sufficiency
- materializing `pipeline_data/behavioral-observation.json`

Implementation planning must preserve the contract in this document and must not treat analyzer implementation convenience as grounds to weaken evidence semantics.
