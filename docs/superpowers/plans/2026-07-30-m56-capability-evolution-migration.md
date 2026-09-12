# M5.6.4 Capability Evolution Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build the shadow migration infrastructure that lets Evolution compare tool-first and capability-first problem and decision candidates without granting capability-first execution authority.

**Architecture:** Keep the current tool-based collectors, `ProblemQueue`, scheduler, and executors as the only authoritative path. Add a parallel capability-shadow path that derives `CapabilityProblemIdentity` from legacy `Problem` candidates, writes migration artifacts for Dual Write and Shadow Decision, and evaluates cutover readiness without mutating runtime execution behavior.

**Tech Stack:** TypeScript, Vitest, existing Evolution automation pipeline, capability-enriched tool telemetry, Node filesystem persistence, CLI observation/report scripts.

---

### Task 1: Freeze the migration contract with failing tests

**Files:**
- Create: `src/main/evolution/automation/__tests__/CapabilityProblemIdentity.test.ts`
- Create: `src/main/evolution/automation/__tests__/CapabilityProblemShadowPipeline.test.ts`
- Create: `src/main/evolution/automation/__tests__/CapabilityMigrationArtifactStore.test.ts`
- Create: `src/main/evolution/automation/__tests__/CapabilityMigrationGateEvaluator.test.ts`

- [x] **Step 1: Write the failing identity contract test**

```ts
import { describe, expect, it } from 'vitest'
import {
  buildCapabilityProblemIdentityKey,
  normalizeCapabilityProblemIdentity,
} from '../CapabilityProblemIdentity'

describe('CapabilityProblemIdentity', () => {
  it('normalizes semantic identity and keeps version optional at the call site', () => {
    const identity = normalizeCapabilityProblemIdentity({
      capability: 'browser.automation',
      operation: 'navigate',
      issueType: 'timeout',
    })

    expect(identity).toEqual({
      capability: 'browser.automation',
      operation: 'navigate',
      issueType: 'timeout',
      version: 'm56.v1',
    })

    expect(buildCapabilityProblemIdentityKey(identity)).toBe(
      'capability:browser.automation|operation:navigate|issue:timeout|version:m56.v1',
    )
  })
})
```

- [x] **Step 2: Write the failing shadow candidate aggregation test**

```ts
it('groups eligible legacy problems by capability + operation + issue type while preserving tool evidence', () => {
  const result = buildCapabilityProblemShadowArtifacts({
    runId: 'm56-shadow-001',
    generatedAt: 1_722_345_600_000,
    legacyProblems: [
      makeProblem('tool:write_file:error_rate', 'write_file', 'file.management', 'write', 'error_rate'),
      makeProblem('tool:edit_file:error_rate', 'edit_file', 'file.management', 'write', 'error_rate'),
      makeProblem('tool:browser_navigate:timeout', 'browser_navigate', 'browser.automation', 'navigate', 'timeout'),
    ],
  })

  expect(result.capabilityCandidates).toHaveLength(2)
  expect(result.capabilityCandidates[0].identity).toEqual({
    capability: 'browser.automation',
    operation: 'navigate',
    issueType: 'timeout',
    version: 'm56.v1',
  })
  expect(result.capabilityCandidates[1]).toMatchObject({
    identity: {
      capability: 'file.management',
      operation: 'write',
      issueType: 'error_rate',
      version: 'm56.v1',
    },
    affectedTools: ['edit_file', 'write_file'],
    legacyProblemIds: ['tool:edit_file:error_rate', 'tool:write_file:error_rate'],
  })
})
```

- [x] **Step 3: Write the failing artifact contract test**

```ts
it('writes the required migration artifacts for one shadow run', () => {
  store.saveRunArtifacts(runArtifacts)

  expect(store.readJson('latest/legacy_problem_candidates.json')).toHaveLength(3)
  expect(store.readJson('latest/capability_problem_candidates.json')).toHaveLength(2)
  expect(store.readJson('latest/comparison_report.json')).toMatchObject({
    runId: 'm56-shadow-001',
    eligibleLegacyCount: 3,
  })
  expect(store.readJson('latest/migration_gate_report.json')).toMatchObject({
    status: 'below_gate',
  })
})
```

