# M5.7 Passive Observation Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only offline monitor that compares current M5.7 behavioral evidence with the frozen `sampleCount = 103` baseline and emits either `Continue Freeze` or `Evidence Review Required`.

**Architecture:** Query `evaluation_events` and rebuild the current behavioral snapshot with the existing `BehavioralObservationWriter` helpers. Read the persisted `behavioral-observation.json` as a consistency input, then pass the validated current snapshot and a tracked baseline into a pure `PassiveObservationMonitor`. Write a new derived `passive-review.json` or dated passive snapshot without changing runtime, the event ledger, or the existing behavioral artifact schema.

**Tech Stack:** TypeScript, Vitest, existing `EvaluationStore`, existing behavioral snapshot builder, filesystem JSON artifacts under `reports/m57/observation`

---

## File Map

- Create: `src/main/core/evaluation/PassiveObservationMonitor.ts`
  - pure baseline/current comparison
  - incomplete-evidence threshold
  - new fingerprint and blind-spot detection
  - review trigger decision
- Create: `src/main/core/evaluation/PassiveObservationBaseline.ts`
  - tracked M5.7 Evidence Review baseline
  - baseline sample count, trace count, incomplete evidence count, and fingerprint distribution
- Create: `src/main/core/evaluation/PassiveObservationReviewWriter.ts`
  - deterministic JSON report serialization
  - default report path and dated snapshot path
- Create: `src/main/core/evaluation/__tests__/PassiveObservationMonitor.test.ts`
  - pure monitor trigger matrix tests
- Create: `src/main/core/evaluation/__tests__/PassiveObservationReviewWriter.test.ts`
  - report shape and output path tests
- Create: `scripts/m57-passive-observation-review.ts`
  - read-only CLI
  - query `evaluation_events`
  - validate persisted behavioral artifact
  - build and write passive review report
- Modify: `.agents/PROJECT.md`
  - record monitor implementation and baseline decision

## Data Contracts

Use these interfaces in `PassiveObservationMonitor.ts`:

```ts
export type PassiveObservationDecision = 'Continue Freeze' | 'Evidence Review Required'

export interface PassiveObservationBaseline {
  sampleCount: number
  traceCount: number
  incompleteEvidenceCount: number
  fingerprintDistribution: Record<string, number>
}

export interface PassiveObservationCurrent {
  sampleCount: number
  traceCount: number
  incompleteEvidenceCount: number
  fingerprintDistribution: Record<string, number>
  divergenceCount: number
  decisionImpactCount: number
}

export interface PassiveObservationReport {
  schemaVersion: 1
  generatedAt: string
  baseline: {
    sampleCount: number
    traceCount: number
    incompleteEvidenceRate: number
  }
  current: {
    sampleCount: number
    traceCount: number
    incompleteEvidenceCount: number
    incompleteEvidenceRate: number
    fingerprintDistribution: Record<string, number>
    newFingerprintCount: number
    divergenceCount: number
    decisionImpactCount: number
    blindSpotCount: number
  }
  comparison: {
    newIncompleteEvidenceCount: number
    incompleteEvidenceRateDelta: number
    repeatedNewFingerprintCount: number
  }
  decision: PassiveObservationDecision
  triggers: string[]
}
```

The monitor must calculate:

```ts
const baselineRate = baseline.incompleteEvidenceCount / baseline.traceCount
const currentRate = current.incompleteEvidenceCount / current.traceCount
const incompleteRateDelta = currentRate - baselineRate
const newIncompleteEvidenceCount = Math.max(
  0,
  current.incompleteEvidenceCount - baseline.incompleteEvidenceCount,
)
```

`traceCount` must be positive. A zero denominator is an invalid input and must fail closed.

Fingerprint rules:

