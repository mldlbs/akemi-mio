import { describe, expect, it } from 'vitest'
import { BehavioralEvidenceAnalyzer, type BehavioralTraceAnalysis } from '@akemi-mio/core/core/evaluation/BehavioralEvidenceAnalyzer'
import type { EvaluationEvent, EventType } from '@akemi-mio/core/core/evaluation/types'

function makeEvent(
  id: string,
  timestamp: number,
  type: EventType,
  payload: EvaluationEvent['payload'],
  traceId = 'trace-chat-1',
  sessionId = 'session-1',
  seq?: number,
): EvaluationEvent {
  return {
    id,
    timestamp,
    traceId,
    sessionId,
    source: 'behavioral-evidence-test',
    type,
    payload,
    ...(seq === undefined ? {} : { seq }),
  }
}

function compute(traceId: string, events: EvaluationEvent[]): BehavioralTraceAnalysis {
  return BehavioralEvidenceAnalyzer.compute(traceId, events)
}

describe('BehavioralEvidenceAnalyzer', () => {
  it('derives a valid closed-chat sequence, fingerprint, and sequence event ids', () => {
    const events: EvaluationEvent[] = [
      makeEvent(
        'outside-before',
        900,
        'tool.completed',
        {
          type: 'tool.completed',
          toolName: 'ignored-before-window',
          durationMs: 5,
        },
        'trace-chat-1',
        'foreign-session',
      ),
      makeEvent('task-start', 1000, 'task.started', {
        type: 'task.started',
        kind: 'chat',
      }),
      makeEvent('tool-invoked', 1010, 'tool.invoked', {
        type: 'tool.invoked',
        toolName: 'search',
      }),
      makeEvent('tool-completed', 1020, 'tool.completed', {
        type: 'tool.completed',
        toolName: 'search',
        durationMs: 20,
      }),
      makeEvent('cap-invoked', 1030, 'capability.invoked', {
        type: 'capability.invoked',
        capability: 'retrieval',
        provider: 'mcp',
        tool: 'tool-search',
      }),
      makeEvent('cap-completed', 1040, 'capability.completed', {
        type: 'capability.completed',
        capability: 'retrieval',
        provider: 'mcp',
        tool: 'tool-search',
        success: true,
        durationMs: 12,
      }),
      makeEvent('response', 1050, 'agent.response', {
        type: 'agent.response',
        length: 120,
        durationMs: 100,
      }),
      makeEvent('task-completed', 1060, 'task.completed', {
        type: 'task.completed',
        kind: 'chat',
        outcome: 'completed',
        durationMs: 200,
      }),
      makeEvent('outside-after', 1070, 'capability.completed', {
        type: 'capability.completed',
        capability: 'ignored-after-window',
        provider: 'mcp',
        tool: 'ignored-tool',
        success: true,
        durationMs: 5,
      }),
    ]

    expect(compute('trace-chat-1', events)).toEqual({
      traceId: 'trace-chat-1',
      sessionId: 'session-1',
      sampleStatus: 'valid',
      observationEligible: true,
      sequenceStatus: 'derived',
      decisionImpactStatus: 'insufficient_for_decision_impact',
      divergenceStatus: 'insufficient_for_divergence',
      sequence: ['tool:search', 'capability:retrieval', 'response'],
      sequenceEventIds: ['tool-completed', 'cap-completed', 'response'],
      fingerprint: 'tool:search>capability:retrieval>response',
      decisionIds: [],
    })
  })

  it('marks traces with multiple chat boundaries as incomplete and omits sequence evidence', () => {
    const events: EvaluationEvent[] = [
      makeEvent('task-start-1', 1000, 'task.started', {
        type: 'task.started',
        kind: 'chat',
      }),
      makeEvent('tool-between', 1010, 'tool.completed', {
        type: 'tool.completed',
        toolName: 'search',
        durationMs: 10,
      }),
      makeEvent('task-start-2', 1020, 'task.started', {
        type: 'task.started',
        kind: 'chat',
      }),
      makeEvent('response-between', 1030, 'agent.response', {
        type: 'agent.response',
        length: 40,
        durationMs: 10,
      }),
      makeEvent('task-completed-1', 1040, 'task.completed', {
        type: 'task.completed',
        kind: 'chat',
        outcome: 'completed',
        durationMs: 20,
      }),
      makeEvent('task-completed-2', 1050, 'task.completed', {
        type: 'task.completed',
        kind: 'chat',
        outcome: 'completed',
        durationMs: 20,
      }),
    ]

    expect(compute('trace-chat-1', events)).toEqual({
      traceId: 'trace-chat-1',
      sessionId: '',
      sampleStatus: 'incomplete_sample',
      observationEligible: false,
      sequenceStatus: 'insufficient_for_fingerprint',
      decisionImpactStatus: 'insufficient_for_decision_impact',
      divergenceStatus: 'insufficient_for_divergence',
      sequence: [],
      sequenceEventIds: [],
      fingerprint: null,
      decisionIds: [],
    })
  })

  it('marks a trace incomplete and ineligible when task.completed is missing', () => {
    const events: EvaluationEvent[] = [
      makeEvent('task-start', 1000, 'task.started', {
        type: 'task.started',
        kind: 'chat',
      }),
      makeEvent('tool-completed', 1010, 'tool.completed', {
        type: 'tool.completed',
        toolName: 'read_file',
        durationMs: 10,
      }),
      makeEvent('response', 1020, 'agent.response', {
        type: 'agent.response',
        length: 64,
        durationMs: 80,
      }),
    ]

    expect(compute('trace-chat-1', events)).toEqual({
      traceId: 'trace-chat-1',
      sessionId: 'session-1',
      sampleStatus: 'incomplete_sample',
      observationEligible: false,
      sequenceStatus: 'insufficient_for_fingerprint',
      decisionImpactStatus: 'insufficient_for_decision_impact',
      divergenceStatus: 'insufficient_for_divergence',
      sequence: [],
      sequenceEventIds: [],
      fingerprint: null,
      decisionIds: [],
    })
  })

  it('marks completion-before-start as incomplete and does not derive partial evidence', () => {
    const events: EvaluationEvent[] = [
      makeEvent('task-completed-first', 1000, 'task.completed', {
        type: 'task.completed',
        kind: 'chat',
        outcome: 'completed',
        durationMs: 50,
      }),
      makeEvent('task-start-late', 1010, 'task.started', {
        type: 'task.started',
        kind: 'chat',
      }),
      makeEvent('tool-after-start', 1020, 'tool.completed', {
        type: 'tool.completed',
        toolName: 'not-closed',
        durationMs: 10,
      }),
    ]

    expect(compute('trace-chat-1', events)).toEqual({
      traceId: 'trace-chat-1',
      sessionId: 'session-1',
      sampleStatus: 'incomplete_sample',
      observationEligible: false,
      sequenceStatus: 'insufficient_for_fingerprint',
      decisionImpactStatus: 'insufficient_for_decision_impact',
      divergenceStatus: 'insufficient_for_divergence',
      sequence: [],
      sequenceEventIds: [],
      fingerprint: null,
      decisionIds: [],
    })
  })

  it('reports insufficient decision impact and no decision ids without explicit delivery linkage', () => {
    const events: EvaluationEvent[] = [
      makeEvent('task-start', 1000, 'task.started', {
        type: 'task.started',
        kind: 'chat',
      }),
      makeEvent('response', 1010, 'agent.response', {
        type: 'agent.response',
        length: 80,
        durationMs: 70,
      }),
      makeEvent('policy-decision', 1020, 'evolution.policy.decision', {
        type: 'evolution.policy.decision',
        mode: 'enforce',
        action: 'execute',
        executed: true,
        source: 'guardrail',
        problemId: 'p-1',
        policyVersion: 'policy-v1',
        reason: 'policy decided',
        evaluatedAt: 1020,
      }),
      makeEvent('outcome-only', 1030, 'guardrail.outcome.observed', {
        type: 'guardrail.outcome.observed',
        decisionId: 'decision-1',
        traceId: 'trace-chat-1',
        policyVersion: 'policy-v1',
        outcome: 'effective',
        confidence: 'high',
        source: 'auto',
        detail: 'observed without delivery',
        observedAt: 1030,
      }),
      makeEvent('task-completed', 1040, 'task.completed', {
        type: 'task.completed',
        kind: 'chat',
        outcome: 'completed',
        durationMs: 90,
      }),
    ]

    const analysis = compute('trace-chat-1', events)

    expect(analysis.decisionImpactStatus).toBe('insufficient_for_decision_impact')
    expect(analysis.decisionIds).toEqual([])
  })

  it('reports insufficient decision impact when delivery and outcome have no policy decision', () => {
    const events: EvaluationEvent[] = [
      makeEvent('task-start', 1000, 'task.started', {
        type: 'task.started',
        kind: 'chat',
      }),
      makeEvent('delivery', 1010, 'guardrail.action_delivered', {
        type: 'guardrail.action_delivered',
        decisionId: 'decision-no-policy',
        traceId: 'trace-chat-1',
        actionType: 'WARNING',
        policyVersion: 'policy-v1',
        timestamp: 1010,
      }),
      makeEvent('outcome', 1020, 'guardrail.outcome.observed', {
        type: 'guardrail.outcome.observed',
        decisionId: 'decision-no-policy',
        traceId: 'trace-chat-1',
        policyVersion: 'policy-v1',
        outcome: 'effective',
        confidence: 'high',
        source: 'auto',
        detail: 'observed without policy decision',
        observedAt: 1020,
      }),
      makeEvent('task-completed', 1030, 'task.completed', {
        type: 'task.completed',
        kind: 'chat',
        outcome: 'completed',
        durationMs: 80,
      }),
    ]

    expect(compute('trace-chat-1', events)).toMatchObject({
      decisionImpactStatus: 'insufficient_for_decision_impact',
      decisionIds: ['decision-no-policy'],
    })
  })

  it('reports insufficient decision impact when a policy decision has no delivery or outcome linkage', () => {
    const events: EvaluationEvent[] = [
      makeEvent('task-start', 1000, 'task.started', {
        type: 'task.started',
        kind: 'chat',
      }),
      makeEvent('policy-decision-only', 1010, 'evolution.policy.decision', {
        type: 'evolution.policy.decision',
        mode: 'enforce',
        action: 'execute',
        executed: true,
        source: 'guardrail',
        problemId: 'p-policy-only',
        policyVersion: 'policy-v1',
        reason: 'policy decided',
        evaluatedAt: 1010,
      }),
      makeEvent('task-completed', 1020, 'task.completed', {
        type: 'task.completed',
        kind: 'chat',
        outcome: 'completed',
        durationMs: 60,
      }),
    ]

    expect(compute('trace-chat-1', events)).toMatchObject({
      decisionImpactStatus: 'insufficient_for_decision_impact',
      decisionIds: [],
    })
  })

  it('keeps delivery decision ids traceable but still reports insufficient decision impact when policy version matches', () => {
    const events: EvaluationEvent[] = [
      makeEvent('task-start', 1000, 'task.started', {
        type: 'task.started',
        kind: 'chat',
      }),
      makeEvent('policy-decision', 1010, 'evolution.policy.decision', {
        type: 'evolution.policy.decision',
        mode: 'enforce',
        action: 'execute',
        executed: true,
        source: 'guardrail',
        problemId: 'p-join-gap',
        policyVersion: 'policy-v2',
        reason: 'policy decided',
        evaluatedAt: 1010,
      }),
      makeEvent('delivery', 1020, 'guardrail.action_delivered', {
        type: 'guardrail.action_delivered',
        decisionId: 'decision-policy-gap',
        traceId: 'trace-chat-1',
        actionType: 'WARNING',
        policyVersion: 'policy-v2',
        timestamp: 1020,
      }),
      makeEvent('outcome', 1030, 'guardrail.outcome.observed', {
        type: 'guardrail.outcome.observed',
        decisionId: 'decision-policy-gap',
        traceId: 'trace-chat-1',
        policyVersion: 'policy-v2',
        outcome: 'effective',
        confidence: 'high',
        source: 'auto',
        detail: 'still no explicit policy decision id linkage',
        observedAt: 1030,
      }),
      makeEvent('task-completed', 1040, 'task.completed', {
        type: 'task.completed',
        kind: 'chat',
        outcome: 'completed',
        durationMs: 50,
      }),
    ]

    expect(compute('trace-chat-1', events)).toMatchObject({
      decisionImpactStatus: 'insufficient_for_decision_impact',
      decisionIds: ['decision-policy-gap'],
    })
  })

  it('ignores foreign and blank-trace capability events when deriving the selected trace sequence', () => {
    const events: EvaluationEvent[] = [
      makeEvent('task-start', 1000, 'task.started', {
        type: 'task.started',
        kind: 'chat',
      }),
      makeEvent(
        'foreign-cap',
        1010,
        'capability.completed',
        {
          type: 'capability.completed',
          capability: 'foreign-capability',
          provider: 'mcp',
          tool: 'foreign-tool',
          success: true,
          durationMs: 8,
        },
        'foreign-trace',
        'session-foreign',
      ),
      makeEvent(
        'blank-cap',
        1020,
        'capability.completed',
        {
          type: 'capability.completed',
          capability: 'blank-capability',
          provider: 'mcp',
          tool: 'blank-tool',
          success: true,
          durationMs: 8,
        },
        '',
        'session-blank',
      ),
      makeEvent('local-tool', 1030, 'tool.completed', {
        type: 'tool.completed',
        toolName: 'search',
        durationMs: 14,
      }),
      makeEvent('local-cap', 1040, 'capability.completed', {
        type: 'capability.completed',
        capability: 'retrieval',
        provider: 'mcp',
        tool: 'local-tool',
        success: true,
        durationMs: 16,
      }),
      makeEvent('task-completed', 1050, 'task.completed', {
        type: 'task.completed',
        kind: 'chat',
        outcome: 'completed',
        durationMs: 100,
      }),
    ]

    expect(compute('trace-chat-1', events).sequence).toEqual(['tool:search', 'capability:retrieval'])
  })

  it('produces the same analysis for differently ordered input when timestamps define the sequence order', () => {
    const ordered: EvaluationEvent[] = [
      makeEvent('task-start', 1000, 'task.started', {
        type: 'task.started',
        kind: 'chat',
      }),
      makeEvent('tool-completed', 1030, 'tool.completed', {
        type: 'tool.completed',
        toolName: 'search',
        durationMs: 15,
      }),
      makeEvent('cap-completed', 1040, 'capability.completed', {
        type: 'capability.completed',
        capability: 'retrieval',
        provider: 'mcp',
        tool: 'tool-search',
        success: true,
        durationMs: 10,
      }),
      makeEvent('response', 1050, 'agent.response', {
        type: 'agent.response',
        length: 90,
        durationMs: 60,
      }),
      makeEvent('task-completed', 1060, 'task.completed', {
        type: 'task.completed',
        kind: 'chat',
        outcome: 'completed',
        durationMs: 120,
      }),
    ]

    const scrambled = [ordered[3], ordered[1], ordered[4], ordered[0], ordered[2]]

    expect(compute('trace-chat-1', scrambled)).toEqual(compute('trace-chat-1', ordered))
  })

  it('uses seq before id for timestamp ties so replay input order does not change the result', () => {
    const events: EvaluationEvent[] = [
      makeEvent(
        'task-start',
        1000,
        'task.started',
        {
          type: 'task.started',
          kind: 'chat',
        },
        'trace-chat-1',
        'session-1',
        1,
      ),
      makeEvent(
        'cap-first',
        1010,
        'capability.completed',
        {
          type: 'capability.completed',
          capability: 'retrieve',
          provider: 'mcp',
          tool: 'lookup',
          success: true,
          durationMs: 9,
        },
        'trace-chat-1',
        'session-1',
        20,
      ),
      makeEvent(
        'tool-second',
        1010,
        'tool.completed',
        {
          type: 'tool.completed',
          toolName: 'search',
          durationMs: 11,
        },
        'trace-chat-1',
        'session-1',
        10,
      ),
      makeEvent(
        'response-third',
        1010,
        'agent.response',
        {
          type: 'agent.response',
          length: 40,
          durationMs: 20,
        },
        'trace-chat-1',
        'session-1',
        30,
      ),
      makeEvent(
        'task-completed',
        1020,
        'task.completed',
        {
          type: 'task.completed',
          kind: 'chat',
          outcome: 'completed',
          durationMs: 30,
        },
        'trace-chat-1',
        'session-1',
        40,
      ),
    ]

    const replayed = [events[3], events[1], events[4], events[2], events[0]]

    expect(compute('trace-chat-1', replayed)).toEqual(compute('trace-chat-1', events))
    expect(compute('trace-chat-1', replayed).sequence).toEqual(['tool:search', 'capability:retrieve', 'response'])
    expect(compute('trace-chat-1', replayed).sequenceEventIds).toEqual(['tool-second', 'cap-first', 'response-third'])
  })

  it('falls back to id ordering for same-timestamp ties when only one event has seq', () => {
    const events: EvaluationEvent[] = [
      makeEvent('task-start', 1000, 'task.started', {
        type: 'task.started',
        kind: 'chat',
      }),
      makeEvent(
        'z-tool',
        1010,
        'tool.completed',
        {
          type: 'tool.completed',
          toolName: 'late-by-id',
          durationMs: 10,
        },
        'trace-chat-1',
        'session-1',
        5,
      ),
      makeEvent('a-capability', 1010, 'capability.completed', {
        type: 'capability.completed',
        capability: 'first-by-id',
        provider: 'mcp',
        tool: 'lookup',
        success: true,
        durationMs: 10,
      }),
      makeEvent('m-response', 1010, 'agent.response', {
        type: 'agent.response',
        length: 20,
        durationMs: 10,
      }),
      makeEvent('task-completed', 1020, 'task.completed', {
        type: 'task.completed',
        kind: 'chat',
        outcome: 'completed',
        durationMs: 20,
      }),
    ]

    const replayed = [events[2], events[4], events[1], events[0], events[3]]

    expect(compute('trace-chat-1', replayed)).toEqual(compute('trace-chat-1', events))
    expect(compute('trace-chat-1', replayed).sequence).toEqual(['capability:first-by-id', 'response', 'tool:late-by-id'])
    expect(compute('trace-chat-1', replayed).sequenceEventIds).toEqual(['a-capability', 'm-response', 'z-tool'])
  })

  it('uses event id as the deterministic timestamp tie-breaker when seq is absent', () => {
    const events: EvaluationEvent[] = [
      makeEvent('z-task-start', 1000, 'task.started', {
        type: 'task.started',
        kind: 'chat',
      }),
      makeEvent('b-tool', 1010, 'tool.completed', {
        type: 'tool.completed',
        toolName: 'second-by-id',
        durationMs: 10,
      }),
      makeEvent('a-capability', 1010, 'capability.completed', {
        type: 'capability.completed',
        capability: 'first-by-id',
        provider: 'mcp',
        tool: 'lookup',
        success: true,
        durationMs: 10,
      }),
      makeEvent('z-task-completed', 1020, 'task.completed', {
        type: 'task.completed',
        kind: 'chat',
        outcome: 'completed',
        durationMs: 30,
      }),
    ]

    const replayed = [events[1], events[3], events[0], events[2]]

    expect(compute('trace-chat-1', replayed).sequence).toEqual(['capability:first-by-id', 'tool:second-by-id'])
  })

  it('sources session id from the unique chat boundary window instead of unrelated same-trace events', () => {
    const events: EvaluationEvent[] = [
      makeEvent(
        'foreign-pre-window',
        900,
        'agent.response',
        {
          type: 'agent.response',
          length: 10,
          durationMs: 5,
        },
        'trace-chat-1',
        'foreign-session',
      ),
      makeEvent(
        'task-start',
        1000,
        'task.started',
        {
          type: 'task.started',
          kind: 'chat',
        },
        'trace-chat-1',
        'boundary-session',
      ),
      makeEvent(
        'tool-completed',
        1010,
        'tool.completed',
        {
          type: 'tool.completed',
          toolName: 'search',
          durationMs: 10,
        },
        'trace-chat-1',
        'boundary-session',
      ),
      makeEvent(
        'task-completed',
        1020,
        'task.completed',
        {
          type: 'task.completed',
          kind: 'chat',
          outcome: 'completed',
          durationMs: 10,
        },
        'trace-chat-1',
        'boundary-session',
      ),
    ]

    expect(compute('trace-chat-1', events).sessionId).toBe('boundary-session')
  })

  it('rejects traces whose chat start and completion have different session ids', () => {
    const events: EvaluationEvent[] = [
      makeEvent(
        'task-start',
        1000,
        'task.started',
        {
          type: 'task.started',
          kind: 'chat',
        },
        'trace-chat-1',
        'session-a',
      ),
      makeEvent(
        'tool-completed',
        1010,
        'tool.completed',
        {
          type: 'tool.completed',
          toolName: 'search',
          durationMs: 10,
        },
        'trace-chat-1',
        'session-a',
      ),
      makeEvent(
        'task-completed',
        1020,
        'task.completed',
        {
          type: 'task.completed',
          kind: 'chat',
          outcome: 'completed',
          durationMs: 10,
        },
        'trace-chat-1',
        'session-b',
      ),
    ]

    expect(compute('trace-chat-1', events)).toMatchObject({
      sessionId: '',
      sampleStatus: 'incomplete_sample',
      observationEligible: false,
      sequenceStatus: 'insufficient_for_fingerprint',
      sequence: [],
      sequenceEventIds: [],
      fingerprint: null,
    })
  })

  it('allows runtime-session model facts inside a closed chat window', () => {
    const events: EvaluationEvent[] = [
      makeEvent(
        'user-message',
        990,
        'user.message',
        {
          type: 'user.message',
          length: 82,
        },
        'trace-chat-1',
        'boundary-session',
      ),
      makeEvent(
        'task-start',
        1000,
        'task.started',
        {
          type: 'task.started',
          kind: 'chat',
        },
        'trace-chat-1',
        'boundary-session',
      ),
      makeEvent(
        'memory-context',
        1010,
        'memory.context.injected',
        {
          type: 'memory.context.injected',
          tokenEstimate: 20,
        },
        'trace-chat-1',
        'boundary-session',
      ),
      makeEvent(
        'model-invoked',
        1020,
        'model.invoked',
        {
          type: 'model.invoked',
          provider: 'openai',
          model: 'gpt-test',
        },
        'trace-chat-1',
        'runtime-session',
      ),
      makeEvent(
        'model-completed',
        1030,
        'model.completed',
        {
          type: 'model.completed',
          provider: 'openai',
          model: 'gpt-test',
          durationMs: 42,
        },
        'trace-chat-1',
        'runtime-session',
      ),
      makeEvent(
        'response',
        1040,
        'agent.response',
        {
          type: 'agent.response',
          length: 20,
          durationMs: 44,
        },
        'trace-chat-1',
        'boundary-session',
      ),
      makeEvent(
        'task-completed',
        1050,
        'task.completed',
        {
          type: 'task.completed',
          kind: 'chat',
          outcome: 'completed',
          durationMs: 60,
        },
        'trace-chat-1',
        'boundary-session',
      ),
    ]

    expect(compute('trace-chat-1', events)).toMatchObject({
      sessionId: 'boundary-session',
      sampleStatus: 'valid',
      observationEligible: true,
      sequenceStatus: 'derived',
      sequence: ['response'],
      sequenceEventIds: ['response'],
      fingerprint: 'response',
    })
  })

  it('allows runtime-session tool facts inside a closed chat window and derives tool fingerprints', () => {
    const events: EvaluationEvent[] = [
      makeEvent(
        'task-start',
        1000,
        'task.started',
        {
          type: 'task.started',
          kind: 'chat',
        },
        'trace-chat-1',
        'boundary-session',
      ),
      makeEvent(
        'model-invoked',
        1010,
        'model.invoked',
        {
          type: 'model.invoked',
          provider: 'openai',
          model: 'gpt-test',
        },
        'trace-chat-1',
        'runtime-session',
      ),
      makeEvent(
        'model-completed',
        1020,
        'model.completed',
        {
          type: 'model.completed',
          provider: 'openai',
          model: 'gpt-test',
          durationMs: 42,
        },
        'trace-chat-1',
        'runtime-session',
      ),
      makeEvent(
        'tool-invoked',
        1030,
        'tool.invoked',
        {
          type: 'tool.invoked',
          toolName: 'system_execution',
        },
        'trace-chat-1',
        'runtime-session',
      ),
      makeEvent(
        'tool-completed',
        1040,
        'tool.completed',
        {
          type: 'tool.completed',
          toolName: 'system_execution',
          durationMs: 12,
        },
        'trace-chat-1',
        'runtime-session',
      ),
      makeEvent(
        'response',
        1050,
        'agent.response',
        {
          type: 'agent.response',
          length: 20,
          durationMs: 44,
        },
        'trace-chat-1',
        'boundary-session',
      ),
      makeEvent(
        'task-completed',
        1060,
        'task.completed',
        {
          type: 'task.completed',
          kind: 'chat',
          outcome: 'completed',
          durationMs: 60,
        },
        'trace-chat-1',
        'boundary-session',
      ),
    ]

    expect(compute('trace-chat-1', events)).toMatchObject({
      sessionId: 'boundary-session',
      sampleStatus: 'valid',
      observationEligible: true,
      sequenceStatus: 'derived',
      sequence: ['tool:system_execution', 'response'],
      sequenceEventIds: ['tool-completed', 'response'],
      fingerprint: 'tool:system_execution>response',
    })
  })

  it('rejects a closed chat window when any interior same-trace event has a foreign session id', () => {
    const events: EvaluationEvent[] = [
      makeEvent(
        'task-start',
        1000,
        'task.started',
        {
          type: 'task.started',
          kind: 'chat',
        },
        'trace-chat-1',
        'boundary-session',
      ),
      makeEvent(
        'tool-completed',
        1010,
        'tool.completed',
        {
          type: 'tool.completed',
          toolName: 'search',
          durationMs: 10,
        },
        'trace-chat-1',
        'boundary-session',
      ),
      makeEvent(
        'foreign-response',
        1020,
        'agent.response',
        {
          type: 'agent.response',
          length: 20,
          durationMs: 10,
        },
        'trace-chat-1',
        'foreign-session',
      ),
      makeEvent(
        'foreign-capability',
        1030,
        'capability.completed',
        {
          type: 'capability.completed',
          capability: 'retrieval',
          provider: 'mcp',
          tool: 'lookup',
          success: true,
          durationMs: 10,
        },
        'trace-chat-1',
        'foreign-session',
      ),
      makeEvent(
        'foreign-tool',
        1040,
        'tool.completed',
        {
          type: 'tool.completed',
          toolName: 'write_file',
          durationMs: 10,
        },
        'trace-chat-1',
        'foreign-session',
      ),
      makeEvent(
        'task-completed',
        1050,
        'task.completed',
        {
          type: 'task.completed',
          kind: 'chat',
          outcome: 'completed',
          durationMs: 10,
        },
        'trace-chat-1',
        'boundary-session',
      ),
    ]

    expect(compute('trace-chat-1', events)).toEqual({
      traceId: 'trace-chat-1',
      sessionId: 'boundary-session',
      sampleStatus: 'incomplete_sample',
      observationEligible: false,
      sequenceStatus: 'insufficient_for_fingerprint',
      decisionImpactStatus: 'insufficient_for_decision_impact',
      divergenceStatus: 'insufficient_for_divergence',
      sequence: [],
      sequenceEventIds: [],
      fingerprint: null,
      decisionIds: [],
    })
  })

  it('keeps decision impact insufficient even when delivery and outcome match a policy version', () => {
    const events: EvaluationEvent[] = [
      makeEvent('task-start', 1000, 'task.started', {
        type: 'task.started',
        kind: 'chat',
      }),
      makeEvent('response', 1010, 'agent.response', {
        type: 'agent.response',
        length: 72,
        durationMs: 45,
      }),
      makeEvent('policy-decision', 1020, 'evolution.policy.decision', {
        type: 'evolution.policy.decision',
        mode: 'enforce',
        action: 'execute',
        executed: true,
        source: 'guardrail',
        problemId: 'p-7',
        policyVersion: 'policy-v3',
        reason: 'policy decided',
        evaluatedAt: 1020,
      }),
      makeEvent('delivery', 1030, 'guardrail.action_delivered', {
        type: 'guardrail.action_delivered',
        decisionId: 'decision-7',
        traceId: 'trace-chat-1',
        actionType: 'WARNING',
        policyVersion: 'policy-v3',
        timestamp: 1030,
      }),
      makeEvent('outcome', 1040, 'guardrail.outcome.observed', {
        type: 'guardrail.outcome.observed',
        decisionId: 'decision-7',
        traceId: 'trace-chat-1',
        policyVersion: 'policy-v3',
        outcome: 'effective',
        confidence: 'medium',
        source: 'auto',
        detail: 'warning was effective',
        observedAt: 1040,
      }),
      makeEvent('task-completed', 1050, 'task.completed', {
        type: 'task.completed',
        kind: 'chat',
        outcome: 'completed',
        durationMs: 88,
      }),
    ]

    expect(compute('trace-chat-1', events)).toMatchObject({
      decisionImpactStatus: 'insufficient_for_decision_impact',
      decisionIds: ['decision-7'],
      divergenceStatus: 'insufficient_for_divergence',
    })
  })
})