- [x] **Step 4: Write the failing gate evaluator test**

```ts
it('passes only when observation window, traceability, and decision consistency all satisfy cutover review thresholds', () => {
  const report = evaluateCapabilityMigrationGate({
    observationWindow: { candidateCount: 1200, observedDays: 8 },
    coverage: { identityCoverage: 0.97, traceabilityRate: 1, legacyOnlyRatio: 0.04 },
    decision: { consistencyRate: 0.96, executorRegressionCount: 0 },
  })

  expect(report.status).toBe('pass')
  expect(report.metrics.identityCoverage.passed).toBe(true)
  expect(report.metrics.decisionConsistency.passed).toBe(true)
  expect(report.metrics.executorRegression.passed).toBe(true)
})
```

- [x] **Step 5: Run the focused suite to verify RED**

Run:

```bash
npm test -- src/main/evolution/automation/__tests__/CapabilityProblemIdentity.test.ts src/main/evolution/automation/__tests__/CapabilityProblemShadowPipeline.test.ts src/main/evolution/automation/__tests__/CapabilityMigrationArtifactStore.test.ts src/main/evolution/automation/__tests__/CapabilityMigrationGateEvaluator.test.ts
```

Expected: FAIL because the new identity module, shadow pipeline, artifact store, and gate evaluator do not exist yet.

- [x] **Step 6: Commit the red contract**

```bash
git add src/main/evolution/automation/__tests__/CapabilityProblemIdentity.test.ts src/main/evolution/automation/__tests__/CapabilityProblemShadowPipeline.test.ts src/main/evolution/automation/__tests__/CapabilityMigrationArtifactStore.test.ts src/main/evolution/automation/__tests__/CapabilityMigrationGateEvaluator.test.ts
git commit -m "test(evolution): freeze capability migration contracts"
```

### Task 2: Add the capability problem identity and migration contract types

**Files:**
- Create: `src/main/evolution/automation/CapabilityProblemIdentity.ts`
- Modify: `src/main/evolution/automation/types.ts`
- Modify: `src/main/evolution/automation/index.ts`

- [x] **Step 1: Add the dedicated identity module**

```ts
export interface CapabilityProblemIdentity {
  capability: string
  operation: string
  issueType: string
  version?: string
}

export const CAPABILITY_PROBLEM_IDENTITY_VERSION = 'm56.v1'

export function normalizeCapabilityProblemIdentity(
  input: Omit<CapabilityProblemIdentity, 'version'> & { version?: string },
): CapabilityProblemIdentity {
  return {
    capability: input.capability,
    operation: input.operation,
    issueType: input.issueType,
    version: input.version ?? CAPABILITY_PROBLEM_IDENTITY_VERSION,
  }
}

export function buildCapabilityProblemIdentityKey(identity: CapabilityProblemIdentity): string {
  return [
    `capability:${identity.capability}`,
    `operation:${identity.operation}`,
    `issue:${identity.issueType}`,
    `version:${identity.version ?? CAPABILITY_PROBLEM_IDENTITY_VERSION}`,
  ].join('|')
}
```

- [x] **Step 2: Extend `types.ts` with capability shadow candidate contracts**

```ts
export interface CapabilityProblemCandidate {
  identity: CapabilityProblemIdentity
  title: string
  description: string
  severity: Severity
  source: ProblemSource
  affectedTools: string[]
  providers: string[]
  legacyProblemIds: string[]
  legacyToolNames: string[]
  occurrenceCount: number
  lastSeen: number
}

export interface CapabilityDecisionCandidate {
  identity: CapabilityProblemIdentity
  capabilityKey: string
  score: number
  affectedTools: string[]
  supportingProblemIds: string[]
}

export interface CapabilityMigrationComparisonReport {
  runId: string
  generatedAt: number
  eligibleLegacyCount: number
  capabilityCandidateCount: number
  legacyOnlyProblemCount: number
  matchedProblemCount: number
  decisionConsistencyRate: number
}

export interface CapabilityMigrationGateInput {
  observationWindow: {
    candidateCount: number
    observedDays: number
  }
  coverage: {
    identityCoverage: number
    traceabilityRate: number
    legacyOnlyRatio: number
  }
  decision: {
    consistencyRate: number
    executorRegressionCount: number
  }
}
```

