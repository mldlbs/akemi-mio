/**
 * E2ERestoreValidation — End-to-End Restore Validation Tests.
 *
 * 四条真实链路验证：
 *   Scene 1: 装配验证 — 服务链存在且顺序正确
 *   Scene 2: Checkpoint round trip — save/load/restore/plan
 *   Scene 3: Workflow recovery decision matrix — resume/register-only/skip 路由
 *   Scene 4: Failure isolation — 任意环节失败不会级联
 *
 * 遵循现有 runtime 测试模式：scene 结构、内联 mock 工厂、vi.fn()。
 * 不引入新生产代码。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorkflowRuntimeCheckpointableComponent } from '../WorkflowRuntimeCheckpointableComponent'
import { ComponentRegistryImpl } from '../ComponentRegistry'
import { RuntimeRestoreServiceImpl } from '../RuntimeRestoreService'
import { RuntimeRecoveryActivator } from '../RuntimeRecoveryActivator'
import { MockCheckpointManager } from './MockCheckpointManager'
import type { WorkflowSchedulerV2 } from '../../workflow/WorkflowScheduler'
import type { Checkpoint, VersionedState, CheckpointableComponent } from '../CheckpointTypes'
import type { CheckpointManager } from '../CheckpointManager'

// ════════════════════════════════════════════════════
//  Shared Helpers
// ════════════════════════════════════════════════════

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: 'ck_e2e_1',
    taskId: 'task_e2e_1',
    schemaVersion: '1.0',
    runtimeCompatibility: { min: '2.0', max: '2.x' },
    taskState: { name: 'e2e-task', createdAt: Date.now() },
    executionState: {
      workerId: 'w1',
      goal: 'e2e goal',
      step: 0,
      lastSafePoint: 'before_llm' as any,
      conversationContext: { type: 'inline', messages: [], tokenEstimate: 0 },
      pendingToolCalls: [],
    },
    createdAt: Date.now(),
    ...overrides,
  }
}

function mockStoreWithRuns(runs: any[]) {
  const runMap = new Map(runs.map((r) => [r.runId, r]))
  const defMap = new Map<string, any>()
  for (const r of runs) {
    if (!defMap.has(r.workflowDefId)) {
      defMap.set(r.workflowDefId, {
        id: r.workflowDefId,
        name: 'test-def',
        description: '',
        steps: (r.steps ?? []).map((s: any) => ({
          id: s.stepId ?? 's_default',
          name: s.stepId ?? 'default',
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

function createMockRun(overrides: Partial<any> = {}) {
  return {
    runId: 'run_default',
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
    userInput: 'test',
    ...overrides,
  }
}

function makeVersionedState(data: unknown, version = '1.0'): VersionedState {
  return { component: 'workflow-runtime', version, data, createdAt: Date.now() }
}

// ════════════════════════════════════════════════════
//  Scene 1: Assembly Verification
// ════════════════════════════════════════════════════

describe('E2E — Scene 1: assembly verification', () => {
  it('should wire ComponentRegistry → RuntimeRestoreService → RuntimeRecoveryActivator', () => {
    const registry = new ComponentRegistryImpl()
    const mgr = new MockCheckpointManager()
    const restoreService = new RuntimeRestoreServiceImpl(mgr, registry)
    const scheduler = { resumeRun: vi.fn(), registerRuntimeState: vi.fn() } as unknown as WorkflowSchedulerV2
    const activator = new RuntimeRecoveryActivator(scheduler)

    restoreService.setActivator(activator)
    expect(restoreService).toBeDefined()
  })

  it('should accept workflow-runtime descriptor in registry', () => {
    const registry = new ComponentRegistryImpl()
    registry.register({
      id: 'workflow-runtime',
      version: '1.0',
      create: () => new WorkflowRuntimeCheckpointableComponent(
        { getActiveRunIds: vi.fn(() => []) } as unknown as WorkflowSchedulerV2,
        { getRun: vi.fn(), getDefinition: vi.fn() } as any,
      ),
    })

    const desc = registry.resolve('workflow-runtime')
    expect(desc).toBeDefined()
    expect(desc!.id).toBe('workflow-runtime')
    expect(desc!.version).toBe('1.0')
  })

  it('should create valid CheckpointableComponent from descriptor', () => {
    const scheduler = { getActiveRunIds: vi.fn(() => []) } as unknown as WorkflowSchedulerV2
    const store = { getRun: vi.fn(), getDefinition: vi.fn() } as any
    const registry = new ComponentRegistryImpl()
    registry.register({
      id: 'workflow-runtime',
      version: '1.0',
      create: () => new WorkflowRuntimeCheckpointableComponent(scheduler, store),
    })

    const desc = registry.resolve('workflow-runtime')!
    const comp = desc.create()

    expect(comp.id).toBe('workflow-runtime')
    expect(typeof comp.snapshot).toBe('function')
    expect(typeof comp.restore).toBe('function')
  })

  it('should resolve unknown component id as undefined', () => {
    const registry = new ComponentRegistryImpl()
    registry.register({ id: 'workflow-runtime', version: '1.0', create: () => ({} as CheckpointableComponent) })
    expect(registry.resolve('unknown-component')).toBeUndefined()
  })

  it('should reject duplicate registration', () => {
    const registry = new ComponentRegistryImpl()
    registry.register({ id: 'workflow-runtime', version: '1.0', create: () => ({} as CheckpointableComponent) })
    expect(() =>
      registry.register({ id: 'workflow-runtime', version: '1.0', create: () => ({} as CheckpointableComponent) }),
    ).toThrow(/duplicate/i)
  })
})

// ════════════════════════════════════════════════════
//  Scene 2: Checkpoint Round-Trip
// ════════════════════════════════════════════════════

describe('E2E — Scene 2: checkpoint round trip', () => {
  let mgr: CheckpointManager
  let registry: ComponentRegistryImpl

  beforeEach(() => {
    mgr = new MockCheckpointManager()
    registry = new ComponentRegistryImpl()
  })

  it('should snapshot → save → load → validate → restore → plans', async () => {
    // 1. snapshot a component with 2 active runs
    const runResume = createMockRun({ runId: 'run_r1', status: 'running' })
    const runPaused = createMockRun({ runId: 'run_p1', status: 'paused', pendingGate: { stepId: 's2', message: '?', preview: '', options: [] } })
    const store = mockStoreWithRuns([runResume, runPaused])
    const scheduler = { getActiveRunIds: vi.fn(() => ['run_r1', 'run_p1']) } as unknown as WorkflowSchedulerV2
    const comp = new WorkflowRuntimeCheckpointableComponent(scheduler, store as any)

    const versionedState = await comp.snapshot()

    // 2. embed into checkpoint
    const checkpoint = makeCheckpoint({
      id: 'ck_e2e_roundtrip',
      componentStates: { 'workflow-runtime': versionedState },
    })

    // 3. save → load → validate
    await mgr.save(checkpoint)
    const loaded = await mgr.load('ck_e2e_roundtrip')
    const validation = mgr.validate(loaded)
    expect(validation.ok).toBe(true)
    expect(loaded.componentStates?.['workflow-runtime']).toBeDefined()

    // 4. register workflow-runtime descriptor
    registry.register({
      id: 'workflow-runtime',
      version: '1.0',
      create: () => new WorkflowRuntimeCheckpointableComponent(
        { getActiveRunIds: vi.fn(() => []) } as unknown as WorkflowSchedulerV2,
        mockStoreWithRuns([runResume, runPaused]) as any,
      ),
    })

    // 5. create new component instance & restore
    const desc = registry.resolve('workflow-runtime')!
    const restoredComp = desc.create() as WorkflowRuntimeCheckpointableComponent
    await restoredComp.restore(loaded.componentStates!['workflow-runtime'])

    // 6. verify plans
    const plans = restoredComp.getRecoveryPlans()
    expect(plans).toHaveLength(2)
    const plan1 = plans.find((p) => p.runId === 'run_r1')
    const plan2 = plans.find((p) => p.runId === 'run_p1')
    expect(plan1?.action).toBe('resume')
    expect(plan2?.action).toBe('register-only')
  })

  it('should fail validation for corrupt checkpoint', async () => {
    const badCheckpoint = makeCheckpoint({ schemaVersion: '' })
    const validation = mgr.validate(badCheckpoint)
    expect(validation.ok).toBe(false)
    expect(validation.errors.some((e) => e.includes('schemaVersion'))).toBe(true)
  })

  it('should throw on loading nonexistent checkpoint', async () => {
    await expect(mgr.load('ck_nonexistent')).rejects.toThrow('checkpoint not found')
  })

  it('should support save → load → save → load update', async () => {
    const cp1 = makeCheckpoint({ id: 'ck_update', executionState: { workerId: 'w1', goal: 'g1', step: 1, lastSafePoint: 'before_llm' as any, conversationContext: { type: 'inline', messages: [], tokenEstimate: 0 }, pendingToolCalls: [] } })
    await mgr.save(cp1)

    const cp2 = { ...cp1, executionState: { ...cp1.executionState, step: 5 } }
    await mgr.save(cp2)

    const loaded = await mgr.load('ck_update')
    expect(loaded.executionState.step).toBe(5)
  })
})

// ════════════════════════════════════════════════════
//  Scene 3: Workflow Recovery Decision Matrix
// ════════════════════════════════════════════════════

describe('E2E — Scene 3: workflow recovery decision matrix', () => {
  /**
   * Full chain: checkpoint → RuntimeRestoreService.restore()
   * → coordinator → component.restore() (plans) → activator → scheduler
   *
   * Verifies that each run state produces the correct scheduler action.
   */
  function setupE2E(runs: any[]) {
    const store = mockStoreWithRuns(runs)
    const scheduler = {
      getActiveRunIds: vi.fn(() => runs.map((r) => r.runId)),
      resumeRun: vi.fn().mockReturnValue({ state: 'started' }),
      registerRuntimeState: vi.fn(),
    } as unknown as WorkflowSchedulerV2

    // Build checkpoint with snapshot
    const sourceComp = new WorkflowRuntimeCheckpointableComponent(scheduler, store as any)
    const registry = new ComponentRegistryImpl()
    registry.register({
      id: 'workflow-runtime',
      version: '1.0',
      create: () => new WorkflowRuntimeCheckpointableComponent(
        { getActiveRunIds: vi.fn(() => []) } as unknown as WorkflowSchedulerV2,
        store as any,
      ),
    })

    const mgr = new MockCheckpointManager()
    const restoreService = new RuntimeRestoreServiceImpl(mgr, registry)
    restoreService.setActivator(new RuntimeRecoveryActivator(scheduler))

    return { scheduler, registry, mgr, restoreService, sourceComp, store }
  }

  it('should resume running workflows', async () => {
    const { restoreService, scheduler, sourceComp, mgr } = setupE2E([
      createMockRun({ runId: 'run_active', status: 'running' }),
    ])

    const state = await sourceComp.snapshot()
    const cp = makeCheckpoint({ id: 'ck_resume', componentStates: { 'workflow-runtime': state } })
    await mgr.save(cp)

    const result = await restoreService.restore('ck_resume')
    expect(result.status).toBe('ok')
    expect(scheduler.resumeRun).toHaveBeenCalledWith('run_active')
    expect(scheduler.registerRuntimeState).not.toHaveBeenCalled()
  })

  it('should register-only paused workflows', async () => {
    const { restoreService, scheduler, sourceComp, mgr } = setupE2E([
      createMockRun({ runId: 'run_paused', status: 'paused', pendingGate: { stepId: 's2', message: '?', preview: '', options: [] } }),
    ])

    const state = await sourceComp.snapshot()
    const cp = makeCheckpoint({ id: 'ck_register', componentStates: { 'workflow-runtime': state } })
    await mgr.save(cp)

    const result = await restoreService.restore('ck_register')
    expect(result.status).toBe('ok')
    expect(scheduler.registerRuntimeState).toHaveBeenCalledWith('run_paused')
    expect(scheduler.resumeRun).not.toHaveBeenCalled()
  })

  it('should skip completed workflows', async () => {
    const { restoreService, scheduler, sourceComp, mgr } = setupE2E([
      createMockRun({ runId: 'run_done', status: 'done' }),
    ])

    const state = await sourceComp.snapshot()
    const cp = makeCheckpoint({ id: 'ck_skip', componentStates: { 'workflow-runtime': state } })
    await mgr.save(cp)

    const result = await restoreService.restore('ck_skip')
    expect(result.status).toBe('ok')
    expect(scheduler.resumeRun).not.toHaveBeenCalled()
    expect(scheduler.registerRuntimeState).not.toHaveBeenCalled()
  })

  it('should register-only running workflows with pending gate', async () => {
    const { restoreService, scheduler, sourceComp, mgr } = setupE2E([
      createMockRun({ runId: 'run_gate', status: 'running', pendingGate: { stepId: 's2', message: 'Approve?', preview: '...', options: [] } }),
    ])

    const state = await sourceComp.snapshot()
    const cp = makeCheckpoint({ id: 'ck_gate', componentStates: { 'workflow-runtime': state } })
    await mgr.save(cp)

    const result = await restoreService.restore('ck_gate')
    expect(result.status).toBe('ok')
    expect(scheduler.registerRuntimeState).toHaveBeenCalledWith('run_gate')
    expect(scheduler.resumeRun).not.toHaveBeenCalled()
  })

  it('should route mixed states correctly', async () => {
    const { restoreService, scheduler, sourceComp, mgr } = setupE2E([
      createMockRun({ runId: 'r_resume', status: 'running' }),
      createMockRun({ runId: 'r_register', status: 'paused', pendingGate: { stepId: 's2', message: '?', preview: '', options: [] } }),
      createMockRun({ runId: 'r_skip', status: 'done' }),
    ])

    const state = await sourceComp.snapshot()
    const cp = makeCheckpoint({ id: 'ck_mixed', componentStates: { 'workflow-runtime': state } })
    await mgr.save(cp)

    const result = await restoreService.restore('ck_mixed')
    expect(result.status).toBe('ok')
    expect(scheduler.resumeRun).toHaveBeenCalledWith('r_resume')
    expect(scheduler.resumeRun).toHaveBeenCalledTimes(1)
    expect(scheduler.registerRuntimeState).toHaveBeenCalledWith('r_register')
    expect(scheduler.registerRuntimeState).toHaveBeenCalledTimes(1)
  })
})

