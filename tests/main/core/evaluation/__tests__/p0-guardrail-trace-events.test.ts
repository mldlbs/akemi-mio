/**
 * 机制涌现 P0 (c): guardrail.triggered / guardrail.recovery 写入 sink
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { GuardrailPipeline } from '@akemi-mio/core/core/evaluation/GuardrailPipeline'
import type { GuardrailTraceEvent, GuardrailTraceSink } from '@akemi-mio/core/core/evaluation/GuardrailTraceSink'
import type { GuardrailDecision } from '@akemi-mio/core/core/evaluation/GuardrailTypes'
import type { ProgressSnapshot } from '@akemi-mio/core/core/evaluation/progress'
import { PROGRESS_VERSION } from '@akemi-mio/core/core/evaluation/progress'

const SNAPSHOT: ProgressSnapshot = {
  traceId: 'p0_trace',
  sessionId: 'p0_session',
  version: PROGRESS_VERSION,
  totalTurns: 10,
  elapsedMs: 1000,
  observedAt: Date.now(),
  stateChange: {
    hasNewToolResult: false,
    hasNewAssistantContent: false,
    hasPlanningStateChange: false,
    stagnantTurnCount: 8,
    lastChangeTurn: -1,
    summary: '',
  },
  informationGain: {
    consecutiveLowOutputTurns: 10,
    repeatedOutputCount: 5,
    repeatedToolResultCount: 3,
    toolResultNovelty: 0,
    summary: '',
  },
  goalProgress: { completedSubtasks: 0, hasPhaseTransition: false, stagnantTurnCount: 8, summary: '' },
}

function decision(action: GuardrailDecision['action'], reason: string): GuardrailDecision {
  return {
    action,
    reason,
    decidedAt: Date.now(),
    traceId: 'p0_trace',
    signals: [],
    snapshot: SNAPSHOT,
    policyVersion: 'v1',
  }
}

function collectingSink(): { sink: GuardrailTraceSink; events: GuardrailTraceEvent[] } {
  const events: GuardrailTraceEvent[] = []
  return {
    events,
    sink: (e) => {
      events.push(e)
    },
  }
}

describe('P0 guardrail trace sink events', () => {
  let pipeline: GuardrailPipeline
  let collected: GuardrailTraceEvent[]
  let sink: GuardrailTraceSink

  beforeEach(() => {
    const c = collectingSink()
    sink = c.sink
    collected = c.events
    pipeline = new GuardrailPipeline(undefined, { minTurnsBeforeCheck: 0, checkIntervalTurns: 0 }, undefined, undefined, sink)
  })

  it('emits guardrail.triggered on terminate', async () => {
    pipeline.onGuardrailDecision(decision('terminate', 'stalled'))
    const result = await pipeline.check('p0_trace', 10)
    expect(result).not.toBeNull()
    expect(collected).toHaveLength(1)
    expect(collected[0].event_type).toBe('guardrail.triggered')
    expect(collected[0].trace_id).toBe('p0_trace')
    expect(collected[0].payload.action).toBe('terminate')
    expect(collected[0].outcome).toBe('error')
  })

  it('emits guardrail.triggered on warning', async () => {
    pipeline.onGuardrailDecision(decision('warning', 'degrading'))
    await pipeline.check('p0_trace', 10)
    expect(collected).toHaveLength(1)
    expect(collected[0].event_type).toBe('guardrail.triggered')
    expect(collected[0].payload.action).toBe('warning')
  })

  it('no triggered on continue', async () => {
    pipeline.onGuardrailDecision(decision('continue', 'healthy'))
    await pipeline.check('p0_trace', 10)
    expect(collected).toHaveLength(0)
  })

  it('emits recovery after terminate then continue', async () => {
    pipeline.onGuardrailDecision(decision('terminate', 'stalled'))
    await pipeline.check('p0_trace', 10)
    pipeline.onGuardrailDecision(decision('continue', 'recovered'))
    await pipeline.check('p0_trace', 20)
    expect(collected).toHaveLength(2)
    expect(collected[1].event_type).toBe('guardrail.recovery')
    expect(collected[1].payload.previousAction).toBe('terminate')
    expect(collected[1].outcome).toBe('success')
  })

  it('emits recovery after warning then continue', async () => {
    pipeline.onGuardrailDecision(decision('warning', 'degrading'))
    await pipeline.check('p0_trace', 10)
    pipeline.onGuardrailDecision(decision('continue', 'ok'))
    await pipeline.check('p0_trace', 20)
    expect(collected[1].event_type).toBe('guardrail.recovery')
    expect(collected[1].payload.previousAction).toBe('warning')
  })

  it('no recovery without a prior non-continue', async () => {
    pipeline.onGuardrailDecision(decision('continue', 'healthy'))
    await pipeline.check('p0_trace', 10)
    await pipeline.check('p0_trace', 20)
    expect(collected).toHaveLength(0)
  })

  it('reset clears recovery state', async () => {
    pipeline.onGuardrailDecision(decision('terminate', 'stalled'))
    await pipeline.check('p0_trace', 10)
    pipeline.reset()
    pipeline.onGuardrailDecision(decision('continue', 'new trace'))
    await pipeline.check('p0_trace', 20)
    // only the prior triggered remains; no recovery after reset
    expect(collected.filter((e) => e.event_type === 'guardrail.recovery')).toHaveLength(0)
  })

  it('no events when sink is absent', async () => {
    const bare = new GuardrailPipeline(undefined, { minTurnsBeforeCheck: 0, checkIntervalTurns: 0 })
    bare.onGuardrailDecision(decision('terminate', 'stalled'))
    const result = await bare.check('p0_trace', 10)
    expect(result).not.toBeNull()
  })
})