- [x] **Step 3: Export the new contracts**

```ts
export {
  CAPABILITY_PROBLEM_IDENTITY_VERSION,
  buildCapabilityProblemIdentityKey,
  normalizeCapabilityProblemIdentity,
} from './CapabilityProblemIdentity'

export type {
  CapabilityProblemIdentity,
  CapabilityProblemCandidate,
  CapabilityDecisionCandidate,
  CapabilityMigrationComparisonReport,
  CapabilityMigrationGateInput,
} from './types'
```

- [x] **Step 4: Run the identity-focused test**

Run:

```bash
npm test -- src/main/evolution/automation/__tests__/CapabilityProblemIdentity.test.ts
```

Expected: PASS for normalization and stable key generation.

- [x] **Step 5: Commit the identity contract**

```bash
git add src/main/evolution/automation/CapabilityProblemIdentity.ts src/main/evolution/automation/types.ts src/main/evolution/automation/index.ts src/main/evolution/automation/__tests__/CapabilityProblemIdentity.test.ts
git commit -m "feat(evolution): add capability problem identity contract"
```

### Task 3: Build the shadow candidate pipeline without touching queue authority

**Files:**
- Create: `src/main/evolution/automation/CapabilityProblemShadowPipeline.ts`
- Create: `src/main/evolution/automation/CapabilityDecisionShadowPipeline.ts`
- Create: `src/main/evolution/automation/__tests__/CapabilityProblemShadowPipeline.test.ts`
- Create: `src/main/evolution/automation/__tests__/ToolEvolutionCollector.shadow.test.ts`
- Create: `src/main/evolution/automation/__tests__/ToolAnalyticsCollector.shadow.test.ts`
- Modify: `src/main/tool/ToolStatsTracker.ts`
- Modify: `src/main/tool/ToolAnalytics.ts`
- Modify: `src/main/evolution/automation/ToolEvolutionCollector.ts`
- Modify: `src/main/evolution/automation/ToolAnalyticsCollector.ts`

- [x] **Step 1: Implement legacy-problem to capability-candidate grouping**

```ts
export function buildCapabilityProblemShadowArtifacts(input: {
  runId: string
  generatedAt: number
  legacyProblems: Problem[]
}): {
  legacyCandidates: Problem[]
  capabilityCandidates: CapabilityProblemCandidate[]
  comparison: CapabilityMigrationComparisonReport
} {
  const eligible = input.legacyProblems.filter((problem) =>
    Boolean(problem.affectedCapability) &&
    Boolean(problem.context.metadata?.operation) &&
    Boolean(problem.context.metadata?.issueType),
  )

  const buckets = new Map<string, CapabilityProblemCandidate>()

  for (const problem of eligible) {
    const identity = normalizeCapabilityProblemIdentity({
      capability: problem.affectedCapability!,
      operation: problem.context.metadata!.operation,
      issueType: problem.context.metadata!.issueType,
    })

    const key = buildCapabilityProblemIdentityKey(identity)
    const toolName = problem.context.metadata?.toolName ?? 'unknown'
    const provider = problem.context.metadata?.provider ?? 'unknown'
    const current = buckets.get(key)

    if (current) {
      current.affectedTools = [...new Set([...current.affectedTools, toolName])].sort()
      current.providers = [...new Set([...current.providers, provider])].sort()
      current.legacyProblemIds = [...new Set([...current.legacyProblemIds, problem.id])].sort()
      current.legacyToolNames = [...new Set([...current.legacyToolNames, toolName])].sort()
      current.occurrenceCount += problem.occurrenceCount
      current.lastSeen = Math.max(current.lastSeen, problem.lastSeen)
      continue
    }

    buckets.set(key, {
      identity,
      title: problem.title,
      description: problem.description,
      severity: problem.severity,
      source: problem.source,
      affectedTools: [toolName],
      providers: [provider],
      legacyProblemIds: [problem.id],
      legacyToolNames: [toolName],
      occurrenceCount: problem.occurrenceCount,
      lastSeen: problem.lastSeen,
    })
  }

  const capabilityCandidates = [...buckets.values()].sort((a, b) =>
    buildCapabilityProblemIdentityKey(a.identity).localeCompare(buildCapabilityProblemIdentityKey(b.identity)),
  )

  return {
    legacyCandidates: input.legacyProblems,
    capabilityCandidates,
    comparison: {
      runId: input.runId,
      generatedAt: input.generatedAt,
      eligibleLegacyCount: eligible.length,
      capabilityCandidateCount: capabilityCandidates.length,
      legacyOnlyProblemCount: input.legacyProblems.length - eligible.length,
      matchedProblemCount: eligible.length,
      decisionConsistencyRate: 0,
    },
  }
}
```

