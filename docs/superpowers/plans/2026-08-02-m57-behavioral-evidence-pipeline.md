# M5.7 Behavioral Evidence Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a durable behavioral evidence pipeline that emits closed chat-trace facts into `evaluation_events`, derives behavioral evidence offline, and materializes a replayable `pipeline_data/behavioral-observation.json` artifact.

**Current Status (updated 2026-08-03):**

```text
Plan: Ready
Environment: Validated
Implementation: Validated
Behavioral Samples: Gate reached
Latest Snapshot: Materialized from isolated live ledger `.worktrees\m57-observation-runner` (`sampleCount = 103`, `rejectedSampleCount = 201`, `incompleteEvidenceCount = 201`)
Latest Valid Traces: 103 closed chat traces, including the live sampling acceleration completed on 2026-08-03
Current Fingerprints: `response: 93`; `tool:file_management>response: 3`; `tool:system_execution>response: 2`; `tool:file_management>tool:file_management>tool:system_execution>response: 1`; `tool:system_execution>tool:file_management>response: 1`; `tool:system_execution>tool:system_execution>response: 3`
Root Cause Update: Historical traces still lack chat-boundary facts, but the restarted isolated runtime now emits `user.message`, `task.started(kind='chat')`, `agent.response`, and `task.completed(kind='chat')`
Analyzer Correction: Same-trace runtime-session `model.*` and `tool.*` primitive facts are allowed inside a closed chat window; foreign-session behavioral sequence facts still invalidate the sample
CLI Default Source: Fixed to resolve the real user-data workspace when `USER_DATA_DIR` is unset
Live Runtime State: AppData restoration was not performed; live sampling used the safer isolated `USER_DATA_DIR=D:\work\code\akemi-mio\.worktrees\m57-observation-runner`
Native Dependency Note: `better-sqlite3` is currently rebuilt for Node ABI after offline materialization; rebuild to Electron ABI again before the next live-sampling run

Next:
Evidence Review complete: continue freeze. Do not open M5.7 v2, trigger policy analysis, or advance M5.8 unless future natural traffic produces new sequence, divergence, or decision-impact evidence
```

**Evidence Review Summary (2026-08-03):**

```text
Decision: Continue Freeze
Gate: Passed (`sampleCount = 103 >= 100`)
Unique fingerprints: 6
Response-only concentration: 93 / 103 = 90.29%
Divergence detected: 0
Decision impact derived: 0
Known caveat: accelerated sampling is response-heavy
```

The gate is closed for M5.7 v1 because the restored pipeline produced sufficient real closed chat traces and no divergence or decision-impact signal appeared. The response-heavy distribution should be monitored through future natural traffic, but it is not by itself evidence for M5.7 v2.

**Architecture:** Keep runtime narrow. `ChatExecutor` writes only chat-boundary facts into `evaluation_events`; no sequence, fingerprint, or divergence semantics are emitted at runtime. A deterministic offline analyzer groups events by `traceId`, validates sample sufficiency, derives sequence and fingerprint summaries, and writes a traceable review artifact.

**Tech Stack:** TypeScript, Vitest, existing `EvaluationEmitter` / `EvaluationStore`, `sql.js`-backed repository tests, filesystem JSON artifact writing under `pipeline_data`

---

## File Map

- Modify: `src/main/agent/ChatExecutor.ts`
  - emit `user.message`, `agent.response`, `task.started(kind='chat')`, and `task.completed(kind='chat')` into `evaluation_events`
  - keep trace/session linkage aligned with existing `requestId` and resolved `sessionId`
- Create: `src/main/agent/__tests__/ChatExecutor.behavioral-evidence.test.ts`
  - prove chat success and failure paths emit closed task facts
- Create: `src/main/core/evaluation/BehavioralEvidenceAnalyzer.ts`
  - deterministic closed-trace analyzer
  - classify `valid`, `incomplete_sample`, and downstream insufficiency states
