import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { CapabilityEvolutionShadowCollector } from '@akemi-mio/evolution/automation/CapabilityEvolutionShadowCollector'
import { CapabilityEvolutionShadowStore } from '@akemi-mio/evolution/automation/CapabilityEvolutionShadowStore'
import type { ToolCallRecord } from '@akemi-mio/capabilities/tool/ToolCallLogStore'

describe('CapabilityEvolutionShadowCollector', () => {
  let tmpDir: string
  let store: CapabilityEvolutionShadowStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'm56-shadow-collector-'))
    store = new CapabilityEvolutionShadowStore(tmpDir)
  })

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('aggregates capability-aware tool events into capability observations and summary metrics', async () => {
    const now = Date.now()
    const records: ToolCallRecord[] = [
      makeRecord('write_file', true, now - 9000, 40, { capability: 'file.management', operation: 'write', provider: '@builtin/core' }),
      makeRecord('write_file', false, now - 8000, 50, { capability: 'file.management', operation: 'write', provider: '@builtin/core' }),
      makeRecord('write_file', false, now - 7000, 45, { capability: 'file.management', operation: 'write', provider: '@builtin/core' }),
      makeRecord('edit_file', true, now - 6000, 35, { capability: 'file.management', operation: 'edit', provider: '@builtin/core' }),
      makeRecord('grep', false, now - 5000, 30, { capability: 'search.retrieval', operation: 'query', provider: '@builtin/core' }),
      makeRecord('grep', true, now - 4000, 20, { capability: 'search.retrieval', operation: 'query', provider: '@builtin/core' }),
      makeRecord('search_files', true, now - 3000, 25, { capability: 'search.retrieval', operation: 'query', provider: '@builtin/core' }),
      makeRecord('search_files', true, now - 2000, 20, { capability: 'search.retrieval', operation: 'query', provider: '@builtin/core' }),
      makeRecord('custom_tool', true, now - 1000, 10),
    ]

    const collector = new CapabilityEvolutionShadowCollector({
      store,
      minIntervalMs: 0,
      recordsProvider: () => records,
    })

    const run = await collector.collect()

    expect(run.summary.totalToolEvents).toBe(9)
    expect(run.summary.capabilityEvents).toBe(8)
    expect(run.summary.coverageRate).toBeCloseTo(8 / 9, 5)
    expect(run.summary.legacyBucketCount).toBe(4)
    expect(run.summary.capabilityBucketCount).toBe(2)
    expect(run.summary.aggregationGain).toBe(2)
    expect(run.summary.trendCorrelation).toBeCloseTo(1, 5)
    expect(run.observations).toHaveLength(2)
    expect(run.observations[0]).toMatchObject({
      capabilityIdentity: { capability: 'file.management' },
      legacyIdentity: { tools: ['edit_file', 'write_file'] },
    })
  })

  it('persists shadow runs to the observation store', async () => {
    const collector = new CapabilityEvolutionShadowCollector({
      store,
      minIntervalMs: 0,
      recordsProvider: () => [
        makeRecord('write_file', true, Date.now(), 10, {
          capability: 'file.management',
          operation: 'write',
          provider: '@builtin/core',
        }),
      ],
    })

    const run = await collector.collect()
    const stored = store.getLatest()

    expect(stored?.runId).toBe(run.runId)
    expect(stored?.observations.length).toBe(run.observations.length)
  })
})

function makeRecord(
  toolName: string,
  success: boolean,
  timestamp: number,
  durationMs: number,
  identity?: {
    capability?: string
    operation?: string
    provider?: string
  },
): ToolCallRecord {
  return {
    id: `${toolName}_${timestamp}_${success ? 'ok' : 'err'}`,
    toolName,
    args: {},
    result: success ? 'ok' : null,
    error: success ? null : 'boom',
    durationMs,
    timestamp,
    success,
    errorType: success ? null : ('execution' as any),
    capability: identity?.capability,
    operation: identity?.operation,
    provider: identity?.provider,
  }
}