```ts
const newFingerprints = Object.keys(current.fingerprintDistribution)
  .filter((fingerprint) => !(fingerprint in baseline.fingerprintDistribution))

const repeatedNewFingerprints = newFingerprints.filter(
  (fingerprint) => current.fingerprintDistribution[fingerprint] >= 3,
)

const newFingerprintCount = newFingerprints.length
const repeatedNewFingerprintCount = repeatedNewFingerprints.length
const blindSpotCount = repeatedNewFingerprintCount
```

Trigger rules:

```ts
if (current.divergenceCount > 0) {
  triggers.push('divergence_detected')
}

if (current.decisionImpactCount > 0) {
  triggers.push('decision_impact_detected')
}

if (repeatedNewFingerprintCount > 0) {
  triggers.push('repeated_new_fingerprint')
}

if (incompleteRateDelta >= 0.10 && newIncompleteEvidenceCount >= 5) {
  triggers.push('incomplete_evidence_regression')
}
```

The decision is `Evidence Review Required` when `triggers.length > 0`; otherwise it is `Continue Freeze`.

## Task 1: Add the Tracked Baseline and Pure Monitor

**Files:**
- Create: `src/main/core/evaluation/PassiveObservationBaseline.ts`
- Create: `src/main/core/evaluation/PassiveObservationMonitor.ts`
- Test: `src/main/core/evaluation/__tests__/PassiveObservationMonitor.test.ts`

- [ ] **Step 1: Write failing tests for the stable baseline**

```ts
import { describe, expect, it } from 'vitest'
import { evaluatePassiveObservation } from '../PassiveObservationMonitor'

const baseline = {
  sampleCount: 103,
  traceCount: 304,
  incompleteEvidenceCount: 201,
  fingerprintDistribution: {
    response: 93,
    'tool:file_management>response': 3,
  },
}

const current = {
  sampleCount: 104,
  traceCount: 305,
  incompleteEvidenceCount: 201,
  fingerprintDistribution: {
    response: 94,
    'tool:file_management>response': 3,
  },
  divergenceCount: 0,
  decisionImpactCount: 0,
}

describe('PassiveObservationMonitor', () => {
  it('continues freeze when no trigger signal is present', () => {
    const report = evaluatePassiveObservation(baseline, current, '2026-08-03T00:00:00.000Z')

    expect(report.decision).toBe('Continue Freeze')
    expect(report.triggers).toEqual([])
    expect(report.current.newFingerprintCount).toBe(0)
  })
})
```

- [ ] **Step 2: Run the focused test and verify the expected missing-module failure**

Run:

```powershell
npx vitest run src/main/core/evaluation/__tests__/PassiveObservationMonitor.test.ts
```

Expected: FAIL because `PassiveObservationMonitor.ts` does not exist yet.

- [ ] **Step 3: Add the tracked baseline constant**

Create `PassiveObservationBaseline.ts`:

```ts
import type { PassiveObservationBaseline } from './PassiveObservationMonitor'

export const M57_PASSIVE_OBSERVATION_BASELINE: PassiveObservationBaseline = {
  sampleCount: 103,
  traceCount: 304,
  incompleteEvidenceCount: 201,
  fingerprintDistribution: {
    response: 93,
    'tool:file_management>response': 3,
    'tool:file_management>tool:file_management>tool:system_execution>response': 1,
    'tool:system_execution>response': 2,
    'tool:system_execution>tool:file_management>response': 1,
    'tool:system_execution>tool:system_execution>response': 3,
  },
}
```

- [ ] **Step 4: Implement the pure monitor function**

Create `PassiveObservationMonitor.ts` with:

