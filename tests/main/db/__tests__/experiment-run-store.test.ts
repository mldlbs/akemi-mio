import { afterEach, describe, expect, it } from 'vitest'

import { closeDatabase, initDatabase } from '@akemi-mio/core/db/connection'
import { DrizzleExperimentRunStore } from '@akemi-mio/creativity'
import { useIsolatedTestDatabase } from './testDatabase'

describe('DrizzleExperimentRunStore (正向反馈闭环 P2)', () => {
  afterEach(() => {
    closeDatabase()
  })

  it('persists runs with feedback attribution and reads them back by id / snapshot version', async () => {
    const restore = useIsolatedTestDatabase()
    try {
      await initDatabase()
      const store = new DrizzleExperimentRunStore()

      store.append({
        id: 'run-1',
        hypothesisId: 'h1',
        assignment: 'candidate',
        outcome: 'success',
        metrics: { sampleSize: 30 },
        evidenceIds: ['e1'],
        feedbackSnapshotVersion: 'snap_abc',
        baselineVersion: 'v1',
        candidateVersion: 'v2',
        testResults: { passed: true },
        decision: 'promote',
        createdAt: 1,
      })
      store.append({
        id: 'run-2',
        assignment: 'baseline',
        outcome: 'failure',
        metrics: {},
        evidenceIds: [],
        createdAt: 2,
      })

      expect(store.count()).toBe(2)
      const all = store.list()
      expect(all).toHaveLength(2)
      expect(all[0].feedbackSnapshotVersion).toBe('snap_abc')
      expect(all[0].testResults).toEqual({ passed: true })
      expect(all[0].decision).toBe('promote')

      const byIds = store.listByIds(['run-2', 'missing', 'run-1'])
      expect(byIds.map((r) => r.id)).toEqual(['run-2', 'run-1'])

      const bySnapshot = store.list({ feedbackSnapshotVersion: 'snap_abc' })
      expect(bySnapshot).toHaveLength(1)
      expect(bySnapshot[0].id).toBe('run-1')
    } finally {
      restore()
    }
  })
})