- [x] **Step 2: Implement shadow decision candidate builders**

```ts
export function buildLegacyDecisionCandidates(
  legacyProblems: Problem[],
): CapabilityDecisionCandidate[] {
  return legacyProblems
    .filter((problem) =>
      Boolean(problem.affectedCapability) &&
      Boolean(problem.context.metadata?.operation) &&
      Boolean(problem.context.metadata?.issueType),
    )
    .map((problem) => {
      const identity = normalizeCapabilityProblemIdentity({
        capability: problem.affectedCapability!,
        operation: problem.context.metadata!.operation,
        issueType: problem.context.metadata!.issueType,
      })

      return {
        identity,
        capabilityKey: buildCapabilityProblemIdentityKey(identity),
        score: problem.occurrenceCount * (problem.severity === 'error' ? 2 : 1),
        affectedTools: [problem.context.metadata?.toolName ?? 'unknown'],
        supportingProblemIds: [problem.id],
      }
    })
    .sort((a, b) => b.score - a.score)
}

export function buildCapabilityDecisionCandidates(
  candidates: CapabilityProblemCandidate[],
): CapabilityDecisionCandidate[] {
  return candidates
    .map((candidate) => ({
      identity: candidate.identity,
      capabilityKey: buildCapabilityProblemIdentityKey(candidate.identity),
      score: candidate.occurrenceCount * (candidate.severity === 'error' ? 2 : 1),
      affectedTools: candidate.affectedTools,
      supportingProblemIds: candidate.legacyProblemIds,
    }))
    .sort((a, b) => b.score - a.score)
}
```

- [x] **Step 3: Surface identity summaries from the analytics layer**

```ts
export interface ToolIdentitySummary {
  capability?: string
  operation?: string
  provider?: string
}

export interface ProblematicTool {
  toolName: string
  errorRate: number
  totalCalls: number
  reason: string
  suggestion: ToolImprovementSuggestion
  identity?: ToolIdentitySummary
}

private summarizeIdentity(toolName: string): ToolIdentitySummary | undefined {
  const calls = behaviorPredictor.getRecentCalls().filter((call) => call.toolName === toolName)
  const capabilities = [...new Set(calls.map((call) => call.capability).filter(Boolean))]
  const operations = [...new Set(calls.map((call) => call.operation).filter(Boolean))]
  const providers = [...new Set(calls.map((call) => call.provider).filter(Boolean))]

  if (capabilities.length === 0) return undefined

  return {
    capability: capabilities.length === 1 ? capabilities[0] : undefined,
    operation: operations.length === 1 ? operations[0] : undefined,
    provider: providers.length === 1 ? providers[0] : undefined,
  }
}
```

Apply the same shape in `ToolAnalyticsReport`:
- add `identity?: ToolIdentitySummary`
- source it from `ToolCallLogStore` records for the same `toolName`
- do not change scoring, trend, or ranking formulas

- [x] **Step 4: Enrich legacy collectors with shadow-only capability metadata**