```ts
export function evaluatePassiveObservation(
  baseline: PassiveObservationBaseline,
  current: PassiveObservationCurrent,
  generatedAt: string,
): PassiveObservationReport {
  validateInput(baseline, 'baseline')
  validateInput(current, 'current')

  const baselineRate = baseline.incompleteEvidenceCount / baseline.traceCount
  const currentRate = current.incompleteEvidenceCount / current.traceCount
  const incompleteRateDelta = currentRate - baselineRate
  const newIncompleteEvidenceCount = Math.max(
    0,
    current.incompleteEvidenceCount - baseline.incompleteEvidenceCount,
  )

  const newFingerprints = Object.keys(current.fingerprintDistribution).filter(
    (fingerprint) => !(fingerprint in baseline.fingerprintDistribution),
  )
  const repeatedNewFingerprintCount = newFingerprints.filter(
    (fingerprint) => current.fingerprintDistribution[fingerprint] >= 3,
  ).length

  const triggers: string[] = []
  if (current.divergenceCount > 0) triggers.push('divergence_detected')
  if (current.decisionImpactCount > 0) triggers.push('decision_impact_detected')
  if (repeatedNewFingerprintCount > 0) triggers.push('repeated_new_fingerprint')
  if (incompleteRateDelta >= 0.10 && newIncompleteEvidenceCount >= 5) {
    triggers.push('incomplete_evidence_regression')
  }

  return {
    schemaVersion: 1,
    generatedAt,
    baseline: {
      sampleCount: baseline.sampleCount,
      traceCount: baseline.traceCount,
      incompleteEvidenceRate: baselineRate,
    },
    current: {
      sampleCount: current.sampleCount,
      traceCount: current.traceCount,
      incompleteEvidenceCount: current.incompleteEvidenceCount,
      incompleteEvidenceRate: currentRate,
      fingerprintDistribution: sortRecord(current.fingerprintDistribution),
      newFingerprintCount: newFingerprints.length,
      divergenceCount: current.divergenceCount,
      decisionImpactCount: current.decisionImpactCount,
      blindSpotCount: repeatedNewFingerprintCount,
    },
    comparison: {
      newIncompleteEvidenceCount,
      incompleteEvidenceRateDelta: incompleteRateDelta,
      repeatedNewFingerprintCount,
    },
    decision: triggers.length > 0 ? 'Evidence Review Required' : 'Continue Freeze',
    triggers,
  }
}
```

`validateInput` must reject non-finite counts, negative counts, zero trace counts, and malformed fingerprint values. `sortRecord` must return stable key ordering.

- [ ] **Step 5: Add trigger matrix tests**

Add tests for:

```ts
it('requires review for a repeated new fingerprint', () => {
  const report = evaluatePassiveObservation(baseline, {
    ...current,
    fingerprintDistribution: {
      ...current.fingerprintDistribution,
      'tool:search_retrieval>response': 3,
    },
  }, '2026-08-03T00:00:00.000Z')

  expect(report.decision).toBe('Evidence Review Required')
  expect(report.triggers).toContain('repeated_new_fingerprint')
})

it('records but does not trigger on a one-off new fingerprint', () => {
  const report = evaluatePassiveObservation(baseline, {
    ...current,
    fingerprintDistribution: {
      ...current.fingerprintDistribution,
      'tool:search_retrieval>response': 1,
    },
  }, '2026-08-03T00:00:00.000Z')

  expect(report.decision).toBe('Continue Freeze')
  expect(report.current.newFingerprintCount).toBe(1)
  expect(report.current.blindSpotCount).toBe(0)
})

it('requires review for divergence or decision impact', () => {
  expect(evaluatePassiveObservation(
    baseline,
    { ...current, divergenceCount: 1 },
    '2026-08-03T00:00:00.000Z',
  ).triggers).toContain('divergence_detected')

  expect(evaluatePassiveObservation(
    baseline,
    { ...current, decisionImpactCount: 1 },
    '2026-08-03T00:00:00.000Z',
  ).triggers).toContain('decision_impact_detected')
})
```

- [ ] **Step 6: Add incomplete-evidence threshold tests**

