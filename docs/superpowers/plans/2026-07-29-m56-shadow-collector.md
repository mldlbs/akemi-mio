# M5.6.3 Shadow Collector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shadow-only capability aggregation collector for Evolution that records observation runs without changing the formal ProblemQueue or executor path.

**Architecture:** Build a parallel observation path that reads capability-enriched tool telemetry, aggregates it into capability buckets, persists shadow runs to an observation store, and executes alongside the main pipeline without emitting `Problem[]` into the queue. Keep existing tool-based collectors, executors, and `problemId` behavior unchanged.

**Tech Stack:** TypeScript, Vitest, existing Evolution pipeline, ToolCallLogStore, BehaviorPredictor, Node filesystem persistence.

---

### Task 1: Lock the shadow collector contract with tests

**Files:**
- Create: `src/main/evolution/automation/__tests__/CapabilityEvolutionShadowCollector.test.ts`
- Create: `src/main/evolution/automation/__tests__/PipelineShadowCollector.test.ts`

- [ ] **Step 1: Write the failing aggregation test**

```ts
it('aggregates capability-aware tool events into capability observations and summary metrics', async () => {
  const run = await collector.collect()

  expect(run.summary.totalToolEvents).toBe(9)
  expect(run.summary.capabilityEvents).toBe(8)
  expect(run.summary.coverageRate).toBeCloseTo(8 / 9, 5)
  expect(run.summary.legacyBucketCount).toBe(4)
  expect(run.summary.capabilityBucketCount).toBe(2)
  expect(run.summary.aggregationGain).toBe(2)
  expect(run.summary.trendCorrelation).toBeCloseTo(1, 5)

  expect(run.observations[0]).toMatchObject({
    capabilityIdentity: { capability: 'file.management' },
    legacyIdentity: { tools: ['edit_file', 'write_file'] },
  })
})
```

- [ ] **Step 2: Write the failing persistence test**

```ts
it('persists shadow runs to the observation store', async () => {
  const run = await collector.collect()
  const stored = store.getLatest()

  expect(stored?.runId).toBe(run.runId)
  expect(stored?.observations.length).toBe(run.observations.length)
})
```

- [ ] **Step 3: Write the failing pipeline shadow-only test**

```ts
it('runs shadow collectors without pushing observations into ProblemQueue', async () => {
  pipeline.addShadowCollector(fakeShadowCollector)
  const metrics = await pipeline.runOnce()

  expect(metrics.totalCollected).toBe(0)
  expect(pipeline['queue'].size).toBe(0)
  expect(shadowEvents[0].collectorName).toBe('fake-shadow')
  expect(shadowEvents[0].observationCount).toBe(1)
})
```

- [ ] **Step 4: Run tests to verify RED**

Run:

```bash
npm test -- src/main/evolution/automation/__tests__/CapabilityEvolutionShadowCollector.test.ts src/main/evolution/automation/__tests__/PipelineShadowCollector.test.ts
```

Expected: fail because the shadow collector, store, and pipeline hook do not exist yet.

### Task 2: Implement the shadow collector and store

**Files:**
- Create: `src/main/evolution/automation/CapabilityEvolutionShadowCollector.ts`
- Create: `src/main/evolution/automation/CapabilityEvolutionShadowStore.ts`
- Modify: `src/main/evolution/automation/types.ts`
- Modify: `src/main/evolution/automation/PipelineOrchestrator.ts`

- [ ] **Step 1: Add shadow observation types**

```ts
export interface CapabilityEvolutionShadowObservation { ... }
export interface CapabilityEvolutionShadowRun { ... }
export interface ShadowObservationCollector { ... }
export interface ShadowCollectorExecutionEvent { ... }
```

- [ ] **Step 2: Implement the persistent observation store**

```ts
class CapabilityEvolutionShadowStore {
  save(run: CapabilityEvolutionShadowRun): void
  getLatest(): CapabilityEvolutionShadowRun | null
  getAll(): CapabilityEvolutionShadowRun[]
}
```

- [ ] **Step 3: Implement capability aggregation logic**

Rules:
- coverage uses `capabilityEvents / totalToolEvents`
- capability buckets group by `capability`
- legacy buckets count unique `toolName`
- aggregation gain = `legacyBucketCount - capabilityBucketCount`
- trend correlation compares legacy per-tool error trends against aggregated capability error rates

- [ ] **Step 4: Implement the collector wrapper**

```ts
class CapabilityEvolutionShadowCollector implements ShadowObservationCollector {
  shouldRun(): boolean
  collect(): Promise<CapabilityEvolutionShadowRun>
}
```

- [ ] **Step 5: Hook shadow collectors into PipelineOrchestrator**

Behavior:
- add `addShadowCollector()`
- run shadow collectors in parallel with regular collector phase
- emit `pipeline.shadow_collector.executed`
- do not push anything into `ProblemQueue`
- do not modify `totalCollected`

### Task 3: Verify shadow-only behavior and focused regressions

**Files:**
- Create: `scripts/m56-shadow-observe.ts`

- [ ] **Step 1: Re-run targeted tests**

Run:

```bash
npm test -- src/main/evolution/automation/__tests__/CapabilityEvolutionShadowCollector.test.ts src/main/evolution/automation/__tests__/PipelineShadowCollector.test.ts
```

Expected: pass.

- [ ] **Step 2: Run nearby pipeline regression**

Run:

```bash
npm test -- src/main/evolution/automation/__tests__/Step3E2EVerification.test.ts
```

Expected: pass, showing main collector/queue behavior is unchanged.

- [ ] **Step 3: Add a thin observation reader**

```bash
npx tsx scripts/m56-shadow-observe.ts
```

Expected: prints the latest stored shadow observation run with coverage, aggregation gain, and trend correlation.