// ════════════════════════════════════════════════════
//  Scene 4: Failure Isolation
// ════════════════════════════════════════════════════

describe('E2E — Scene 4: failure isolation', () => {
  it('should return degraded when activator throws', async () => {
    const store = mockStoreWithRuns([createMockRun({ runId: 'run_active', status: 'running' })])
    const scheduler = {
      getActiveRunIds: vi.fn(() => ['run_active']),
      resumeRun: vi.fn(() => { throw new Error('activation failure') }),
      registerRuntimeState: vi.fn(),
    } as unknown as WorkflowSchedulerV2

    const sourceComp = new WorkflowRuntimeCheckpointableComponent(scheduler, store as any)

    const registry = new ComponentRegistryImpl()
    registry.register({
      id: 'workflow-runtime',
      version: '1.0',
      create: () => new WorkflowRuntimeCheckpointableComponent(
        { getActiveRunIds: vi.fn(() => []) } as unknown as WorkflowSchedulerV2,
        store as any,
      ),
    })

    const mgr = new MockCheckpointManager()
    const restoreService = new RuntimeRestoreServiceImpl(mgr, registry)
    restoreService.setActivator(new RuntimeRecoveryActivator(scheduler))

    const state = await sourceComp.snapshot()
    const cp = makeCheckpoint({ id: 'ck_degraded', componentStates: { 'workflow-runtime': state } })
    await mgr.save(cp)

    const result = await restoreService.restore('ck_degraded')
    expect(result.status).toBe('degraded')
    // components restored, scheduler activation failed
    expect(result.taskId).toBe('task_e2e_1')
  })

  it('should return failed when component restore throws', async () => {
    const failingRegistry = new ComponentRegistryImpl()
    failingRegistry.register({
      id: 'always-fail',
      version: '1.0',
      create: () => ({
        id: 'always-fail',
        snapshot: vi.fn(),
        restore: vi.fn().mockRejectedValue(new Error('restore explosion')),
      }),
    })

    const mgr = new MockCheckpointManager()
    const restoreService = new RuntimeRestoreServiceImpl(mgr, failingRegistry)

    const cp = makeCheckpoint({
      id: 'ck_fail_restore',
      componentStates: {
        'always-fail': { component: 'always-fail', version: '1.0', data: {}, createdAt: Date.now() },
      },
    })
    await mgr.save(cp)

    const result = await restoreService.restore('ck_fail_restore')
    expect(result.status).toBe('failed')
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('should return failed when component descriptor not found', async () => {
    const registry = new ComponentRegistryImpl()
    const mgr = new MockCheckpointManager()
    const restoreService = new RuntimeRestoreServiceImpl(mgr, registry)

    const cp = makeCheckpoint({
      id: 'ck_unknown_comp',
      componentStates: {
        'unknown-component': { component: 'unknown-component', version: '1.0', data: {}, createdAt: Date.now() },
      },
    })
    await mgr.save(cp)

    const result = await restoreService.restore('ck_unknown_comp')
    expect(result.status).toBe('failed')
  })

  it('should return failed on concurrent restore of same checkpoint', async () => {
    const registry = new ComponentRegistryImpl()
    const mgr = new MockCheckpointManager()
    const restoreService = new RuntimeRestoreServiceImpl(mgr, registry)

    const cp = makeCheckpoint({ id: 'ck_concurrent' })
    await mgr.save(cp)

    // First call is in-flight, second should be rejected
    const promise1 = restoreService.restore('ck_concurrent')
    const promise2 = restoreService.restore('ck_concurrent')

    const [result1, result2] = await Promise.all([promise1, promise2])
    expect(result2.status).toBe('failed')
    expect(result2.errors[0]).toContain('already in-flight')
  })

  it('should not throw when scheduler resumeRun returns failed state', async () => {
    const scheduler = {
      getActiveRunIds: vi.fn(() => ['run_fail']),
      resumeRun: vi.fn().mockReturnValue({ state: 'failed', reason: 'execution error' }),
      registerRuntimeState: vi.fn(),
    } as unknown as WorkflowSchedulerV2

    const store = mockStoreWithRuns([createMockRun({ runId: 'run_fail', status: 'running' })])
    const registry = new ComponentRegistryImpl()
    registry.register({
      id: 'workflow-runtime',
      version: '1.0',
      create: () => new WorkflowRuntimeCheckpointableComponent(
        { getActiveRunIds: vi.fn(() => []) } as unknown as WorkflowSchedulerV2,
        store as any,
      ),
    })

    const sourceComp = new WorkflowRuntimeCheckpointableComponent(scheduler, store as any)
    const state = await sourceComp.snapshot()

    const mgr = new MockCheckpointManager()
    const cp = makeCheckpoint({ id: 'ck_resume_fail', componentStates: { 'workflow-runtime': state } })
    await mgr.save(cp)

    const restoreService = new RuntimeRestoreServiceImpl(mgr, registry)
    restoreService.setActivator(new RuntimeRecoveryActivator(scheduler))

    // resumeRun returns failed state → activator logs but doesn't throw → restore succeeds
    await expect(restoreService.restore('ck_resume_fail')).resolves.toMatchObject({ status: 'ok' })
  })
})