```ts
it('requires both incomplete-evidence threshold conditions', () => {
  const baselineRate = baseline.incompleteEvidenceCount / baseline.traceCount

  const belowRate = evaluatePassiveObservation(baseline, {
    ...current,
    traceCount: 304,
    incompleteEvidenceCount: 231,
  }, '2026-08-03T00:00:00.000Z')
  expect(belowRate.current.incompleteEvidenceRate - baselineRate).toBeLessThan(0.10)
  expect(belowRate.triggers).not.toContain('incomplete_evidence_regression')

  const belowCount = evaluatePassiveObservation(baseline, {
    ...current,
    traceCount: 304,
    incompleteEvidenceCount: 236,
  }, '2026-08-03T00:00:00.000Z')
  expect(belowCount.current.incompleteEvidenceRate - baselineRate).toBeGreaterThanOrEqual(0.10)
  expect(belowCount.comparison.newIncompleteEvidenceCount).toBe(35)
  expect(belowCount.triggers).toContain('incomplete_evidence_regression')
})
```

Add the exact absolute-count boundary case:

```ts
it('does not trigger when the rate delta is high but fewer than five new incomplete traces exist', () => {
  const report = evaluatePassiveObservation(baseline, {
    ...current,
    traceCount: 269,
    incompleteEvidenceCount: 205,
  }, '2026-08-03T00:00:00.000Z')

  expect(report.current.incompleteEvidenceRate - (201 / 304)).toBeGreaterThanOrEqual(0.10)
  expect(report.comparison.newIncompleteEvidenceCount).toBe(4)
  expect(report.triggers).not.toContain('incomplete_evidence_regression')
})
```

For the absolute-count condition, set `incompleteEvidenceCount` to `205` and `traceCount` to `304` in a second case. The rate delta is below 10 percentage points, so this proves that the two conditions remain conjunctive.

```ts
it('does not trigger when fewer than five new incomplete traces exist and the rate delta is low', () => {
  const report = evaluatePassiveObservation(baseline, {
    ...current,
    traceCount: 304,
    incompleteEvidenceCount: 205,
  }, '2026-08-03T00:00:00.000Z')

  expect(report.comparison.newIncompleteEvidenceCount).toBe(4)
  expect(report.current.incompleteEvidenceRate - (201 / 304)).toBeLessThan(0.10)
  expect(report.triggers).not.toContain('incomplete_evidence_regression')
})
```

- [ ] **Step 7: Run the focused monitor tests**

Run:

```powershell
npx vitest run src/main/core/evaluation/__tests__/PassiveObservationMonitor.test.ts
```

Expected: all monitor unit tests pass.

## Task 2: Add the Read-Only Report Writer

**Files:**
- Create: `src/main/core/evaluation/PassiveObservationReviewWriter.ts`
- Test: `src/main/core/evaluation/__tests__/PassiveObservationReviewWriter.test.ts`

- [ ] **Step 1: Write the failing writer test**

```ts
import { mkdtemp, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import { PassiveObservationReviewWriter } from '../PassiveObservationReviewWriter'

describe('PassiveObservationReviewWriter', () => {
  it('writes the default passive review report without changing source files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'm57-passive-'))
    const writer = new PassiveObservationReviewWriter(directory)
    const report = {
      schemaVersion: 1,
      generatedAt: '2026-08-03T00:00:00.000Z',
      baseline: { sampleCount: 103, traceCount: 304, incompleteEvidenceRate: 0.661184 },
      current: {
        sampleCount: 103,
        traceCount: 304,
        incompleteEvidenceCount: 201,
        incompleteEvidenceRate: 0.661184,
        fingerprintDistribution: { response: 93 },
        newFingerprintCount: 0,
        divergenceCount: 0,
        decisionImpactCount: 0,
        blindSpotCount: 0,
      },
      comparison: {
        newIncompleteEvidenceCount: 0,
        incompleteEvidenceRateDelta: 0,
        repeatedNewFingerprintCount: 0,
      },
      decision: 'Continue Freeze' as const,
      triggers: [],
    }

    const output = await writer.write(report)
    expect(output).toBe(join(directory, 'passive-review.json'))
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(report)
  })
})
```

- [ ] **Step 2: Run the writer test and verify the missing-module failure**

Run:

```powershell
npx vitest run src/main/core/evaluation/__tests__/PassiveObservationReviewWriter.test.ts
```

