import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { describe, expect, it } from 'vitest'

import { buildBehavioralObservationSnapshot } from '@akemi-mio/core/core/evaluation/BehavioralObservationWriter'
import type { EvaluationEvent } from '@akemi-mio/core/core/evaluation/types'
import { runPassiveObservationReview, type PassiveObservationReviewStore } from '../../../../../scripts/m57-passive-observation-review'

function makeEvent(
  id: string,
  traceId: string,
  type: EvaluationEvent['type'],
  payload: EvaluationEvent['payload'],
  seq: number,
): EvaluationEvent {
  return {
    id,
    timestamp: 1_000 + seq,
    traceId,
    sessionId: 'session-1',
    source: 'test',
    type,
    payload,
    seq,
  }
}

function makeStableEvents(): EvaluationEvent[] {
  return [
    makeEvent(
      'started',
      'trace-1',
      'task.started',
      {
        type: 'task.started',
        kind: 'chat',
        description: 'chat',
        inputLength: 4,
      },
      1,
    ),
    makeEvent(
      'response',
      'trace-1',
      'agent.response',
      {
        type: 'agent.response',
        length: 10,
        durationMs: 20,
      },
      2,
    ),
    makeEvent(
      'completed',
      'trace-1',
      'task.completed',
      {
        type: 'task.completed',
        kind: 'chat',
        outcome: 'completed',
        durationMs: 30,
      },
      3,
    ),
  ]
}

function makeStore(events: EvaluationEvent[]): PassiveObservationReviewStore {
  return {
    init: async () => {},
    queryStrict: async () => events,
    shutdown: async () => {},
  }
}

describe('m57 passive observation review runner', () => {
  it('rebuilds current evidence from the event ledger and writes Continue Freeze', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'm57-passive-runner-'))
    const currentArtifactPath = join(directory, 'behavioral-observation.json')
    const outputPath = join(directory, 'passive-review.json')
    const events = makeStableEvents()
    const snapshot = buildBehavioralObservationSnapshot(events)
    await writeFile(currentArtifactPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')

    const result = await runPassiveObservationReview({
      currentArtifactPath,
      outputPath,
      createStore: () => makeStore(events),
      initDatabase: async () => {},
      closeDatabase: async () => {},
      now: () => '2026-08-03T00:00:00.000Z',
    })

    expect(result.report.decision).toBe('Continue Freeze')
    expect(result.report.current.sampleCount).toBe(1)
    expect(result.outputPath).toBe(outputPath)
    expect(JSON.parse(await readFile(outputPath, 'utf8')).decision).toBe('Continue Freeze')
  })

  it('fails closed when the persisted behavioral artifact disagrees with the ledger snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'm57-passive-runner-'))
    const currentArtifactPath = join(directory, 'behavioral-observation.json')
    const outputPath = join(directory, 'passive-review.json')
    const events = makeStableEvents()
    const snapshot = buildBehavioralObservationSnapshot(events)
    await writeFile(currentArtifactPath, `${JSON.stringify({ ...snapshot, sampleCount: snapshot.sampleCount + 1 }, null, 2)}\n`, 'utf8')

    await expect(
      runPassiveObservationReview({
        currentArtifactPath,
        outputPath,
        createStore: () => makeStore(events),
        initDatabase: async () => {},
        closeDatabase: async () => {},
        now: () => '2026-08-03T00:00:00.000Z',
      }),
    ).rejects.toThrow(/behavioral artifact mismatch/i)

    await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
