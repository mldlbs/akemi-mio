/**
 * CheckpointManager contract tests.
 *
 * 验证 CheckpointManager 接口是否满足 ADR-010 定义的语义约束。
 * 不依赖具体存储实现（通过 MemoryCheckpointStorage 验证接口契约）。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { Checkpoint } from '../CheckpointTypes'
import type { CheckpointManager } from '../CheckpointManager'
import { MockCheckpointManager } from './MockCheckpointManager'

// ════════════════════════════════════════════════════
//  Test Fixtures
// ════════════════════════════════════════════════════

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

// ════════════════════════════════════════════════════
//  Contract Tests
// ════════════════════════════════════════════════════

describe('CheckpointManager — Contract Validation', () => {
  let mgr: MockCheckpointManager

  beforeEach(() => {
    mgr = new MockCheckpointManager()
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

  // ── Scene 2: save() + load() round-trip ──
  describe('Scene 2: save + load round-trip', () => {
    it('should persist and return the same checkpoint', async () => {
      const cp = validMinimalCheckpoint()
      await mgr.save(cp)
      const loaded = await mgr.load(cp.id)
      expect(loaded.id).toBe(cp.id)
      expect(loaded.taskId).toBe(cp.taskId)
      expect(loaded.executionState.workerId).toBe(cp.executionState.workerId)
    })

    it('should throw on loading nonexistent checkpoint', async () => {
      await expect(mgr.load('cp_nonexistent')).rejects.toThrow('checkpoint not found')
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

    it('should fail when executionState.workerId is missing', () => {
      const cp = validMinimalCheckpoint({
        executionState: {
          workerId: '',
          goal: 'g',
          step: 0,
          lastSafePoint: 'before_llm' as any,
          conversationContext: { type: 'inline', messages: [], tokenEstimate: 0 },
          pendingToolCalls: [],
        },
      })
      const r = mgr.validate(cp)
      expect(r.ok).toBe(false)
      expect(r.errors.some((e) => e.includes('executionState.workerId'))).toBe(true)
    })
  })

  // ── Scene 4: restore() ──
  describe('Scene 4: restore', () => {
    it('should return ok for a valid checkpoint with no components', async () => {
      const cp = validMinimalCheckpoint()
      await mgr.save(cp)
      const r = await mgr.restore(cp)
      expect(r.status).toBe('ok')
      expect(r.taskId).toBe(cp.taskId)
    })

    it('should return failed for an invalid checkpoint', async () => {
      const cp = validMinimalCheckpoint({ schemaVersion: '' })
      const r = await mgr.restore(cp)
      expect(r.status).toBe('failed')
      expect(r.errors.length).toBeGreaterThan(0)
    })

    it('should return degraded when optional component restore fails with capability flag', async () => {
      const cp = validMinimalCheckpoint()
      const optionalComponent = {
        name: 'tools',
        capabilities: { allowDegradedOnRestoreFail: true },
        snapshot: () => ({ component: 'tools', version: '1', data: {}, createdAt: 0 }),
        restore: async () => { throw new Error('simulated failure') },
      }
      const r = await mgr.restore(cp, [optionalComponent])
      expect(r.status).toBe('degraded')
      expect(r.degradedComponents).toContain('tools')
    })

    it('should return failed when component restore fails without capability flag', async () => {
      const cp = validMinimalCheckpoint()
      const strictComponent = {
        name: 'workflow',
        capabilities: {},
        snapshot: () => ({ component: 'workflow', version: '1', data: {}, createdAt: 0 }),
        restore: async () => { throw new Error('simulated failure') },
      }
      const r = await mgr.restore(cp, [strictComponent])
      expect(r.status).toBe('failed')
      expect(r.errors.some((e) => e.includes('workflow'))).toBe(true)
    })
  })

  // ── Scene 5: checkpointId ≠ taskId (identity separation) ──
  describe('Scene 5: identity separation', () => {
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
})
