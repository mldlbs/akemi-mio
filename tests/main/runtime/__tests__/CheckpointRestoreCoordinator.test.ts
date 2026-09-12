/**
 * CheckpointRestoreCoordinator — contract tests
 *
 * Freeze restore orchestration semantics before implementation.
 * Scope: pure component restore orchestration.
 * NOT responsible for: RuntimeTask creation, lifecycle, AgentService.
 *
 * Fail-fast strategy (phase 1): any component restore failure → abort.
 * Degraded opt-in deferred until phase 2.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Checkpoint, CheckpointableComponent, VersionedState, ComponentDescriptor, RestoreResult } from '@akemi-mio/intelligence/runtime/CheckpointTypes'
import { ComponentRegistryImpl } from '@akemi-mio/intelligence/runtime/ComponentRegistry'
import { CheckpointRestoreCoordinatorImpl } from '@akemi-mio/intelligence/runtime/CheckpointRestoreCoordinator'

// ════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════

/** Track call order for ordering verification */
const callLog: string[] = []

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: 'ck_test_1',
    taskId: 'task_test_1',
    schemaVersion: '1.0',
    runtimeCompatibility: { min: '1.0', max: '1.0' },
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

function makeVersionedState(component: string, data: unknown = {}): VersionedState {
  return { component, version: '1.0', data, createdAt: Date.now() }
}

/**
 * Restore call order tracker.
 * Returns a dummy restore Promise that resolves microtask-delayed,
 * and pushes a marker so tests can assert ordering.
 */
function trackedComponent(id: string, marker: string): { comp: CheckpointableComponent; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn<[VersionedState], Promise<void>>().mockImplementation(async () => {
    callLog.push(marker)
  })
  return {
    comp: {
      id,
      snapshot: vi.fn(),
      restore: spy,
    },
    spy,
  }
}

// ════════════════════════════════════════════════════
//  Scene 1: success path — resolve → create → restore → ok
// ════════════════════════════════════════════════════

describe('CheckpointRestoreCoordinator — Scene 1: success', () => {
  beforeEach(() => {
    callLog.length = 0
  })

  it('should restore all components and return ok', async () => {
    const registry = new ComponentRegistryImpl()
    const wfState = makeVersionedState('workflow-runtime', { activeRuns: ['r1'] })

    registry.register({
      id: 'workflow-runtime',
      version: '1.0',
      create() {
        const { comp } = trackedComponent('workflow-runtime', 'wf_restore')
        return comp
      },
    })

    const checkpoint = makeCheckpoint({
      componentStates: { 'workflow-runtime': wfState },
    })

    const coordinator = new CheckpointRestoreCoordinatorImpl(registry)
    const result = await coordinator.restore(checkpoint)

    expect(result.status).toBe('ok')
    expect(result.errors).toHaveLength(0)
  })

  it('should return ok with empty componentStates (no-op)', async () => {
    const registry = new ComponentRegistryImpl()
    const checkpoint = makeCheckpoint({ componentStates: undefined })
    const coordinator = new CheckpointRestoreCoordinatorImpl(registry)

    const result = await coordinator.restore(checkpoint)

    expect(result.status).toBe('ok')
    expect(result.taskId).toBe('task_test_1')
  })

  it('should return ok with empty componentStates record', async () => {
    const registry = new ComponentRegistryImpl()
    const checkpoint = makeCheckpoint({ componentStates: {} })
    const coordinator = new CheckpointRestoreCoordinatorImpl(registry)

    const result = await coordinator.restore(checkpoint)

    expect(result.status).toBe('ok')
    expect(result.errors).toHaveLength(0)
  })
})

// ════════════════════════════════════════════════════
//  Scene 2: missing descriptor → fail-fast
// ════════════════════════════════════════════════════

describe('CheckpointRestoreCoordinator — Scene 2: missing descriptor', () => {
  it('should return failed when component descriptor is not found', async () => {
    const registry = new ComponentRegistryImpl()
    registry.register({
      id: 'workflow-runtime',
      version: '1.0',
      create: () => ({ id: 'workflow-runtime', snapshot: vi.fn(), restore: vi.fn() }),
    })

    const checkpoint = makeCheckpoint({
      componentStates: {
        'workflow-runtime': makeVersionedState('workflow-runtime'),
        'unknown-component': makeVersionedState('unknown-component'),
      },
    })

    const coordinator = new CheckpointRestoreCoordinatorImpl(registry)
    const result = await coordinator.restore(checkpoint)

    expect(result.status).toBe('failed')
    expect(result.errors.some((e) => e.includes('unknown-component'))).toBe(true)
  })
})

// ════════════════════════════════════════════════════
//  Scene 3: component restore throws → fail-fast, side effects isolated
// ════════════════════════════════════════════════════