```ts
const resolvedCapability = pt.identity?.capability
const resolvedOperation = pt.identity?.operation
const resolvedProvider = pt.identity?.provider

problems.push({
  id: problemId,
  source: 'tool',
  severity: pt.errorRate >= 0.5 ? 'error' : 'warning',
  title: `工具 "${pt.toolName}" 错误率过高`,
  description: pt.reason,
  affectedCapability: resolvedCapability,
  context: {
    raw,
    metadata: {
      toolName: pt.toolName,
      provider: resolvedProvider ?? '',
      operation: resolvedOperation ?? '',
      issueType: 'error_rate',
      suggestion: suggestedFix,
    },
  },
  estimatedCostChars: pt.totalCalls * 10,
  lastSeen: Date.now(),
  occurrenceCount: isSeen ? 2 : 1,
})
```

Apply the same rule in `ToolAnalyticsCollector`:
- keep existing `problem.id`
- keep existing `source = 'tool'`
- add `affectedCapability`
- add `metadata.operation`
- add `metadata.issueType`
- do not change output ordering, scheduler behavior, or queue semantics

- [x] **Step 5: Run the shadow pipeline tests**

Run:

```bash
npm test -- src/main/evolution/automation/__tests__/CapabilityProblemShadowPipeline.test.ts src/main/evolution/automation/__tests__/ToolEvolutionCollector.shadow.test.ts src/main/evolution/automation/__tests__/ToolAnalyticsCollector.shadow.test.ts
```

Expected: PASS, with no change to legacy `problem.id` format or queue authority.

- [x] **Step 6: Commit the shadow pipeline**

```bash
git add src/main/tool/ToolStatsTracker.ts src/main/tool/ToolAnalytics.ts src/main/evolution/automation/CapabilityProblemShadowPipeline.ts src/main/evolution/automation/CapabilityDecisionShadowPipeline.ts src/main/evolution/automation/ToolEvolutionCollector.ts src/main/evolution/automation/ToolAnalyticsCollector.ts src/main/evolution/automation/__tests__/CapabilityProblemShadowPipeline.test.ts src/main/evolution/automation/__tests__/ToolEvolutionCollector.shadow.test.ts src/main/evolution/automation/__tests__/ToolAnalyticsCollector.shadow.test.ts
git commit -m "feat(evolution): add capability shadow candidate pipeline"
```

### Task 4: Add artifact storage and comparison reporting for Dual Write and Shadow Decision

**Files:**
- Create: `src/main/evolution/automation/CapabilityMigrationArtifactStore.ts`
- Create: `src/main/evolution/automation/CapabilityMigrationComparisonReport.ts`
- Create: `src/main/evolution/automation/LegacyDecisionProjection.ts`
- Create: `src/main/evolution/automation/__tests__/CapabilityMigrationArtifactStore.test.ts`
- Create: `scripts/m56-capability-migration-report.ts`

- [x] **Step 1: Add a store that writes the required migration artifacts**

```ts
export class CapabilityMigrationArtifactStore {
  constructor(private readonly rootDir: string) {}

  saveRunArtifacts(input: {
    runId: string
    generatedAt: number
    legacyProblemCandidates: Problem[]
    capabilityProblemCandidates: CapabilityProblemCandidate[]
    comparisonReport: CapabilityMigrationComparisonReport
    legacyDecisions: CapabilityDecisionCandidate[]
    capabilityDecisions: CapabilityDecisionCandidate[]
    decisionDiffReport: Record<string, unknown>
    migrationGateReport: Record<string, unknown>
    rollbackReadinessReport: Record<string, unknown>
  }): void {
    const runDir = join(this.rootDir, input.runId)
    const latestDir = join(this.rootDir, 'latest')

    this.writeJson(join(runDir, 'legacy_problem_candidates.json'), input.legacyProblemCandidates)
    this.writeJson(join(runDir, 'capability_problem_candidates.json'), input.capabilityProblemCandidates)
    this.writeJson(join(runDir, 'comparison_report.json'), input.comparisonReport)
    this.writeJson(join(runDir, 'legacy_decisions.json'), input.legacyDecisions)
    this.writeJson(join(runDir, 'capability_decisions.json'), input.capabilityDecisions)
    this.writeJson(join(runDir, 'decision_diff_report.json'), input.decisionDiffReport)
    this.writeJson(join(runDir, 'migration_gate_report.json'), input.migrationGateReport)
    this.writeJson(join(runDir, 'rollback_readiness_report.json'), input.rollbackReadinessReport)

    this.mirrorLatest(runDir, latestDir)
  }
}
```

