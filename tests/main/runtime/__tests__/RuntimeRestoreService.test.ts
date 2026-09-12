/**
 * RuntimeRestoreService — contract tests.
 *
 * Scopes:
 * 1. Success path: load → validate → plan → coordinator → ok + restorePlan
 * 2. Load failure: checkpointManager.load() throws → failed
 * 3. Validation failure: invalid checkpoint → failed
 * 4. Component restore failure: coordinator fails → failed
 * 5. Concurrent restore guard: same checkpointId rejected
 * 6. RestorePlan generation: included on success, absent on failure
 * 7. RestorePlan content: resume strategy reflects checkpoint execution state
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Checkpoint, CheckpointId, ValidationResult } from '@akemi-mio/intelligence/runtime/CheckpointTypes'
import type { CheckpointManager } from '@akemi-mio/intelligence/runtime/CheckpointManager'
import type { ComponentRegistry } from '@akemi-mio/intelligence/runtime/ComponentRegistry'
import { RuntimeRestoreServiceImpl, type RuntimeRestoreResult } from '@akemi-mio/intelligence/runtime/RuntimeRestoreService'
import { ComponentRegistryImpl } from '@akemi-mio/intelligence/runtime/ComponentRegistry'

// ════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════

function makeValidCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: 'ck_test_1',
    taskId: 'task_test_1',
    schemaVersion: '1.0',
    runtimeCompatibility: { min: '2.0', max: '2.x' },
    taskState: { name: 'test-task', createdAt: Date.now() },
    executionState: {
      workerId: 'w1',
      goal: 'test',
      step: 0,
      lastSafePoint: 'before_llm' as any,
      conversationContext: { type: 'inline', messages: [], tokenEstimate: 0 },
      pendingToolCalls: [],
    },
    createdAt: Date.now(),
    ...overrides,
  }
}

interface MockMgr extends CheckpointManager {
  store: Map<CheckpointId, Checkpoint>
  clear(): void
}

function createMockCheckpointManager(): MockMgr {
  const store = new Map<CheckpointId, Checkpoint>()
  return {
    store,
    async create(ctx: any): Promise<Checkpoint> {
      const id = `cp_mock_${store.size + 1}`
      return {
        id,
        taskId: ctx.taskId,
        schemaVersion: '1.0',
        runtimeCompatibility: { min: '2.0', max: '2.x' },
        taskState: { name: ctx.taskName, metadata: ctx.taskMetadata, createdAt: ctx.taskCreatedAt },
        executionState: {
          workerId: ctx.executionState?.workerId ?? '',
          goal: ctx.executionState?.goal ?? '',
          step: ctx.executionState?.step ?? 0,
          lastSafePoint: ctx.executionState?.lastSafePoint ?? 'before_llm',
          conversationContext: { type: 'inline', messages: [], tokenEstimate: 0 },
          pendingToolCalls: [],
        },
        createdAt: Date.now(),
      } as Checkpoint
    },
    async save(cp: Checkpoint): Promise<void> {
      store.set(cp.id, structuredClone(cp))
    },
    async load(id: CheckpointId): Promise<Checkpoint> {
      const cp = store.get(id)
      if (!cp) throw new Error(`checkpoint not found: ${id}`)
      return structuredClone(cp)
    },
    validate(cp: Checkpoint): ValidationResult {
      const errors: string[] = []
      if (!cp.schemaVersion) errors.push('schemaVersion is required')
      if (!cp.taskState?.name) errors.push('taskState.name is required')
      return { ok: errors.length === 0, errors, warnings: [] }
    },
    clear() {
      store.clear()
    },
  }
}

// ════════════════════════════════════════════════════
//  Scene 1: success path
// ════════════════════════════════════════════════════

describe('RuntimeRestoreService — Scene 1: success', () => {
  let cpMgr: MockMgr
  let registry: ComponentRegistry

  beforeEach(() => {
    cpMgr = createMockCheckpointManager()
    registry = new ComponentRegistryImpl()
  })

  it('should load, validate, restore components, and return ok with restorePlan', async () => {
    const checkpoint = makeValidCheckpoint({ componentStates: {} })
    await cpMgr.save(checkpoint)

    registry.register({
      id: 'wf',
      version: '1.0',
      create: () => ({ id: 'wf', snapshot: vi.fn(), restore: vi.fn() }),
    })

    const service = new RuntimeRestoreServiceImpl(cpMgr, registry)
    const result = await service.restore(checkpoint.id)

    expect(result.status).toBe('ok')
    expect(result.taskId).toBe('task_test_1')
    expect(result.errors).toHaveLength(0)
    expect(result.restorePlan).toBeDefined()
  })

  it('should attach restorePlan on success', async () => {
    const checkpoint = makeValidCheckpoint({ componentStates: {} })
    await cpMgr.save(checkpoint)

    const service = new RuntimeRestoreServiceImpl(cpMgr, registry)
    const result = await service.restore(checkpoint.id)

    expect(result.restorePlan).toBeDefined()
    expect(result.restorePlan!.taskState.name).toBe('test-task')
  })

  it('should return ok with empty registry (no componentStates)', async () => {
    const checkpoint = makeValidCheckpoint()
    await cpMgr.save(checkpoint)

    const service = new RuntimeRestoreServiceImpl(cpMgr, registry)
    const result = await service.restore(checkpoint.id)

    expect(result.status).toBe('ok')
    expect(result.errors).toHaveLength(0)
    expect(result.restorePlan).toBeDefined()
  })
})

// ════════════════════════════════════════════════════
//  Scene 2: load failure
// ════════════════════════════════════════════════════

describe('RuntimeRestoreService — Scene 2: load failure', () => {
  it('should return failed when checkpoint not found', async () => {
    const service = new RuntimeRestoreServiceImpl(createMockCheckpointManager(), new ComponentRegistryImpl())
    const result = await service.restore('nonexistent')

    expect(result.status).toBe('failed')
    expect(result.errors.some((e) => e.includes('not found'))).toBe(true)
    expect(result.restorePlan).toBeUndefined()
  })
})

// ════════════════════════════════════════════════════
//  Scene 3: validation failure
// ════════════════════════════════════════════════════

describe('RuntimeRestoreService — Scene 3: validation failure', () => {
  it('should return failed when checkpoint is invalid', async () => {
    const cpMgr = createMockCheckpointManager()
    const badCp = makeValidCheckpoint({ schemaVersion: '' })
    await cpMgr.save(badCp)

    const service = new RuntimeRestoreServiceImpl(cpMgr, new ComponentRegistryImpl())
    const result = await service.restore(badCp.id)

    expect(result.status).toBe('failed')
    expect(result.errors.some((e) => e.includes('schemaVersion'))).toBe(true)
    expect(result.restorePlan).toBeUndefined()
  })
})

// ════════════════════════════════════════════════════
//  Scene 4: component restore failure
// ════════════════════════════════════════════════════

describe('RuntimeRestoreService — Scene 4: component failure', () => {
  it('should return failed when coordinator restore fails', async () => {
    const cpMgr = createMockCheckpointManager()
    const registry = new ComponentRegistryImpl()
    registry.register({
      id: 'bad',
      version: '1.0',
      create: () => ({ id: 'bad', snapshot: vi.fn(), restore: vi.fn().mockRejectedValue(new Error('boom')) }),
    })

    const cp = makeValidCheckpoint({
      componentStates: { bad: { component: 'bad', version: '1.0', data: {}, createdAt: Date.now() } },
    })
    await cpMgr.save(cp)

    const service = new RuntimeRestoreServiceImpl(cpMgr, registry)
    const result = await service.restore(cp.id)

    expect(result.status).toBe('failed')
    expect(result.errors.some((e) => e.includes('bad'))).toBe(true)
    // restorePlan only present on ok/degraded
    expect(result.restorePlan).toBeUndefined()
  })
})

// ════════════════════════════════════════════════════
//  Scene 5: concurrent restore guard
// ════════════════════════════════════════════════════

describe('RuntimeRestoreService — Scene 5: concurrent guard', () => {
  it('should reject concurrent restore of same checkpointId', async () => {
    const cpMgr = createMockCheckpointManager()
    const cp = makeValidCheckpoint()
    await cpMgr.save(cp)

    let release: () => void = () => {}
    const stall = new Promise<void>((r) => {
      release = r
    })

    const registry = new ComponentRegistryImpl()
    registry.register({
      id: 'slow',
      version: '1.0',
      create: () => ({
        id: 'slow',
        snapshot: vi.fn(),
        restore: vi.fn().mockImplementation(() => stall),
      }),
    })
    const cpWithState = { ...cp, componentStates: { slow: { component: 'slow', version: '1.0', data: {}, createdAt: 0 } } } as Checkpoint
    await cpMgr.save(cpWithState)

    const service = new RuntimeRestoreServiceImpl(cpMgr, registry)

    const p1 = service.restore(cp.id)
    const p2 = await service.restore(cp.id)

    release()
    await p1

    expect(p2.status).toBe('failed')
    expect(p2.errors.some((e) => e.includes('in-flight'))).toBe(true)
  })
})

// ════════════════════════════════════════════════════
//  Scene 6: restorePlan resume strategy accuracy
// ════════════════════════════════════════════════════

describe('RuntimeRestoreService — Scene 6: restorePlan strategy', () => {
  it('should restore with continue strategy for simple checkpoints', async () => {
    const cpMgr = createMockCheckpointManager()
    const cp = makeValidCheckpoint({ taskId: 'continue-task' })
    await cpMgr.save(cp)

    const service = new RuntimeRestoreServiceImpl(cpMgr, new ComponentRegistryImpl())
    const result = await service.restore(cp.id)

    expect(result.status).toBe('ok')
    expect(result.restorePlan!.resumeStrategy).toBe('continue')
    expect(result.restorePlan!.taskState.name).toBe('test-task')
  })

  it('should restore with wait_supervisor strategy when checkpoint has pending decision', async () => {
    const cpMgr = createMockCheckpointManager()
    const cp = makeValidCheckpoint({
      executionState: {
        workerId: 'w1',
        goal: 'g1',
        step: 5,
        lastSafePoint: 'after_llm' as any,
        conversationContext: { type: 'inline', messages: [], tokenEstimate: 10 },
        pendingToolCalls: [],
        pendingDecision: { query: 'Approve?', summary: 'waiting' },
      },
    })
    await cpMgr.save(cp)

    const service = new RuntimeRestoreServiceImpl(cpMgr, new ComponentRegistryImpl())
    const result = await service.restore(cp.id)

    expect(result.status).toBe('ok')
    expect(result.restorePlan!.resumeStrategy).toBe('wait_supervisor')
  })
})

// ════════════════════════════════════════════════════
//  Scene 7: result structure
// ════════════════════════════════════════════════════

describe('RuntimeRestoreService — Scene 7: result structure', () => {
  it('should return own checkpoint taskId, not a generated one', async () => {
    const cpMgr = createMockCheckpointManager()
    const cp = makeValidCheckpoint({ taskId: 'orig-task-42', componentStates: {} })
    await cpMgr.save(cp)

    const service = new RuntimeRestoreServiceImpl(cpMgr, new ComponentRegistryImpl())
    const result = await service.restore(cp.id)

    expect(result.taskId).toBe('orig-task-42')
  })

  it('should return empty degradedComponents on success', async () => {
    const cpMgr = createMockCheckpointManager()
    const cp = makeValidCheckpoint({ componentStates: {} })
    await cpMgr.save(cp)

    const service = new RuntimeRestoreServiceImpl(cpMgr, new ComponentRegistryImpl())
    const result = await service.restore(cp.id)

    expect(result.status).toBe('ok')
    expect(result.degradedComponents).toEqual([])
  })
})

// ════════════════════════════════════════════════════
//  Scene 8: activation phase
// ════════════════════════════════════════════════════

describe('RuntimeRestoreService — Scene 8: activation phase', () => {
  it('should call activator on successful restore', async () => {
    const cpMgr = createMockCheckpointManager()
    const registry = new ComponentRegistryImpl()
    const activator = vi.fn().mockResolvedValue(undefined)

    registry.register({
      id: 'workflow-runtime',
      version: '1.0',
      create: () => ({
        id: 'workflow-runtime',
        snapshot: vi.fn(),
        restore: vi.fn().mockResolvedValue(undefined),
        getRecoveryPlans: () => [{ runId: 'r1', action: 'resume' }],
      }),
    })

    const cp = makeValidCheckpoint({
      componentStates: {
        'workflow-runtime': {
          component: 'workflow-runtime',
          version: '1.0',
          data: { activeRuns: [{ runId: 'r1', status: 'running' }] },
          createdAt: 0,
        },
      },
    })
    await cpMgr.save(cp)

    const service = new RuntimeRestoreServiceImpl(cpMgr, registry)
    service.setActivator({ activate: activator })
    const result = await service.restore(cp.id)

    expect(result.status).toBe('ok')
    expect(activator).toHaveBeenCalledTimes(1)
    expect(activator.mock.calls[0][0]).toEqual([{ runId: 'r1', action: 'resume' }])
  })

  it('should return degraded when activator throws', async () => {
    const cpMgr = createMockCheckpointManager()
    const registry = new ComponentRegistryImpl()
    const activator = vi.fn().mockRejectedValue(new Error('activation boom'))

    registry.register({
      id: 'wf',
      version: '1.0',
      create: () => ({
        id: 'wf',
        snapshot: vi.fn(),
        restore: vi.fn().mockResolvedValue(undefined),
        getRecoveryPlans: () => [],
      }),
    })

    const cp = makeValidCheckpoint({ componentStates: { wf: { component: 'wf', version: '1.0', data: {}, createdAt: 0 } } })
    await cpMgr.save(cp)

    const service = new RuntimeRestoreServiceImpl(cpMgr, registry)
    service.setActivator({ activate: activator })
    const result = await service.restore(cp.id)

    expect(result.status).toBe('degraded')
    expect(result.restorePlan).toBeDefined()
    expect(result.errors.some((e) => e.includes('activation boom'))).toBe(true)
  })

  it('should not call activator on failed restore', async () => {
    const cpMgr = createMockCheckpointManager()
    const activator = vi.fn()

    const service = new RuntimeRestoreServiceImpl(cpMgr, new ComponentRegistryImpl())
    service.setActivator({ activate: activator })
    const result = await service.restore('nonexistent')

    expect(result.status).toBe('failed')
    expect(activator).not.toHaveBeenCalled()
  })

  it('should not fail when no activator set', async () => {
    const cpMgr = createMockCheckpointManager()
    const cp = makeValidCheckpoint()
    await cpMgr.save(cp)

    const service = new RuntimeRestoreServiceImpl(cpMgr, new ComponentRegistryImpl())
    const result = await service.restore(cp.id)

    expect(result.status).toBe('ok')
  })
})