Expected: FAIL because the writer module does not exist yet.

- [ ] **Step 3: Implement default and snapshot output**

Implement:

```ts
import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { PassiveObservationReport } from './PassiveObservationMonitor'

export class PassiveObservationReviewWriter {
  constructor(private readonly persistDir: string) {}

  async write(report: PassiveObservationReport, fileName = 'passive-review.json'): Promise<string> {
    const outputPath = join(this.persistDir, fileName)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    return outputPath
  }
}
```

The CLI will pass a dated filename such as `passive-observation/2026-08-03.json` to the same writer. The writer must not read or mutate source artifacts.

- [ ] **Step 4: Run writer tests**

Run:

```powershell
npx vitest run src/main/core/evaluation/__tests__/PassiveObservationReviewWriter.test.ts
```

Expected: all writer tests pass.

## Task 3: Add the Read-Only CLI and Artifact Consistency Check

**Files:**
- Create: `scripts/m57-passive-observation-review.ts`
- Test: `src/main/core/evaluation/__tests__/m57-passive-observation-review-runner.test.ts`

The runner exposes this testable API:

```ts
export interface PassiveObservationReviewRunnerOptions {
  currentArtifactPath: string
  outputPath: string
  createStore?: () => BehavioralObservationStore
  now?: () => string
}

export async function runPassiveObservationReview(
  options: PassiveObservationReviewRunnerOptions,
): Promise<{ outputPath: string; report: PassiveObservationReport }>
```

- [ ] **Step 1: Write failing runner tests**

The runner tests must inject a fake store and temporary artifact files. Cover:

```ts
it('rebuilds current evidence from the event ledger and writes Continue Freeze', async () => {
  const result = await runPassiveObservationReview({
    currentArtifactPath,
    outputPath,
    createStore: () => storeWithStableEvents,
    now: () => '2026-08-03T00:00:00.000Z',
  })

  expect(result.report.decision).toBe('Continue Freeze')
  expect(result.outputPath).toBe(outputPath)
})

it('fails closed when the persisted behavioral artifact disagrees with the ledger snapshot', async () => {
  await expect(runPassiveObservationReview({
    currentArtifactPath: staleArtifactPath,
    outputPath,
    createStore: () => storeWithStableEvents,
  })).rejects.toThrow(/behavioral artifact mismatch/i)
})
```

- [ ] **Step 2: Run runner tests and verify the missing-module failure**

Run:

```powershell
npx vitest run src/main/core/evaluation/__tests__/m57-passive-observation-review-runner.test.ts
```

Expected: FAIL because the runner module does not exist yet.

- [ ] **Step 3: Implement the runner**

The runner must:

1. Set `USER_DATA_DIR` using the same resolution logic as `m57-behavioral-observation.ts`.
2. Initialize the database and `EvaluationStore`.
3. Query all `evaluation_events` with `QUERY_NO_LIMIT`.
4. Build a fresh current snapshot with `buildBehavioralObservationSnapshot(events)`.
5. Read and parse the existing `behavioral-observation.json`.
6. Compare the persisted snapshot to the fresh snapshot for gate-relevant fields:
   - `sampleCount`
   - `rejectedSampleCount`
   - `incompleteEvidenceCount`
   - `sequenceFamilies`
   - `fingerprintDistribution`
   - `divergenceSummary`
   - `decisionImpactSummary`
   - `traceRefs`
7. Fail closed on mismatch.
8. Map the validated snapshot to `PassiveObservationCurrent`:

```ts
const current = {
  sampleCount: snapshot.sampleCount,
  traceCount: snapshot.traceRefs.length,
  incompleteEvidenceCount: snapshot.incompleteEvidenceCount,
  fingerprintDistribution: snapshot.fingerprintDistribution,
  divergenceCount: snapshot.divergenceSummary.detectedCount,
  decisionImpactCount: snapshot.decisionImpactSummary.derivedCount,
}
```