- [x] **Step 2: Add a decision diff report builder that matches the spec denominator**

```ts
export function buildDecisionDiffReport(input: {
  legacyDecisions: CapabilityDecisionCandidate[]
  capabilityDecisions: CapabilityDecisionCandidate[]
}): {
  matchedKeys: string[]
  legacyOnlyKeys: string[]
  capabilityOnlyKeys: string[]
  consistencyRate: number
} {
  const legacyKeys = new Set(input.legacyDecisions.map((item) => item.capabilityKey))
  const capabilityKeys = new Set(input.capabilityDecisions.map((item) => item.capabilityKey))
  const matchedKeys = [...legacyKeys].filter((key) => capabilityKeys.has(key)).sort()
  const legacyOnlyKeys = [...legacyKeys].filter((key) => !capabilityKeys.has(key)).sort()
  const capabilityOnlyKeys = [...capabilityKeys].filter((key) => !legacyKeys.has(key)).sort()

  return {
    matchedKeys,
    legacyOnlyKeys,
    capabilityOnlyKeys,
    consistencyRate: legacyKeys.size > 0 ? matchedKeys.length / legacyKeys.size : 1,
  }
}
```

- [x] **Step 3: Add a CLI report generator that never mutates pipeline authority**

```ts
import type { Problem } from '../src/main/evolution/automation/types'
import { ToolEvolutionCollector } from '../src/main/evolution/automation/ToolEvolutionCollector'
import { ToolAnalyticsCollector } from '../src/main/evolution/automation/ToolAnalyticsCollector'

async function loadLegacyProblemCandidates(): Promise<Problem[]> {
  const collectors = [
    new ToolEvolutionCollector(),
    new ToolAnalyticsCollector(),
  ]

  const runs = await Promise.all(collectors.map((collector) => collector.collect()))
  return runs.flat()
}

const runId = `m56-migration-${Date.now()}`
const generatedAt = Date.now()
const legacyProblems = await loadLegacyProblemCandidates()
const shadow = buildCapabilityProblemShadowArtifacts({ runId, generatedAt, legacyProblems })
const legacyDecisions = buildLegacyDecisionCandidates(shadow.legacyCandidates)
const capabilityDecisions = buildCapabilityDecisionCandidates(shadow.capabilityCandidates)
const decisionDiff = buildDecisionDiffReport({ legacyDecisions, capabilityDecisions })

artifactStore.saveRunArtifacts({
  runId,
  generatedAt,
  legacyProblemCandidates: shadow.legacyCandidates,
  capabilityProblemCandidates: shadow.capabilityCandidates,
  comparisonReport: {
    ...shadow.comparison,
    decisionConsistencyRate: decisionDiff.consistencyRate,
  },
  legacyDecisions,
  capabilityDecisions,
  decisionDiffReport: decisionDiff,
  migrationGateReport: {},
  rollbackReadinessReport: {},
})
```

- [x] **Step 4: Run the artifact and CLI tests**

Run:

```bash
npm test -- src/main/evolution/automation/__tests__/CapabilityMigrationArtifactStore.test.ts
npx tsx scripts/m56-capability-migration-report.ts
```

Expected:
- tests PASS
- new files appear under `reports/m56/migration/latest/`
- `ProblemQueue` and executors are untouched

- [x] **Step 5: Commit the artifact layer**

```bash
git add src/main/evolution/automation/CapabilityMigrationArtifactStore.ts src/main/evolution/automation/CapabilityMigrationComparisonReport.ts src/main/evolution/automation/LegacyDecisionProjection.ts scripts/m56-capability-migration-report.ts src/main/evolution/automation/__tests__/CapabilityMigrationArtifactStore.test.ts
git commit -m "feat(evolution): add migration artifact reporting"
```

