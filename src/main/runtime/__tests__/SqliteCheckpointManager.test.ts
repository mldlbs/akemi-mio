/**
 * SqliteCheckpointManager — contract tests.
 *
 * Reuses the same contract scenarios as MockCheckpointManager tests,
 * but backed by a real SQLite database.
 *
 * Scene 1: create() — produces valid checkpoints
 * Scene 2: save + load round-trip — persists and loads correctly
 * Scene 3: validate() — enforces schema constraints
 * Scene 4: identity separation — checkpointId ≠ taskId
 * Scene 5: persistence across instances — survives re-created manager
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { initDatabase, closeDatabase } from '../../db/connection'
import type { Checkpoint } from './CheckpointTypes'
import { SqliteCheckpointManager } from '../SqliteCheckpointManager'

vi.mock('../logger/Logger', () => ({ log: vi.fn() }))

let dbPath: string

function validMinimalCheckpoint(overrides?: Partial<Checkpoint>): Checkpoint {
  return {
    id: 'cp_test_1',
    taskId: 'task_1',
    schemaVersion: '1.0',
    runtimeCompatibility: { min: '2.0', max: '2.x' },
    taskState: { name: 'test-task', createdAt: Date.now() },
    executionState: {
      workerId: 'w1',
      goal: 'test goal',
      step: 3,
      lastSafePoint: 'after_tool' as any,
      conversationContext: { type: 'inline', messages: [], tokenEstimate: 0 },
      pendingToolCalls: [],
    },
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('SqliteCheckpointManager — Contract', () => {
  let mgr: SqliteCheckpointManager

  beforeEach(async () => {
    dbPath = join(process.cwd(), 'akemi-mio.db')
    if (existsSync(dbPath)) unlinkSync(dbPath)
    process.env.USER_DATA_DIR = process.cwd()
    await initDatabase()
    mgr = new SqliteCheckpointManager()
  })

  afterEach(() => {
    closeDatabase()
    if (existsSync(dbPath)) unlinkSync(dbPath)
  })

  // ── Scene 1: create() ──
  describe('Scene 1: create', () => {
    it('should produce a valid checkpoint from context', async () => {
      const cp = await mgr.create({
        taskId: 'task_1',
        taskName: 'test',
        taskCreatedAt: Date.now(),
        executionState: { workerId: 'w1', goal: 'g1', step: 0, lastSafePoint: 'before_llm' },
      })
      expect(cp.id).toBeTruthy()
      expect(cp.taskId).toBe('task_1')
      expect(cp.schemaVersion).toBe('1.0')
      expect(cp.runtimeCompatibility.min).toBe('2.0')
    })

    it('should include execution state from context', async () => {
      const cp = await mgr.create({
        taskId: 'task_2',
        taskName: 'resume-test',
        taskCreatedAt: Date.now(),
        executionState: { workerId: 'w_42', goal: 'resume goal', step: 7, lastSafePoint: 'after_tool' },
      })
      expect(cp.executionState.workerId).toBe('w_42')
      expect(cp.executionState.step).toBe(7)
      expect(cp.executionState.goal).toBe('resume goal')
    })
  })

  // ── Scene 2: save + load round-trip ──
  describe('Scene 2: save + load round-trip', () => {
    it('should persist and return the same checkpoint', async () => {
      const cp = validMinimalCheckpoint()
      await mgr.save(cp)
      const loaded = await mgr.load(cp.id)
      expect(loaded.id).toBe(cp.id)
      expect(loaded.taskId).toBe(cp.taskId)
      expect(loaded.executionState.workerId).toBe(cp.executionState.workerId)
      expect(loaded.schemaVersion).toBe('1.0')
    })

    it('should throw on loading nonexistent checkpoint', async () => {
      await expect(mgr.load('cp_nonexistent')).rejects.toThrow('checkpoint not found')
    })

    it('should update existing checkpoint on save with same id', async () => {
      const cp = validMinimalCheckpoint({ executionState: { workerId: 'w1', goal: 'g1', step: 3, lastSafePoint: 'after_tool' as any, conversationContext: { type: 'inline', messages: [], tokenEstimate: 0 }, pendingToolCalls: [] } })
      await mgr.save(cp)

      const updated = { ...cp, executionState: { ...cp.executionState, step: 10 } }
      await mgr.save(updated)

      const loaded = await mgr.load(cp.id)
      expect(loaded.executionState.step).toBe(10)
    })
  })

  // ── Scene 3: validate() ──
  describe('Scene 3: validate', () => {
    it('should pass for a valid checkpoint', () => {
      const cp = validMinimalCheckpoint()
      const r = mgr.validate(cp)
      expect(r.ok).toBe(true)
      expect(r.errors).toHaveLength(0)
    })

    it('should fail when schemaVersion is missing', () => {
      const cp = validMinimalCheckpoint({ schemaVersion: '' })
      const r = mgr.validate(cp)
      expect(r.ok).toBe(false)
      expect(r.errors.some((e) => e.includes('schemaVersion'))).toBe(true)
    })

    it('should fail when taskState.name is missing', () => {
      const cp = validMinimalCheckpoint({ taskState: { name: '', createdAt: 0 } })
      const r = mgr.validate(cp)
      expect(r.ok).toBe(false)
      expect(r.errors.some((e) => e.includes('taskState.name'))).toBe(true)
    })
  })

  // ── Scene 4: identity separation ──
  describe('Scene 4: identity separation', () => {
    it('should have distinct checkpointId from taskId', async () => {
      const cp = await mgr.create({
        taskId: 'task_sep_1',
        taskName: 'sep-test',
        taskCreatedAt: Date.now(),
        executionState: { workerId: 'w1', goal: 'g1', step: 0, lastSafePoint: 'before_llm' },
      })
      expect(cp.id).not.toBe(cp.taskId)
    })

    it('should allow multiple checkpoints for one task', async () => {
      const taskId = 'task_multi_1'
      const cp1 = await mgr.create({ taskId, taskName: 'm1', taskCreatedAt: Date.now(), executionState: { workerId: 'w1', goal: 'g', step: 1, lastSafePoint: 'before_llm' } })
      const cp2 = await mgr.create({ taskId, taskName: 'm1', taskCreatedAt: Date.now(), executionState: { workerId: 'w1', goal: 'g', step: 5, lastSafePoint: 'after_tool' } })
      await mgr.save(cp1)
      await mgr.save(cp2)
      const loaded1 = await mgr.load(cp1.id)
      const loaded2 = await mgr.load(cp2.id)
      expect(loaded1.executionState.step).toBe(1)
      expect(loaded2.executionState.step).toBe(5)
    })
  })

  // ── Scene 5: persistence across instances ──
  describe('Scene 5: persistence across instances', () => {
    it('should survive re-creating the manager (same DB)', async () => {
      const cp = validMinimalCheckpoint({ id: 'cp_survive', taskId: 't_survive' })
      await mgr.save(cp)

      // "re-create" the manager (same DB file, new instance)
      const mgr2 = new SqliteCheckpointManager()
      const loaded = await mgr2.load(cp.id)
      expect(loaded.id).toBe('cp_survive')
      expect(loaded.taskId).toBe('t_survive')
    })

    it('should persist JSON blob fields including componentStates', async () => {
      const cp = validMinimalCheckpoint({
        componentStates: {
          'workflow-runtime': {
            component: 'workflow-runtime',
            version: '1.0',
            data: { activeRuns: [{ runId: 'r1', status: 'running' }, { runId: 'r2', status: 'paused' }] },
            createdAt: Date.now(),
          },
        },
      })
      await mgr.save(cp)
      const loaded = await mgr.load(cp.id)
      expect(loaded.componentStates!['workflow-runtime'].data).toBeDefined()
      const wf = loaded.componentStates!['workflow-runtime']
      expect((wf.data as any).activeRuns).toHaveLength(2)
    })
  })

  // ── Scene 6: clear ──
  describe('Scene 6: clear', () => {
    it('should remove all checkpoints', async () => {
      const cp = validMinimalCheckpoint()
      await mgr.save(cp)
      expect(await mgr.load(cp.id)).toBeDefined()

      mgr.clear()
      await expect(mgr.load(cp.id)).rejects.toThrow('checkpoint not found')
    })
  })
})
