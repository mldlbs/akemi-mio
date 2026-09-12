import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { BehavioralEvidenceAnalyzer, type BehavioralTraceAnalysis } from '@akemi-mio/core/core/evaluation/BehavioralEvidenceAnalyzer'
import {
  BehavioralObservationWriter,
  buildBehavioralObservationSnapshot,
  type BehavioralObservationSnapshot,
} from '@akemi-mio/core/core/evaluation/BehavioralObservationWriter'
import type { EvaluationEvent, EventType } from '@akemi-mio/core/core/evaluation/types'

function makeEvent(
  id: string,
  timestamp: number,
  type: EventType,
  payload: EvaluationEvent['payload'],
  traceId: string,
  sessionId: string,
  seq?: number,
): EvaluationEvent {
  return {
    id,
    timestamp,
    traceId,
    sessionId,
    source: 'behavioral-observation-writer-test',
    type,
    payload,
    ...(seq === undefined ? {} : { seq }),
  }
}

describe('BehavioralObservationWriter', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates behavioral-observation.json and round-trips a supplied snapshot', async () => {
    const persistDir = mkdtempSync(join(tmpdir(), 'behavioral-observation-writer-'))
    const snapshot: BehavioralObservationSnapshot = {
      sampleCount: 2,
      rejectedSampleCount: 1,
      incompleteEvidenceCount: 1,
      sequenceFamilies: {
        'tool:search>response': 2,
      },
      fingerprintDistribution: {
        'tool:search>response': 2,
      },
      divergenceSummary: {
        detectedCount: 0,
        insufficientCount: 3,
        traceIds: [],
      },
      decisionImpactSummary: {
        derivedCount: 0,
        insufficientCount: 3,
        traceIds: [],
      },
      traceRefs: ['trace-a', 'trace-b', 'trace-c'],
    }

    try {
      const writer = new BehavioralObservationWriter(persistDir)
      const writtenPath = await writer.write(snapshot)

      expect(writtenPath).toBe(join(persistDir, 'behavioral-observation.json'))
      expect(existsSync(writtenPath)).toBe(true)
      expect(JSON.parse(readFileSync(writtenPath, 'utf-8'))).toEqual(snapshot)
    } finally {
      rmSync(persistDir, { recursive: true, force: true })
    }
  })

  it('groups a valid trace and incomplete trace correctly with sorted trace refs', () => {
    const events: EvaluationEvent[] = [
      makeEvent(
        'trace-z-start',
        1000,
        'task.started',
        {
          type: 'task.started',
          kind: 'chat',
        },
        'trace-z',
        'session-z',
      ),
      makeEvent(
        'trace-z-tool',
        1010,
        'tool.completed',
        {
          type: 'tool.completed',
          toolName: 'search',
          durationMs: 12,
        },
        'trace-z',
        'session-z',
      ),
      makeEvent(
        'trace-z-response',
        1020,
        'agent.response',
        {
          type: 'agent.response',
          length: 48,
          durationMs: 18,
        },
        'trace-z',
        'session-z',
      ),
      makeEvent(
        'trace-z-complete',
        1030,
        'task.completed',
        {
          type: 'task.completed',
          kind: 'chat',
          outcome: 'completed',
          durationMs: 40,
        },
        'trace-z',
        'session-z',
      ),
      makeEvent(
        'trace-a-start',
        2000,
        'task.started',
        {
          type: 'task.started',
          kind: 'chat',
        },
        'trace-a',
        'session-a',
      ),
      makeEvent(
        'trace-a-tool',
        2010,
        'tool.completed',
        {
          type: 'tool.completed',
          toolName: 'read_file',
          durationMs: 9,
        },
        'trace-a',
        'session-a',
      ),
    ]

    expect(buildBehavioralObservationSnapshot(events)).toEqual({
      sampleCount: 1,
      rejectedSampleCount: 1,
      incompleteEvidenceCount: 1,
      sequenceFamilies: {
        'tool:search>response': 1,
      },
      fingerprintDistribution: {
        'tool:search>response': 1,
      },
      divergenceSummary: {
        detectedCount: 0,
        insufficientCount: 2,
        traceIds: [],
      },
      decisionImpactSummary: {
        derivedCount: 0,
        insufficientCount: 2,
        traceIds: [],
      },
      traceRefs: ['trace-a', 'trace-z'],
    })
  })

  it('derives trace refs from analyzer provenance and retains rejected analyses', () => {
    const analysesByInputTraceId: Record<string, BehavioralTraceAnalysis> = {
      'raw-trace-a': {
        traceId: 'derived-trace-z',
        sessionId: 'session-a',
        sampleStatus: 'incomplete_sample',
        observationEligible: false,
        sequenceStatus: 'insufficient_for_fingerprint',
        decisionImpactStatus: 'insufficient_for_decision_impact',
        divergenceStatus: 'insufficient_for_divergence',
        sequence: [],
        sequenceEventIds: [],
        fingerprint: null,
        decisionIds: [],
      },
      'raw-trace-z': {
        traceId: 'derived-trace-a',
        sessionId: 'session-z',
        sampleStatus: 'valid',
        observationEligible: true,
        sequenceStatus: 'derived',
        decisionImpactStatus: 'insufficient_for_decision_impact',
        divergenceStatus: 'insufficient_for_divergence',
        sequence: ['tool:search'],
        sequenceEventIds: ['raw-trace-z-tool'],
        fingerprint: 'tool:search',
        decisionIds: [],
      },
    }
    vi.spyOn(BehavioralEvidenceAnalyzer, 'compute').mockImplementation((traceId) => analysesByInputTraceId[traceId])

    const events: EvaluationEvent[] = [
      makeEvent(
        'raw-trace-z-tool',
        1000,
        'tool.completed',
        {
          type: 'tool.completed',
          toolName: 'search',
          durationMs: 10,
        },
        'raw-trace-z',
        'session-z',
      ),
      makeEvent(
        'raw-trace-a-tool',
        1010,
        'tool.completed',
        {
          type: 'tool.completed',
          toolName: 'read_file',
          durationMs: 11,
        },
        'raw-trace-a',
        'session-a',
      ),
    ]

    const snapshot = buildBehavioralObservationSnapshot(events)

    expect(snapshot.traceRefs).toEqual(['derived-trace-a', 'derived-trace-z'])
    expect(snapshot.sampleCount).toBe(1)
    expect(snapshot.rejectedSampleCount).toBe(1)
  })

  it('only includes eligible traces in sequence families and fingerprint distribution', () => {
    const events: EvaluationEvent[] = [
      makeEvent(
        'eligible-start',
        1000,
        'task.started',
        {
          type: 'task.started',
          kind: 'chat',
        },
        'trace-eligible',
        'session-eligible',
      ),
      makeEvent(
        'eligible-tool',
        1010,
        'tool.completed',
        {
          type: 'tool.completed',
          toolName: 'search',
          durationMs: 10,
        },
        'trace-eligible',
        'session-eligible',
      ),
      makeEvent(
        'eligible-capability',
        1020,
        'capability.completed',
        {
          type: 'capability.completed',
          capability: 'retrieval',
          provider: 'mcp',
          tool: 'lookup',
          success: true,
          durationMs: 11,
        },
        'trace-eligible',
        'session-eligible',
      ),
      makeEvent(
        'eligible-complete',
        1030,
        'task.completed',
        {
          type: 'task.completed',
          kind: 'chat',
          outcome: 'completed',
          durationMs: 32,
        },
        'trace-eligible',
        'session-eligible',
      ),
      makeEvent(
        'incomplete-start',
        2000,
        'task.started',
        {
          type: 'task.started',
          kind: 'chat',
        },
        'trace-incomplete',
        'session-incomplete',
      ),
      makeEvent(
        'incomplete-tool',
        2010,
        'tool.completed',
        {
          type: 'tool.completed',
          toolName: 'write_file',
          durationMs: 9,
        },
        'trace-incomplete',
        'session-incomplete',
      ),
      makeEvent(
        'blank-trace-tool',
        3000,
        'tool.completed',
        {
          type: 'tool.completed',
          toolName: 'ignored',
          durationMs: 5,
        },
        '',
        'session-blank',
      ),
    ]

    const snapshot = buildBehavioralObservationSnapshot(events)

    expect(snapshot.sequenceFamilies).toEqual({
      'tool:search>capability:retrieval': 1,
    })
    expect(snapshot.fingerprintDistribution).toEqual({
      'tool:search>capability:retrieval': 1,
    })
    expect(snapshot.traceRefs).toEqual(['trace-eligible', 'trace-incomplete'])
  })

  it('keeps all decision and divergence statuses insufficient without fabricating derived counts', () => {
    const events: EvaluationEvent[] = [
      makeEvent(
        'trace-b-start',
        1000,
        'task.started',
        {
          type: 'task.started',
          kind: 'chat',
        },
        'trace-b',
        'session-b',
      ),
      makeEvent(
        'trace-b-response',
        1010,
        'agent.response',
        {
          type: 'agent.response',
          length: 64,
          durationMs: 20,
        },
        'trace-b',
        'session-b',
      ),
      makeEvent(
        'trace-b-policy',
        1020,
        'evolution.policy.decision',
        {
          type: 'evolution.policy.decision',
          mode: 'enforce',
          action: 'execute',
          executed: true,
          source: 'guardrail',
          problemId: 'problem-b',
          policyVersion: 'policy-b',
          reason: 'policy decided',
          evaluatedAt: 1020,
        },
        'trace-b',
        'session-b',
      ),
      makeEvent(
        'trace-b-delivered',
        1030,
        'guardrail.action_delivered',
        {
          type: 'guardrail.action_delivered',
          decisionId: 'decision-b',
          traceId: 'trace-b',
          actionType: 'WARNING',
          policyVersion: 'policy-b',
          timestamp: 1030,
        },
        'trace-b',
        'session-b',
      ),
      makeEvent(
        'trace-b-outcome',
        1040,
        'guardrail.outcome.observed',
        {
          type: 'guardrail.outcome.observed',
          decisionId: 'decision-b',
          traceId: 'trace-b',
          policyVersion: 'policy-b',
          outcome: 'effective',
          confidence: 'medium',
          source: 'auto',
          detail: 'still insufficient for derivation',
          observedAt: 1040,
        },
        'trace-b',
        'session-b',
      ),
      makeEvent(
        'trace-b-complete',
        1050,
        'task.completed',
        {
          type: 'task.completed',
          kind: 'chat',
          outcome: 'completed',
          durationMs: 55,
        },
        'trace-b',
        'session-b',
      ),
    ]

    expect(buildBehavioralObservationSnapshot(events)).toMatchObject({
      sampleCount: 1,
      rejectedSampleCount: 0,
      incompleteEvidenceCount: 0,
      divergenceSummary: {
        detectedCount: 0,
        insufficientCount: 1,
        traceIds: [],
      },
      decisionImpactSummary: {
        derivedCount: 0,
        insufficientCount: 1,
        traceIds: [],
      },
    })
  })
})