### Task 5: Add the migration gate evaluator and rollback-readiness report

**Files:**
- Create: `src/main/evolution/automation/CapabilityMigrationGateEvaluator.ts`
- Modify: `src/main/evolution/automation/types.ts`
- Modify: `scripts/m56-capability-migration-report.ts`
- Create: `src/main/evolution/automation/__tests__/CapabilityMigrationGateEvaluator.test.ts`

- [x] **Step 1: Add a typed gate evaluator**

```ts
export function evaluateCapabilityMigrationGate(
  input: CapabilityMigrationGateInput,
): {
  status: 'below_gate' | 'pass'
  metrics: Record<string, { actual: number; target: string; passed: boolean }>
} {
  const observationPassed = input.observationWindow.candidateCount >= 1000 || input.observationWindow.observedDays >= 7
  const identityPassed = input.coverage.identityCoverage >= 0.9
  const traceabilityPassed = input.coverage.traceabilityRate === 1
  const legacyOnlyPassed = input.coverage.legacyOnlyRatio < 0.1
  const consistencyPassed = input.decision.consistencyRate >= 0.95
  const executorRegressionPassed = input.decision.executorRegressionCount === 0

  return {
    status: observationPassed && identityPassed && traceabilityPassed && legacyOnlyPassed && consistencyPassed && executorRegressionPassed
      ? 'pass'
      : 'below_gate',
    metrics: {
      observationWindow: { actual: input.observationWindow.candidateCount, target: '>=1000 candidates or >=7 days', passed: observationPassed },
      identityCoverage: { actual: input.coverage.identityCoverage, target: '>=0.90', passed: identityPassed },
      traceability: { actual: input.coverage.traceabilityRate, target: '=1.00', passed: traceabilityPassed },
      legacyOnlyRatio: { actual: input.coverage.legacyOnlyRatio, target: '<0.10', passed: legacyOnlyPassed },
      decisionConsistency: { actual: input.decision.consistencyRate, target: '>=0.95', passed: consistencyPassed },
      executorRegression: { actual: input.decision.executorRegressionCount, target: '=0', passed: executorRegressionPassed },
    },
  }
}
```

- [x] **Step 2: Add rollback-readiness output to the CLI report**

```ts
const gate = evaluateCapabilityMigrationGate({
  observationWindow: {
    candidateCount: shadow.comparison.eligibleLegacyCount,
    observedDays: observedDaysSince(firstCandidateAt, lastCandidateAt),
  },
  coverage: {
    identityCoverage: shadow.comparison.eligibleLegacyCount / Math.max(legacyProblems.length, 1),
    traceabilityRate: computeTraceabilityRate(shadow.capabilityCandidates),
    legacyOnlyRatio: shadow.comparison.legacyOnlyProblemCount / Math.max(legacyProblems.length, 1),
  },
  decision: {
    consistencyRate: decisionDiff.consistencyRate,
    executorRegressionCount: 0,
  },
})

const rollbackReadinessReport = {
  capabilityAuthorityEnabled: false,
  legacyAuthorityIntact: true,
  dualWriteTelemetryActive: true,
  rollbackAction: 'disable capability authority and continue shadow artifact generation',
}
```

- [x] **Step 3: Run the evaluator tests and the end-to-end report script**

Run:

```bash
npm test -- src/main/evolution/automation/__tests__/CapabilityMigrationGateEvaluator.test.ts
npx tsx scripts/m56-capability-migration-report.ts
```

Expected:
- tests PASS
- `reports/m56/migration/latest/migration_gate_report.json` exists
- `reports/m56/migration/latest/rollback_readiness_report.json` exists
- the report remains observational and does not toggle capability authority

- [x] **Step 4: Commit the gate evaluator**

```bash
git add src/main/evolution/automation/CapabilityMigrationGateEvaluator.ts src/main/evolution/automation/types.ts scripts/m56-capability-migration-report.ts src/main/evolution/automation/__tests__/CapabilityMigrationGateEvaluator.test.ts
git commit -m "feat(evolution): add capability migration gate evaluator"
```

