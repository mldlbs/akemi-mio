/**
 * RuntimeRecoveryActivator — tests
 *
 * Scene 1: activate with resume plans → scheduler.resumeRun called
 * Scene 2: activate with register-only plans → scheduler.registerRuntimeState called
 * Scene 3: activate with skip plans → no scheduler calls
 * Scene 4: mixed plans → correct routing per plan
 * Scene 5: partial failure → does not throw
 * Scene 6: empty plans → no-op
 */

import { describe, it, expect, vi } from 'vitest'
import { RuntimeRecoveryActivator } from '@akemi-mio/intelligence/runtime/RuntimeRecoveryActivator'
import type { WorkflowRecoveryPlan } from '@akemi-mio/intelligence/runtime/CheckpointTypes'

function createMockScheduler() {
  return {
    resumeRun: vi.fn().mockReturnValue({ state: 'started' }),
    registerRuntimeState: vi.fn(),
  }
}

describe('RuntimeRecoveryActivator — Scene 1: resume plans', () => {
  it('should call scheduler.resumeRun for each resume plan', async () => {
    const scheduler = createMockScheduler()
    const activator = new RuntimeRecoveryActivator(scheduler as any)

    const plans: WorkflowRecoveryPlan[] = [
      { runId: 'r1', action: 'resume' },
      { runId: 'r2', action: 'resume' },
    ]
    await activator.activate(plans)

    expect(scheduler.resumeRun).toHaveBeenCalledTimes(2)
    expect(scheduler.resumeRun).toHaveBeenCalledWith('r1')
    expect(scheduler.resumeRun).toHaveBeenCalledWith('r2')
    expect(scheduler.registerRuntimeState).not.toHaveBeenCalled()
  })

  it('should not throw when resumeRun returns failed', async () => {
    const scheduler = createMockScheduler()
    scheduler.resumeRun = vi.fn().mockReturnValue({ state: 'failed', reason: 'def not found' })
    const activator = new RuntimeRecoveryActivator(scheduler as any)

    await expect(activator.activate([{ runId: 'r_bad', action: 'resume' }])).resolves.toBeUndefined()
    expect(scheduler.resumeRun).toHaveBeenCalledTimes(1)
  })
})

describe('RuntimeRecoveryActivator — Scene 2: register-only plans', () => {
  it('should call scheduler.registerRuntimeState for each register-only plan', async () => {
    const scheduler = createMockScheduler()
    const activator = new RuntimeRecoveryActivator(scheduler as any)

    await activator.activate([
      { runId: 'r1', action: 'register-only', reason: 'pending gate' },
      { runId: 'r2', action: 'register-only', reason: 'paused' },
    ])

    expect(scheduler.registerRuntimeState).toHaveBeenCalledTimes(2)
    expect(scheduler.registerRuntimeState).toHaveBeenCalledWith('r1')
    expect(scheduler.registerRuntimeState).toHaveBeenCalledWith('r2')
    expect(scheduler.resumeRun).not.toHaveBeenCalled()
  })
})

describe('RuntimeRecoveryActivator — Scene 3: skip plans', () => {
  it('should not call any scheduler methods for skip plans', async () => {
    const scheduler = createMockScheduler()
    const activator = new RuntimeRecoveryActivator(scheduler as any)

    await activator.activate([{ runId: 'r1', action: 'skip', reason: 'status=done' }])

    expect(scheduler.resumeRun).not.toHaveBeenCalled()
    expect(scheduler.registerRuntimeState).not.toHaveBeenCalled()
  })
})

describe('RuntimeRecoveryActivator — Scene 4: mixed plans', () => {
  it('should route each plan to the correct scheduler method', async () => {
    const scheduler = createMockScheduler()
    const activator = new RuntimeRecoveryActivator(scheduler as any)

    await activator.activate([
      { runId: 'r1', action: 'resume' },
      { runId: 'r2', action: 'register-only', reason: 'paused' },
      { runId: 'r3', action: 'skip', reason: 'done' },
      { runId: 'r4', action: 'resume' },
    ])

    expect(scheduler.resumeRun).toHaveBeenCalledTimes(2)
    expect(scheduler.resumeRun).toHaveBeenCalledWith('r1')
    expect(scheduler.resumeRun).toHaveBeenCalledWith('r4')
    expect(scheduler.registerRuntimeState).toHaveBeenCalledTimes(1)
    expect(scheduler.registerRuntimeState).toHaveBeenCalledWith('r2')
  })
})

describe('RuntimeRecoveryActivator — Scene 5: empty plans', () => {
  it('should handle empty plans array without error', async () => {
    const scheduler = createMockScheduler()
    const activator = new RuntimeRecoveryActivator(scheduler as any)

    await expect(activator.activate([])).resolves.toBeUndefined()
    expect(scheduler.resumeRun).not.toHaveBeenCalled()
  })
})