- Create: `src/main/core/evaluation/BehavioralObservationWriter.ts`
  - materialize analyzer output to `pipeline_data/behavioral-observation.json`
- Create: `src/main/core/evaluation/__tests__/BehavioralEvidenceAnalyzer.test.ts`
  - closed-trace derivation, incomplete-trace rejection, decision-impact insufficiency
- Create: `src/main/core/evaluation/__tests__/BehavioralObservationWriter.test.ts`
  - artifact shape, traceRefs, and replayability metadata
- Create: `scripts/m57-behavioral-observation.ts`
  - CLI entry that reads `evaluation_events`, runs the analyzer, writes the artifact

### Task 1: Emit Closed Chat-Trace Facts

Status: Validated

**Files:**
- Modify: `src/main/agent/ChatExecutor.ts`
- Test: `src/main/agent/__tests__/ChatExecutor.behavioral-evidence.test.ts`

- [ ] **Step 1: Write the failing chat-boundary tests**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentService } from '../AgentService'
import { LlmService } from '../../llm/LlmService'
import { AsrService } from '../../asr/AsrService'
import { TtsService } from '../../tts/TtsService'

describe('AgentService -> ChatExecutor behavioral evidence boundary', () => {
  let agent: AgentService
  let llmService: LlmService
  let emit: ReturnType<typeof vi.fn>

  beforeEach(() => {
    llmService = new LlmService()
    const asrService = new AsrService({} as any, {} as any)
    const ttsService = new TtsService(() => {})
    agent = new AgentService(llmService, asrService, ttsService)
    emit = vi.fn()
    agent.setEvaluationEmitter({ emit } as any)
  })

  it('emits user.message, task.started, agent.response, and task.completed for a successful chat trace', async () => {
    vi.spyOn(llmService, 'chatWithTools').mockResolvedValue({ reply: 'done' })

    const result = await agent.processTextInput('ping', 'trace_success', 'electron', undefined, 'session_a', true)

    expect(result.reply).toBe('done')
    expect(emit).toHaveBeenCalledWith(
      'user.message',
      expect.objectContaining({ type: 'user.message', length: 4, contentType: 'text' }),
      expect.objectContaining({ traceId: 'trace_success', sessionId: 'session_a' }),
    )

    expect(emit).toHaveBeenNthCalledWith(
      'task.started',
      expect.objectContaining({ type: 'task.started', kind: 'chat', inputLength: 4 }),
      expect.objectContaining({ traceId: 'trace_success', sessionId: 'session_a' }),
    )

    expect(emit).toHaveBeenCalledWith(
      'agent.response',
      expect.objectContaining({ type: 'agent.response', length: 4 }),
      expect.objectContaining({ traceId: 'trace_success', sessionId: 'session_a' }),
    )

    expect(emit).toHaveBeenCalledWith(
      'task.completed',
      expect.objectContaining({ type: 'task.completed', kind: 'chat', outcome: 'completed' }),
      expect.objectContaining({ traceId: 'trace_success', sessionId: 'session_a' }),
    )
  })

  it('emits failed task.completed when chat execution ends with INTERNAL', async () => {
    vi.spyOn(llmService, 'chatWithTools').mockRejectedValue(new Error('boom'))

    const result = await agent.processTextInput('ping', 'trace_failed', 'electron', undefined, 'session_b', true)

    expect(result.error).toBe('INTERNAL')
    expect(emit).toHaveBeenCalledWith(
      'task.completed',
      expect.objectContaining({ type: 'task.completed', kind: 'chat', outcome: 'failed', error: 'boom' }),
      expect.objectContaining({ traceId: 'trace_failed', sessionId: 'session_b' }),
    )
  })

  it('emits abandoned task.completed when chat returns NO_REPLY', async () => {
    vi.spyOn(llmService, 'chatWithTools').mockResolvedValue({ reply: '' })

    const result = await agent.processTextInput('ping', 'trace_abandoned', 'electron', undefined, 'session_c', true)

    expect(result.error).toBe('NO_REPLY')
    expect(emit).toHaveBeenCalledWith(
      'task.completed',
      expect.objectContaining({ type: 'task.completed', kind: 'chat', outcome: 'abandoned', error: 'NO_REPLY' }),
      expect.objectContaining({ traceId: 'trace_abandoned', sessionId: 'session_c' }),
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/agent/__tests__/ChatExecutor.behavioral-evidence.test.ts`

Expected: FAIL because the chat path does not yet persist the behavioral boundary facts into `evaluation_events`.

- [ ] **Step 3: Add the minimal runtime fact emission**

```ts
private emitUserMessage(traceId: string, sessionId: string, text: string): void {
  if (!this.evaluationEmitter) return
  this.evaluationEmitter.emit(
    'user.message',
    { type: 'user.message', length: text.length, contentType: 'text' },
    { traceId, sessionId },
  )
}

private emitChatTaskStarted(traceId: string, sessionId: string, text: string): void {
  if (!this.evaluationEmitter) return
  this.evaluationEmitter.emit(
    'task.started',
    { type: 'task.started', kind: 'chat', description: 'chat', inputLength: text.length },
    { traceId, sessionId },
  )
}

private emitAgentResponse(traceId: string, sessionId: string, reply: string, durationMs: number): void {
  if (!this.evaluationEmitter) return
  this.evaluationEmitter.emit(
    'agent.response',
    { type: 'agent.response', length: reply.length, durationMs },
    { traceId, sessionId },
  )
}

private emitChatTaskCompleted(
  traceId: string,
  sessionId: string,
  outcome: 'completed' | 'failed' | 'abandoned',
  durationMs: number,
  error?: string,
): void {
  if (!this.evaluationEmitter) return
  this.evaluationEmitter.emit(
    'task.completed',
    { type: 'task.completed', kind: 'chat', outcome, durationMs, error },
    { traceId, sessionId },
  )
}
```

Implementation notes:

- call `emitUserMessage()` immediately after `effectiveSessionId` is resolved
- call `emitChatTaskStarted()` immediately after `effectiveSessionId` is resolved
- call `emitAgentResponse()` right before the successful `{ reply }` return
- call `emitChatTaskCompleted(..., 'completed', ...)` just before the successful return
- call `emitChatTaskCompleted(..., 'failed', ..., String(err))` in the `catch`
- call `emitChatTaskCompleted(..., 'abandoned', ..., 'NO_REPLY')` on the `NO_REPLY` return path
- do not add sequence or fingerprint fields here

- [ ] **Step 4: Run the chat-boundary tests again**

Run: `npx vitest run src/main/agent/__tests__/ChatExecutor.behavioral-evidence.test.ts`

Expected: PASS with both success and failure traces producing closed task facts.

- [ ] **Step 5: Commit the runtime boundary work**

```bash
git add src/main/agent/ChatExecutor.ts src/main/agent/__tests__/ChatExecutor.behavioral-evidence.test.ts
git commit -m "feat: emit chat task boundary evaluation events"
```

### Task 2: Build the Deterministic Behavioral Analyzer

Status: Validated

**Files:**
- Create: `src/main/core/evaluation/BehavioralEvidenceAnalyzer.ts`
- Test: `src/main/core/evaluation/__tests__/BehavioralEvidenceAnalyzer.test.ts`

- [ ] **Step 1: Write the failing analyzer tests**

```ts
import { describe, it, expect } from 'vitest'
import { BehavioralEvidenceAnalyzer } from '../BehavioralEvidenceAnalyzer'

describe('BehavioralEvidenceAnalyzer', () => {
  function makeEvent(type: EvaluationEvent['type'], payload: EvaluationEvent['payload']): EvaluationEvent {
    return {
      id: `${type}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      traceId: 'trace_fixture',
      sessionId: 'session_fixture',
      source: 'test',
      type,
      payload,
    }
  }

  it('counts a closed chat trace as one valid behavioral sample', () => {
    const result = BehavioralEvidenceAnalyzer.compute('trace_ok', [
      makeEvent('task.started', { type: 'task.started', kind: 'chat', inputLength: 4 }),
      makeEvent('tool.invoked', { type: 'tool.invoked', toolName: 'read_file' }),
      makeEvent('tool.completed', { type: 'tool.completed', toolName: 'read_file', durationMs: 10 }),
      makeEvent('agent.response', { type: 'agent.response', length: 20, durationMs: 30 }),
      makeEvent('task.completed', { type: 'task.completed', kind: 'chat', outcome: 'completed', durationMs: 40 }),
    ])

    expect(result.sampleStatus).toBe('valid')
    expect(result.observationEligible).toBe(true)
    expect(result.sequence).toEqual(['tool:read_file', 'response'])
    expect(result.fingerprint).toBe('tool:read_file>response')
  })

  it('marks traces missing task.completed as incomplete_sample', () => {
    const result = BehavioralEvidenceAnalyzer.compute('trace_incomplete', [
      makeEvent('task.started', { type: 'task.started', kind: 'chat', inputLength: 4 }),
      makeEvent('tool.invoked', { type: 'tool.invoked', toolName: 'read_file' }),
    ])

    expect(result.sampleStatus).toBe('incomplete_sample')
    expect(result.observationEligible).toBe(false)
  })

  it('keeps decision impact separate and reports insufficiency when no decision linkage exists', () => {
    const result = BehavioralEvidenceAnalyzer.compute('trace_no_decision', [
      makeEvent('task.started', { type: 'task.started', kind: 'chat', inputLength: 4 }),
      makeEvent('tool.completed', { type: 'tool.completed', toolName: 'read_file', durationMs: 10 }),
      makeEvent('agent.response', { type: 'agent.response', length: 20, durationMs: 30 }),
      makeEvent('task.completed', { type: 'task.completed', kind: 'chat', outcome: 'completed', durationMs: 40 }),
    ])

    expect(result.decisionImpactStatus).toBe('insufficient_for_decision_impact')
    expect(result.decisionIds).toEqual([])
  })

  it('ignores capability events that do not carry the current traceId instead of fabricating completeness', () => {
    const foreignCapability = {
      ...makeEvent('capability.completed', {
        type: 'capability.completed',
        capability: 'file.management',
        provider: '@builtin/core',
        tool: 'write_file',
        success: true,
        durationMs: 10,
      }),
      traceId: '',
    }

    const result = BehavioralEvidenceAnalyzer.compute('trace_cap_gap', [
      makeEvent('task.started', { type: 'task.started', kind: 'chat', inputLength: 4 }),
      foreignCapability,
      makeEvent('tool.completed', { type: 'tool.completed', toolName: 'write_file', durationMs: 10 }),
      makeEvent('task.completed', { type: 'task.completed', kind: 'chat', outcome: 'completed', durationMs: 40 }),
    ])

    expect(result.sequence).toEqual(['tool:write_file'])
    expect(result.sampleStatus).toBe('valid')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/core/evaluation/__tests__/BehavioralEvidenceAnalyzer.test.ts`

Expected: FAIL because `BehavioralEvidenceAnalyzer` does not exist yet.

- [ ] **Step 3: Implement the deterministic analyzer**

```ts
export interface BehavioralTraceAnalysis {
  traceId: string
  sessionId: string
  sampleStatus: 'valid' | 'incomplete_sample'
  observationEligible: boolean
  sequenceStatus: 'derived' | 'insufficient_for_fingerprint'
  decisionImpactStatus: 'derived' | 'insufficient_for_decision_impact'
  sequence: string[]
  fingerprint: string | null
  decisionIds: string[]
}

export class BehavioralEvidenceAnalyzer {
  static compute(traceId: string, events: EvaluationEvent[]): BehavioralTraceAnalysis {
    const ordered = [...events].sort((a, b) => a.timestamp - b.timestamp)
    const started = ordered.find((event) => event.type === 'task.started' && event.payload.kind === 'chat')
    const completed = ordered.find((event) => event.type === 'task.completed' && event.payload.kind === 'chat')
    if (!started || !completed) {
      return {
        traceId,
        sessionId: ordered[0]?.sessionId ?? '',
        sampleStatus: 'incomplete_sample',
        observationEligible: false,
        sequenceStatus: 'insufficient_for_fingerprint',
        decisionImpactStatus: 'insufficient_for_decision_impact',
        sequence: [],
        fingerprint: null,
        decisionIds: [],
      }
    }

    const sequence = ordered.flatMap((event) => {
      if (event.type === 'tool.completed') return [`tool:${event.payload.toolName}`]
      if (event.type === 'capability.completed') return [`capability:${event.payload.capability}`]
      if (event.type === 'agent.response') return ['response']
      return []
    })

    return {
      traceId,
      sessionId: ordered[0]?.sessionId ?? '',
      sampleStatus: 'valid',
      observationEligible: sequence.length > 0,
      sequenceStatus: sequence.length > 0 ? 'derived' : 'insufficient_for_fingerprint',
      decisionImpactStatus: ordered.some((event) => event.type === 'evolution.policy.decision') ? 'derived' : 'insufficient_for_decision_impact',
      sequence,
      fingerprint: sequence.length > 0 ? sequence.join('>') : null,
      decisionIds: ordered
        .filter((event) => event.type === 'guardrail.action_delivered' || event.type === 'guardrail.action_delivery_failed')
        .map((event) => event.payload.decisionId),
    }
  }
}
```

Implementation notes:

- sort by `timestamp` inside the analyzer so replay is stable
- treat missing chat boundary events as `incomplete_sample`
- keep `decisionImpactStatus` separate from sample validity
- ignore `capability.*` events whose `traceId` does not match the analyzed trace and let the artifact surface insufficiency rather than inventing capability completeness
- detect divergence later from grouped fingerprints; do not interpret it here

- [ ] **Step 4: Run analyzer tests and replay safety checks**

Run: `npx vitest run src/main/core/evaluation/__tests__/BehavioralEvidenceAnalyzer.test.ts src/main/core/evaluation/__tests__/i-1-replay-consistency-verification.test.ts`

Expected: PASS with the new analyzer tests green and existing replay invariants unchanged.

- [ ] **Step 5: Commit the analyzer**

```bash
git add src/main/core/evaluation/BehavioralEvidenceAnalyzer.ts src/main/core/evaluation/__tests__/BehavioralEvidenceAnalyzer.test.ts
git commit -m "feat: add behavioral evidence analyzer"
```

### Task 3: Materialize the Behavioral Observation Artifact

Status: Validated

**Files:**
- Create: `src/main/core/evaluation/BehavioralObservationWriter.ts`
- Create: `src/main/core/evaluation/__tests__/BehavioralObservationWriter.test.ts`
- Create: `scripts/m57-behavioral-observation.ts`

- [ ] **Step 1: Write the failing artifact-writer tests**

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { BehavioralObservationWriter } from '../BehavioralObservationWriter'

describe('BehavioralObservationWriter', () => {
  it('writes pipeline_data/behavioral-observation.json with traceable aggregates', async () => {
    const persistDir = mkdtempSync(join(tmpdir(), 'm57-behavioral-'))
    const writer = new BehavioralObservationWriter(persistDir)

    await writer.write({
      sampleCount: 1,
      rejectedSampleCount: 1,
      incompleteEvidenceCount: 1,
      sequenceFamilies: { 'tool:read_file>response': 1 },
      fingerprintDistribution: { 'tool:read_file>response': 1 },
      divergenceSummary: { detectedCount: 0, traceIds: [] },
      decisionImpactSummary: { derivedCount: 0, insufficientCount: 1, traceIds: [] },
      traceRefs: ['trace_ok'],
    })

    const filePath = join(persistDir, 'behavioral-observation.json')
    const saved = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(saved.sampleCount).toBe(1)
    expect(saved.traceRefs).toEqual(['trace_ok'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/core/evaluation/__tests__/BehavioralObservationWriter.test.ts`

Expected: FAIL because the writer and artifact output do not exist yet.

- [ ] **Step 3: Implement the writer and CLI materialization path**

```ts
export class BehavioralObservationWriter {
  constructor(private readonly persistDir: string) {}

  async write(snapshot: BehavioralObservationSnapshot): Promise<string> {
    if (!existsSync(this.persistDir)) mkdirSync(this.persistDir, { recursive: true })
    const outputPath = join(this.persistDir, 'behavioral-observation.json')
    writeFileSync(outputPath, JSON.stringify(snapshot, null, 2), 'utf-8')
    return outputPath
  }
}
```

```ts
async function main() {
  const store = new EvaluationStore()
  await store.init()
  const events = await store.query({ since: 0 }, { limit: QUERY_NO_LIMIT })
  const snapshot = buildBehavioralObservationSnapshot(events)
  const writer = new BehavioralObservationWriter(resolvePersistDir(process.argv.slice(2)))
  const outputPath = await writer.write(snapshot)
  console.log(outputPath)
}
```

Implementation notes:

- default `persistDir` should follow the existing `pipeline_data` convention used by `scripts/m56-shadow-observe.ts`
- artifact fields must include `sampleCount`, `rejectedSampleCount`, `incompleteEvidenceCount`, `sequenceFamilies`, `fingerprintDistribution`, `divergenceSummary`, `decisionImpactSummary`, and `traceRefs`
- `traceRefs` must be populated from analyzer output, not reconstructed after serialization

- [ ] **Step 4: Run artifact tests and the CLI once**

Run: `npx vitest run src/main/core/evaluation/__tests__/BehavioralObservationWriter.test.ts src/main/core/evaluation/__tests__/BehavioralEvidenceAnalyzer.test.ts`

Expected: PASS with the writer test green and analyzer coverage intact.

Run: `npx tsx scripts/m57-behavioral-observation.ts --persistDir=./pipeline_data`

Expected: prints `pipeline_data/behavioral-observation.json` and writes a JSON artifact containing `traceRefs`.

- [ ] **Step 5: Commit the artifact materialization**

```bash
git add src/main/core/evaluation/BehavioralObservationWriter.ts src/main/core/evaluation/__tests__/BehavioralObservationWriter.test.ts scripts/m57-behavioral-observation.ts
git commit -m "feat: materialize behavioral observation artifact"
```

## Self-Review

### Spec Coverage

- evidence source contract -> Task 1 runtime facts + Task 3 artifact writer
- behavioral sample contract -> Task 1 closed chat boundaries + Task 2 sample classification
- event sufficiency contract -> Task 2 incomplete and insufficiency states
- derived artifact contract -> Task 3 JSON shape and `traceRefs`
- gate relationship -> Task 2 `observationEligible` logic + Task 3 aggregated `sampleCount`

### Placeholder Scan

- no `TODO`, `TBD`, or “implement later” text remains
- every code-changing step includes concrete file paths and code
- every verification step includes an exact command and expected outcome

### Type Consistency

- `task.started` / `task.completed` stay on existing `EvaluationEvent` types
- analyzer output uses `sampleStatus`, `observationEligible`, `sequenceStatus`, and `decisionImpactStatus` consistently across tests and implementation
- writer consumes `BehavioralObservationSnapshot` and persists `traceRefs` unchanged
