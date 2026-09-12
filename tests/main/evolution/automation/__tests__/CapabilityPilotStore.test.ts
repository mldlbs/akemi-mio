import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { CapabilityPilotStore } from '@akemi-mio/evolution/automation/CapabilityPilotStore'
import type { CapabilityPilotRunRecord } from '@akemi-mio/evolution/automation/CapabilityPilotDecisionGate'

describe('CapabilityPilotStore', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'm56-pilot-'))
  })

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('saves a run to runId dir and mirrors it to latest', () => {
    const store = new CapabilityPilotStore(tmpDir)
    const run = makeRun('pilot-abc')

    store.saveRun(run)

    expect(existsSync(join(tmpDir, 'pilot-abc', 'pilot_run.json'))).toBe(true)
    expect(existsSync(join(tmpDir, 'latest', 'pilot_run.json'))).toBe(true)
    expect(store.readLatest()).toMatchObject({
      runId: 'pilot-abc',
      decisionCount: 1,
      eligibleCount: 1,
    })
  })

  it('readLatest returns null when no run exists', () => {
    const store = new CapabilityPilotStore(tmpDir)
    expect(store.readLatest()).toBeNull()
  })

  it('rejects run ids that escape the store root', () => {
    const store = new CapabilityPilotStore(tmpDir)

    expect(() => store.saveRun(makeRun('../outside'))).toThrow(/outside rootDir/i)
  })
})

function makeRun(runId: string): CapabilityPilotRunRecord {
  return {
    runId,
    generatedAt: 1_722_345_600_000,
    decisionCount: 1,
    eligibleCount: 1,
    eligibilityRate: 1,
    decisions: [
      {
        capabilityKey: 'capability:file.management|operation:read|issue:error_rate|version:m56.v1',
        rank: 0,
        score: 20,
        affectedTools: ['read_file'],
        eligible: true,
      },
    ],
    shadowRunCount: 50,
    guardrails: {
      executorAuthorityUnchanged: true,
      problemQueueUnchanged: true,
      shadowGateActive: true,
    },
  }
}
