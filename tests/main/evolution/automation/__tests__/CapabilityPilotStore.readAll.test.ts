import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { CapabilityPilotStore } from '@akemi-mio/evolution/automation/CapabilityPilotStore'
import type { CapabilityPilotRunRecord } from '@akemi-mio/evolution/automation/CapabilityPilotDecisionGate'

describe('CapabilityPilotStore.readAll', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'm56-pilot-readall-'))
  })

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('returns every persisted run newest first, excluding the latest mirror', () => {
    const store = new CapabilityPilotStore(tmpDir)
    store.saveRun(makeRun('pilot-old', 1_000))
    store.saveRun(makeRun('pilot-new', 2_000))

    const all = store.readAll()

    expect(all.map((run) => run.runId)).toEqual(['pilot-new', 'pilot-old'])
  })

  it('returns an empty array when nothing has been persisted', () => {
    const store = new CapabilityPilotStore(tmpDir)
    expect(store.readAll()).toEqual([])
  })
})

function makeRun(runId: string, generatedAt: number): CapabilityPilotRunRecord {
  return {
    runId,
    generatedAt,
    decisionCount: 1,
    eligibleCount: 1,
    eligibilityRate: 1,
    decisions: [],
    shadowRunCount: 1,
    guardrails: {
      executorAuthorityUnchanged: true,
      problemQueueUnchanged: true,
      shadowGateActive: true,
    },
  }
}