9. Call `evaluatePassiveObservation(M57_PASSIVE_OBSERVATION_BASELINE, current, now())`.
10. Write `passive-review.json` by default or a dated snapshot when `--snapshotDate=YYYY-MM-DD` is supplied.
11. Shut down the store and database in `finally`, preserving the first failure.

The CLI must never call `EvaluationEmitter`, update `evaluation_events`, or rewrite `behavioral-observation.json`.

- [ ] **Step 4: Run runner tests**

Run:

```powershell
npx vitest run src/main/core/evaluation/__tests__/m57-passive-observation-review-runner.test.ts
```

Expected: all runner tests pass.

- [ ] **Step 5: Run the CLI against the isolated baseline**

Run:

```powershell
$env:USER_DATA_DIR='D:\work\code\akemi-mio\.worktrees\m57-observation-runner'
npx tsx scripts/m57-passive-observation-review.ts `
  --artifact=D:\work\code\akemi-mio\evolution_workspace\pipeline_data\behavioral-observation.json `
  --output=D:\work\code\akemi-mio\reports\m57\observation\passive-review.json
```

Expected:

```text
decision = Continue Freeze
triggers = []
sampleCount = 103
```

## Task 4: Full Verification and Project Record

**Files:**
- Modify: `.agents/PROJECT.md`

- [ ] **Step 1: Run the complete monitor test set**

Run:

```powershell
npx vitest run `
  src/main/core/evaluation/__tests__/PassiveObservationMonitor.test.ts `
  src/main/core/evaluation/__tests__/PassiveObservationReviewWriter.test.ts `
  src/main/core/evaluation/__tests__/m57-passive-observation-review-runner.test.ts `
  src/main/core/evaluation/__tests__/BehavioralEvidenceAnalyzer.test.ts `
  src/main/core/evaluation/__tests__/BehavioralObservationWriter.test.ts
```

Expected: all listed files pass with zero failed tests.

- [ ] **Step 2: Verify source immutability**

Run:

```powershell
git diff -- `
  src/main/agent/ChatExecutor.ts `
  src/main/core/evaluation/BehavioralEvidenceAnalyzer.ts `
  evolution_workspace/pipeline_data/behavioral-observation.json
```

Expected: the monitor implementation does not add runtime, analyzer, or source-artifact mutations.

- [ ] **Step 3: Append the project activity record**

Add one `.agents/PROJECT.md` row recording:

```text
M5.7 Passive Observation Monitor v1 implemented as read-only offline review
Baseline: sampleCount=103, incompleteEvidenceRate=201/304
Default decision: Continue Freeze
Trigger rules: divergence, decision impact, repeated new fingerprint, or incomplete-evidence regression
Runtime/evidence source unchanged
```

- [ ] **Step 4: Run final verification**

Run:

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors; unrelated pre-existing worktree changes remain untouched.

## Self-Review

Spec coverage:

- read-only data flow -> Task 3
- explicit frozen baseline -> Task 1
- current metrics and comparison fields -> Task 1
- divergence, decision impact, new fingerprint, and incomplete-evidence triggers -> Task 1
- report artifact and dated snapshots -> Task 2 and Task 3
- fail-closed behavior -> Task 1 and Task 3
- tests and source immutability -> Task 4
- no runtime/schema/M5.8 changes -> all task boundaries

Placeholder scan:

- no TODO, TBD, or implementation-later steps
- every code change has an exact file path and test command
- every trigger threshold is numeric and testable

Type consistency:

- `PassiveObservationBaseline` is imported by the tracked baseline constant and the pure evaluator
- `PassiveObservationCurrent` maps directly from `BehavioralObservationSnapshot`
- `PassiveObservationReport` is the only writer input and CLI output
- trigger names are stable string literals used by tests and report consumers

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-03-m57-passive-observation-monitor.md`.

Execution options:

1. Subagent-Driven (recommended): dispatch one fresh subagent per task and review between tasks.
2. Inline Execution: execute the plan in this session with checkpoints.