describe('CheckpointRestoreCoordinator — Scene 3: component restore failure', () => {
  it('should return failed when a required component restore throws', async () => {
    const registry = new ComponentRegistryImpl()
    const goodSpy = vi.fn<[VersionedState], Promise<void>>().mockResolvedValue(undefined)

    registry.register({
      id: 'good',
      version: '1.0',
      create: () => ({ id: 'good', snapshot: vi.fn(), restore: goodSpy }),
    })
    registry.register({
      id: 'bad',
      version: '1.0',
      create: () => ({
        id: 'bad',
        snapshot: vi.fn(),
        restore: vi.fn().mockRejectedValue(new Error('restore crashed')),
      }),
    })

    const checkpoint = makeCheckpoint({
      componentStates: {
        good: makeVersionedState('good'),
        bad: makeVersionedState('bad'),
      },
    })

    const coordinator = new CheckpointRestoreCoordinatorImpl(registry)
    const result = await coordinator.restore(checkpoint)

    expect(result.status).toBe('failed')
    expect(result.degradedComponents).toHaveLength(0)
  })

  it('should not call restore on remaining components after a failure (fail-fast)', async () => {
    const registry = new ComponentRegistryImpl()
    const goodSpy = vi.fn<[VersionedState], Promise<void>>().mockResolvedValue(undefined)
    // This descriptor's create() runs during iteration — we need to control order.
    // Use a registry with ordering: bad registered before other.

    registry.register({
      id: 'first',
      version: '1.0',
      create: () => ({
        id: 'first',
        snapshot: vi.fn(),
        restore: vi.fn().mockRejectedValue(new Error('first failed')),
      }),
    })
    const neverCalled = vi.fn<[VersionedState], Promise<void>>()
    registry.register({
      id: 'second',
      version: '1.0',
      create: () => ({ id: 'second', snapshot: vi.fn(), restore: neverCalled }),
    })

    const checkpoint = makeCheckpoint({
      componentStates: {
        first: makeVersionedState('first'),
        second: makeVersionedState('second'),
      },
    })

    const coordinator = new CheckpointRestoreCoordinatorImpl(registry)
    await coordinator.restore(checkpoint)

    // second's restore must NOT be called
    expect(neverCalled).not.toHaveBeenCalled()
  })
})

// ════════════════════════════════════════════════════
//  Scene 4: component create() throws → treat as restore failure
// ════════════════════════════════════════════════════

describe('CheckpointRestoreCoordinator — Scene 4: create failure', () => {
  it('should return failed when descriptor.create() throws', async () => {
    const registry = new ComponentRegistryImpl()
    registry.register({
      id: 'workflow-runtime',
      version: '1.0',
      create: () => {
        throw new Error('factory error')
      },
    })

    const checkpoint = makeCheckpoint({
      componentStates: { 'workflow-runtime': makeVersionedState('workflow-runtime') },
    })

    const coordinator = new CheckpointRestoreCoordinatorImpl(registry)
    const result = await coordinator.restore(checkpoint)

    expect(result.status).toBe('failed')
    expect(result.errors.some((e) => e.includes('factory error'))).toBe(true)
  })
})

// ════════════════════════════════════════════════════
//  Scene 5: restore result structure
// ════════════════════════════════════════════════════

describe('CheckpointRestoreCoordinator — Scene 5: result structure', () => {
  it('should return taskId from checkpoint', async () => {
    const registry = new ComponentRegistryImpl()
    const checkpoint = makeCheckpoint({ taskId: 'my_task_42', componentStates: {} })

    const coordinator = new CheckpointRestoreCoordinatorImpl(registry)
    const result = await coordinator.restore(checkpoint)

    expect(result.taskId).toBe('my_task_42')
  })

  it('should collect all errors from a failed restore', async () => {
    const registry = new ComponentRegistryImpl()
    registry.register({
      id: 'a',
      version: '1.0',
      create: () => ({ id: 'a', snapshot: vi.fn(), restore: vi.fn().mockRejectedValue(new Error('err_a')) }),
    })

    const checkpoint = makeCheckpoint({
      componentStates: { a: makeVersionedState('a') },
    })

    const coordinator = new CheckpointRestoreCoordinatorImpl(registry)
    const result = await coordinator.restore(checkpoint)

    expect(result.status).toBe('failed')
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.degradedComponents).toEqual([])
  })

  it('should track restored component instances via getRestoredComponents', async () => {
    const registry = new ComponentRegistryImpl()
    registry.register({
      id: 'a',
      version: '1.0',
      create: () => ({
        id: 'a',
        snapshot: vi.fn(),
        restore: vi.fn().mockResolvedValue(undefined),
      }),
    })
    registry.register({
      id: 'b',
      version: '1.0',
      create: () => ({
        id: 'b',
        snapshot: vi.fn(),
        restore: vi.fn().mockResolvedValue(undefined),
      }),
    })

    const checkpoint = makeCheckpoint({
      componentStates: {
        a: makeVersionedState('a'),
        b: makeVersionedState('b'),
      },
    })

    const coordinator = new CheckpointRestoreCoordinatorImpl(registry)
    const result = await coordinator.restore(checkpoint)

    expect(result.status).toBe('ok')

    const all = coordinator.getRestoredComponents()
    expect(all).toHaveLength(2)
    expect(all[0].id).toBe('a')
    expect(all[1].id).toBe('b')
  })

  it('should return empty list when restore fails', async () => {
    const registry = new ComponentRegistryImpl()
    registry.register({
      id: 'bad',
      version: '1.0',
      create: () => ({
        id: 'bad',
        snapshot: vi.fn(),
        restore: vi.fn().mockRejectedValue(new Error('fail')),
      }),
    })

    const checkpoint = makeCheckpoint({
      componentStates: { bad: makeVersionedState('bad') },
    })

    const coordinator = new CheckpointRestoreCoordinatorImpl(registry)
    await coordinator.restore(checkpoint)

    expect(coordinator.getRestoredComponents()).toHaveLength(0)
  })

  it('should return empty array when no components restored', async () => {
    const registry = new ComponentRegistryImpl()
    const checkpoint = makeCheckpoint({ componentStates: {} })

    const coordinator = new CheckpointRestoreCoordinatorImpl(registry)
    await coordinator.restore(checkpoint)

    expect(coordinator.getRestoredComponents()).toEqual([])
  })
})
