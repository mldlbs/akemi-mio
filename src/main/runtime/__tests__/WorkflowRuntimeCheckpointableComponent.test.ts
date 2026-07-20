/**
 * WorkflowRuntimeCheckpointableComponent — tests
 *
 * 覆盖场景：
 *   Scene 1: snapshot 当前活跃 workflow
 *   Scene 2: restore 后生成 recovery plans
 *   Scene 3: 已完成 workflow 生成 skip plan
 *   Scene 4: WAITING_GATE workflow 生成 register-only plan
 *   Scene 5: 单 run 失败不污染整体
 *   Scene 6: getRecoveryPlans 返回 plan list
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorkflowRuntimeCheckpointableComponent } from '../WorkflowRuntimeCheckpointableComponent'
import type { VersionedState, WorkflowRecoveryPlan } from '../CheckpointTypes'
import type { WorkflowSchedulerV2 } from '../../workflow/WorkflowScheduler'

// ════════════════════════════════════════════════════
//  Mocks
// ════════════════════════════════════════════════════

function createMockRun(overrides: Partial<any> = {}) {
  return {
    runId: 'run_test_1',
    workflowDefId: 'wf_def_1',
    workflowName: 'test-workflow',
    status: 'running',
    steps: [
      { stepId: 's1', status: 'done' },
      { stepId: 's2', status: 'running' },
      { stepId: 's3', status: 'pending' },
    ],
    startedAt: Date.now() - 10000,
    pendingGate: undefined,
    userInput: 'test input',
    ...overrides,
  }
}

function createMockStore(runs: any[] = []) {
  const runMap = new Map(runs.map((r) => [r.runId, r]))
  const defMap = new Map<string, any>()

  for (const r of runs) {
    if (!defMap.has(r.workflowDefId)) {
      defMap.set(r.workflowDefId, {
        id: r.workflowDefId,
        name: 'test-def',
        description: '',
        steps: r.steps.map((s: any) => ({
          id: s.stepId ?? `s_${Date.now()}_${Math.random()}`,
          name: s.stepId,
          description: '',
          handler: 'tool',
          config: {},
          dependsOn: [],
        })),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        enabled: true,
      })
    }
  }

  return {
    getRun: vi.fn((id: string) => runMap.get(id) ?? null),
    getDefinition: vi.fn((id: string) => defMap.get(id) ?? null),
  }
}

function createMockScheduler(runIds: string[] = []) {
  return {
    getActiveRunIds: vi.fn(() => runIds),
  } as unknown as WorkflowSchedulerV2
}

function makeVersionedState(data: any, version = '1.0'): VersionedState {
  return { component: 'workflow-runtime', version, data, createdAt: Date.now() }
}

// ════════════════════════════════════════════════════
//  Scene 1: snapshot
// ════════════════════════════════════════════════════

describe('WorkflowRuntimeCheckpointableComponent — Scene 1: snapshot', () => {
  it('should capture active run IDs from scheduler', async () => {
    const scheduler = createMockScheduler(['run_1', 'run_2'])
    const store = createMockStore([
      createMockRun({ runId: 'run_1', status: 'running' }),
      createMockRun({ runId: 'run_2', status: 'paused' }),
    ])
    const comp = new WorkflowRuntimeCheckpointableComponent(scheduler, store as any)

    const state = await comp.snapshot()

    expect(scheduler.getActiveRunIds).toHaveBeenCalled()
    expect(state.component).toBe('workflow-runtime')
    expect(state.version).toBe('1.0')
    expect((state.data as any).activeRuns).toHaveLength(2)
    expect((state.data as any).activeRuns[0]).toEqual({ runId: 'run_1', status: 'running' })
    expect((state.data as any).activeRuns[1]).toEqual({ runId: 'run_2', status: 'paused' })
  })

  it('should skip runs that exist in scheduler but not in store', async () => {
    const scheduler = createMockScheduler(['run_orphan'])
    const store = createMockStore([])
    const comp = new WorkflowRuntimeCheckpointableComponent(scheduler, store as any)

    const state = await comp.snapshot()

    expect((state.data as any).activeRuns).toHaveLength(0)
  })

  it('should produce valid snapshot when no active runs', async () => {
    const scheduler = createMockScheduler([])
    const store = createMockStore([])
    const comp = new WorkflowRuntimeCheckpointableComponent(scheduler, store as any)

    const state = await comp.snapshot()

    expect(state.component).toBe('workflow-runtime')
    expect((state.data as any).activeRuns).toEqual([])
  })
})

// ════════════════════════════════════════════════════
//  Scene 2: restore generates plans (no side effects)
// ════════════════════════════════════════════════════

describe('WorkflowRuntimeCheckpointableComponent — Scene 2: restore generates plans', () => {
  it('should generate register-only plan for paused workflow', async () => {
    const run = createMockRun({
      runId: 'run_paused',
      status: 'paused',
      pendingGate: { stepId: 's2', message: 'Approve?', preview: '...', options: ['approve', 'reject'] },
    })
    const scheduler = createMockScheduler(['run_paused'])
    const store = createMockStore([run])
    const comp = new WorkflowRuntimeCheckpointableComponent(scheduler, store as any)

    const state = makeVersionedState({
      activeRuns: [{ runId: 'run_paused', status: 'paused' }],
    })

    await expect(comp.restore(state)).resolves.toBeUndefined()

    const plans = comp.getRecoveryPlans()
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({
      runId: 'run_paused',
      action: 'register-only',
    })

    // Verify store was queried
    expect(store.getRun).toHaveBeenCalledWith('run_paused')
    expect(store.getDefinition).toHaveBeenCalledWith(run.workflowDefId)
  })

  it('should generate skip plan for completed runs', async () => {
    const scheduler = createMockScheduler(['run_done', 'run_failed'])
    const store = createMockStore([
      createMockRun({ runId: 'run_done', status: 'done' }),
      createMockRun({ runId: 'run_failed', status: 'failed' }),
    ])
    const comp = new WorkflowRuntimeCheckpointableComponent(scheduler, store as any)

    const state = makeVersionedState({
      activeRuns: [
        { runId: 'run_done', status: 'done' },
        { runId: 'run_failed', status: 'failed' },
      ],
    })

    await comp.restore(state)

    const plans = comp.getRecoveryPlans()
    expect(plans).toHaveLength(2)
    expect(plans[0].action).toBe('skip')
    expect(plans[1].action).toBe('skip')
  })

  it('should generate skip plan for missing run', async () => {
    const scheduler = createMockScheduler(['run_missing'])
    const store = createMockStore([])
    const comp = new WorkflowRuntimeCheckpointableComponent(scheduler, store as any)

    const state = makeVersionedState({
      activeRuns: [{ runId: 'run_missing', status: 'running' }],
    })

    await comp.restore(state)

    const plans = comp.getRecoveryPlans()
    expect(plans).toHaveLength(1)
    expect(plans[0].action).toBe('skip')
    expect(plans[0].reason).toContain('not found')
  })

  it('should handle empty activeRuns gracefully', async () => {
    const scheduler = createMockScheduler([])
    const store = createMockStore([])
    const comp = new WorkflowRuntimeCheckpointableComponent(scheduler, store as any)

    await comp.restore(makeVersionedState({ activeRuns: [] }))
    expect(comp.getRecoveryPlans()).toEqual([])

    await comp.restore(makeVersionedState({}))
    expect(comp.getRecoveryPlans()).toEqual([])

    await comp.restore(makeVersionedState(null))
    expect(comp.getRecoveryPlans()).toEqual([])
  })

  it('should tolerate version mismatch', async () => {
    const scheduler = createMockScheduler([])
    const store = createMockStore([])
    const comp = new WorkflowRuntimeCheckpointableComponent(scheduler, store as any)

    const state = makeVersionedState({ activeRuns: [] }, '2.0')
    await expect(comp.restore(state)).resolves.toBeUndefined()
  })
})

// ════════════════════════════════════════════════════
//  Scene 3: completed runs → skip
// ════════════════════════════════════════════════════

describe('WorkflowRuntimeCheckpointableComponent — Scene 3: completed → skip', () => {
  it('should skip completed runs without calling getDefinition', async () => {
    const scheduler = createMockScheduler(['run_completed'])
    const store = createMockStore([
      createMockRun({ runId: 'run_completed', status: 'done' }),
    ])
    const comp = new WorkflowRuntimeCheckpointableComponent(scheduler, store as any)

    const state = makeVersionedState({
      activeRuns: [{ runId: 'run_completed', status: 'done' }],
    })

    await comp.restore(state)

    expect(store.getDefinition).not.toHaveBeenCalled()

    const plans = comp.getRecoveryPlans()
    expect(plans).toHaveLength(1)
    expect(plans[0].action).toBe('skip')
  })
})

// ════════════════════════════════════════════════════
//  Scene 4: WAITING_GATE → register-only
// ════════════════════════════════════════════════════

describe('WorkflowRuntimeCheckpointableComponent — Scene 4: WAITING_GATE', () => {
  it('should generate register-only plan for pending gate', async () => {
    const run = createMockRun({
      runId: 'run_gate',
      status: 'running',
      pendingGate: { stepId: 's2', message: 'Review?', preview: '...', options: ['approve', 'reject'] },
    })
    const scheduler = createMockScheduler(['run_gate'])
    const store = createMockStore([run])
    const comp = new WorkflowRuntimeCheckpointableComponent(scheduler, store as any)

    const state = makeVersionedState({
      activeRuns: [{ runId: 'run_gate', status: 'running' }],
    })

    await comp.restore(state)

    const plans = comp.getRecoveryPlans()
    expect(plans).toHaveLength(1)
    expect(plans[0].action).toBe('register-only')
    expect(plans[0].reason).toContain('gate')
  })
})

// ════════════════════════════════════════════════════
//  Scene 5: failure isolation — single run miss
// ════════════════════════════════════════════════════

describe('WorkflowRuntimeCheckpointableComponent — Scene 5: failure isolation', () => {
  it('should not throw when a single run has missing definition', async () => {
    const goodRun = createMockRun({ runId: 'run_good', status: 'paused' })
    const badRun = createMockRun({ runId: 'run_bad', status: 'running', workflowDefId: 'def_missing' })
    const scheduler = createMockScheduler(['run_good', 'run_bad'])
    const store = createMockStore([goodRun, badRun])
    store.getDefinition = vi.fn((id: string) => {
      if (id === 'def_missing') return null
      return { id, name: 'test-def', description: '', steps: [], createdAt: 0, updatedAt: 0, enabled: true }
    })

    const comp = new WorkflowRuntimeCheckpointableComponent(scheduler, store as any)
    const state = makeVersionedState({
      activeRuns: [
        { runId: 'run_good', status: 'paused' },
        { runId: 'run_bad', status: 'running' },
      ],
    })

    await expect(comp.restore(state)).resolves.toBeUndefined()

    const plans = comp.getRecoveryPlans()
    expect(plans).toHaveLength(2)
    // bad run gets skip (missing definition), good gets register-only
    const bad = plans.find((p) => p.runId === 'run_bad')
    expect(bad?.action).toBe('skip')
    expect(bad?.reason).toContain('not found')
    const good = plans.find((p) => p.runId === 'run_good')
    expect(good?.action).toBe('register-only')
  })
})

// ════════════════════════════════════════════════════
//  Scene 6: getRecoveryPlans returns plans
// ════════════════════════════════════════════════════

describe('WorkflowRuntimeCheckpointableComponent — Scene 6: getRecoveryPlans', () => {
  it('should return empty array before restore', () => {
    const scheduler = createMockScheduler([])
    const store = createMockStore([])
    const comp = new WorkflowRuntimeCheckpointableComponent(scheduler, store as any)
    expect(comp.getRecoveryPlans()).toEqual([])
  })

  it('should return correct plans for mixed run states', async () => {
    const scheduler = createMockScheduler(['run_resume', 'run_skip'])
    const store = createMockStore([
      createMockRun({ runId: 'run_resume', status: 'running' }),
      createMockRun({ runId: 'run_skip', status: 'done' }),
    ])
    const comp = new WorkflowRuntimeCheckpointableComponent(scheduler, store as any)

    await comp.restore(makeVersionedState({
      activeRuns: [
        { runId: 'run_resume', status: 'running' },
        { runId: 'run_skip', status: 'done' },
      ],
    }))

    const plans = comp.getRecoveryPlans()
    expect(plans).toHaveLength(2)
    expect(plans.find((p) => p.runId === 'run_resume')?.action).toBe('resume')
    expect(plans.find((p) => p.runId === 'run_skip')?.action).toBe('skip')
  })
})