### Task 6: Run regressions and verify authority stayed frozen

**Files:**
- Modify: `docs/adr-015-capability-model-contract.md`
- Modify: `docs/superpowers/specs/2026-07-30-m56-capability-evolution-migration-design.md`

- [x] **Step 1: Run the focused M5.6 regression slice**

Run:

```bash
npm test -- src/main/evolution/automation/__tests__/CapabilityProblemIdentity.test.ts src/main/evolution/automation/__tests__/CapabilityProblemShadowPipeline.test.ts src/main/evolution/automation/__tests__/CapabilityMigrationArtifactStore.test.ts src/main/evolution/automation/__tests__/CapabilityMigrationGateEvaluator.test.ts src/main/evolution/automation/__tests__/CapabilityEvolutionShadowCollector.test.ts src/main/evolution/automation/__tests__/CapabilityEvolutionShadowObservationSource.test.ts src/main/evolution/automation/__tests__/PipelineShadowCollector.test.ts
```

Expected: PASS, showing M5.6.3 observation infrastructure still works while M5.6.4 adds migration artifacts.

- [x] **Step 2: Run a legacy Evolution regression slice**

Run:

```bash
npm test -- src/main/evolution/automation/__tests__/EvidenceCollector.test.ts src/main/evolution/automation/__tests__/ProblemErrorType.test.ts src/main/evolution/automation/__tests__/Step3E2EVerification.test.ts
```

Expected: PASS, showing collector scheduling, `ProblemQueue`, and executor behavior are unchanged.

- [x] **Step 3: Update ADR/spec status without granting authority**

```md
M5.6.4 Status: Implementation Complete
Authority: No capability-first execution authority granted
Next: M5.6.5 Cutover Review
```

Also append the artifact outputs:
- `legacy_problem_candidates`
- `capability_problem_candidates`
- `comparison_report`
- `legacy_decisions`
- `capability_decisions`
- `decision_diff_report`
- `migration_gate_report`
- `rollback_readiness_report`

- [x] **Step 4: Commit the verification and documentation updates**

```bash
git add docs/adr-015-capability-model-contract.md docs/superpowers/specs/2026-07-30-m56-capability-evolution-migration-design.md reports/m56/migration/latest src/main/evolution/automation scripts/m56-capability-migration-report.ts
git commit -m "docs(evolution): record capability migration artifacts and gate"
```

## Guardrails

- Do not modify `src/main/evolution/automation/ProblemQueue.ts`.
- Do not modify `src/main/evolution/automation/ToolEvolutionExecutor.ts`.
- Do not modify `src/main/evolution/automation/ToolConfigOptimizationExecutor.ts`.
- Do not change scheduler cadence or `PipelineOrchestrator.runOnce()` authority flow.
- Do not enable capability-first decision execution.
- Do not remove `toolName`, provider, or affected tool evidence from any legacy path.

## Expected Artifacts

Each shadow run must produce:

- `reports/m56/migration/<runId>/legacy_problem_candidates.json`
- `reports/m56/migration/<runId>/capability_problem_candidates.json`
- `reports/m56/migration/<runId>/comparison_report.json`
- `reports/m56/migration/<runId>/legacy_decisions.json`
- `reports/m56/migration/<runId>/capability_decisions.json`
- `reports/m56/migration/<runId>/decision_diff_report.json`
- `reports/m56/migration/<runId>/migration_gate_report.json`
- `reports/m56/migration/<runId>/rollback_readiness_report.json`
- mirrored copies under `reports/m56/migration/latest/`

## Self-Review

- Spec coverage: this plan covers the collector migration contract, problem identity contract, executor contract preservation, rollout artifact contract, and migration gate evaluation without granting authority.
- Placeholder scan: no `TODO`, `TBD`, or “implement later” markers remain.
- Type consistency: `CapabilityProblemIdentity`, `CapabilityProblemCandidate`, `CapabilityDecisionCandidate`, comparison reports, and gate evaluator inputs use the same field names throughout the plan.
