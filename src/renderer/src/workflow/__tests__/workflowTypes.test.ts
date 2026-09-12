import { describe, it, expect } from 'vitest'
import {
  createRun,
  transitionToRunning,
  transitionToDone,
  transitionToFailed,
  transitionToCancelled,
  transitionToPaused,
  transitionToResumed,
  transitionStepToRunning,
  transitionStepToDone,
  transitionStepToFailed,
  transitionStepToSkipped,
  IllegalTransitionError,
  isWorkflowActive,
  isStepActive,
} from '../workflowTypes'
import type { WorkflowState, StepRun } from '../workflowTypes'

function createdEvent(overrides?: Partial<{ runId: string; workflowDefId: string; workflowName: string }>) {
  return {
    type: 'workflow.created' as const,
    runId: 'wf1',
    workflowDefId: 'def1',
    workflowName: 'Test Workflow',
    steps: [
      { stepId: 's1', status: 'pending' as const },
      { stepId: 's2', status: 'pending' as const },
    ],
    timestamp: 1000,
    ...overrides,
  }
}

function createRunState(): WorkflowState {
  const pending = createRun(createdEvent())
  return transitionToRunning(pending, { type: 'workflow.started', runId: 'wf1', timestamp: 1000 })
}

describe('createRun', () => {
  it('creates a pending workflow state', () => {
    const state = createRun(createdEvent())
    expect(state.status).toBe('pending')
    expect(state.runId).toBe('wf1')
    expect(state.workflowName).toBe('Test Workflow')
    expect(state.steps).toHaveLength(2)
    expect(state.createdAt).toBe(1000)
  })
})

describe('transitionToRunning', () => {
  it('transitions pending → running', () => {
    const pending = createRun(createdEvent())
    const running = transitionToRunning(pending, { type: 'workflow.started', runId: 'wf1', timestamp: 1500 })
    expect(running.status).toBe('running')
    expect(running.startedAt).toBe(1500)
  })

  it('throws from terminal state', () => {
    const terminal: WorkflowState = {
      status: 'done',
      runId: 'wf1',
      workflowDefId: 'def1',
      workflowName: 'T',
      steps: [],
      createdAt: 1000,
      startedAt: 1000,
      endedAt: 2000,
    }
    expect(() => transitionToRunning(terminal, { type: 'workflow.started', runId: 'wf1', timestamp: 2000 })).toThrow(IllegalTransitionError)
  })
})

describe('transitionToDone', () => {
  it('transitions running → done', () => {
    const run = createRunState()
    const done = transitionToDone(run, { type: 'workflow.completed', runId: 'wf1', timestamp: 5000 })
    expect(done.status).toBe('done')
    expect(done.endedAt).toBe(5000)
  })

  it('throws from non-running state', () => {
    const pending = createRun(createdEvent())
    expect(() => transitionToDone(pending, { type: 'workflow.completed', runId: 'wf1', timestamp: 2000 })).toThrow(IllegalTransitionError)
  })
})

describe('transitionToFailed', () => {
  it('transitions running → failed with error', () => {
    const run = createRunState()
    const failed = transitionToFailed(run, { type: 'workflow.failed', runId: 'wf1', error: 'something broke', timestamp: 5000 })
    expect(failed.status).toBe('failed')
    expect(failed.error).toBe('something broke')
    expect(failed.endedAt).toBe(5000)
  })
})

describe('transitionToCancelled', () => {
  it('transitions running → cancelled', () => {
    const run = createRunState()
    const cancelled = transitionToCancelled(run, { type: 'workflow.cancelled', runId: 'wf1', timestamp: 5000 })
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.endedAt).toBe(5000)
  })
})

describe('transitionToPaused', () => {
  it('transitions running → paused', () => {
    const run = createRunState()
    const paused = transitionToPaused(run, { type: 'workflow.paused', runId: 'wf1', timestamp: 3000 })
    expect(paused.status).toBe('paused')
  })

  it('throws from non-running state', () => {
    const terminal: WorkflowState = {
      status: 'failed',
      runId: 'wf1',
      workflowDefId: 'def1',
      workflowName: 'T',
      steps: [],
      createdAt: 1000,
      startedAt: 1000,
      endedAt: 2000,
      error: 'err',
    }
    expect(() => transitionToPaused(terminal, { type: 'workflow.paused', runId: 'wf1', timestamp: 3000 })).toThrow(IllegalTransitionError)
  })
})

describe('transitionToResumed', () => {
  it('transitions paused → running', () => {
    const run = createRunState()
    const paused = transitionToPaused(run, { type: 'workflow.paused', runId: 'wf1', timestamp: 3000 })
    const resumed = transitionToResumed(paused, { type: 'workflow.resumed', runId: 'wf1', timestamp: 4000 })
    expect(resumed.status).toBe('running')
    expect(resumed.startedAt).toBe(4000)
  })

  it('throws from non-paused state', () => {
    const run = createRunState()
    expect(() => transitionToResumed(run, { type: 'workflow.resumed', runId: 'wf1', timestamp: 3000 })).toThrow(IllegalTransitionError)
  })
})

describe('step transitions', () => {
  function runWithPendingSteps(): WorkflowState {
    const pending = createRun(createdEvent())
    return transitionToRunning(pending, { type: 'workflow.started', runId: 'wf1', timestamp: 1000 })
  }

  it('step.started transitions pending → running', () => {
    const run = runWithPendingSteps()
    const result = transitionStepToRunning(run, { type: 'step.started', runId: 'wf1', stepId: 's1', timestamp: 1500 })
    const step = result.steps.find((s) => s.stepId === 's1')
    expect(step?.status).toBe('running')
    expect((step as any).startedAt).toBe(1500)
  })

  it('step.completed transitions running → done', () => {
    const run = runWithPendingSteps()
    const started = transitionStepToRunning(run, { type: 'step.started', runId: 'wf1', stepId: 's1', timestamp: 1500 })
    const result = transitionStepToDone(started, { type: 'step.completed', runId: 'wf1', stepId: 's1', agentResult: 'ok', timestamp: 2500 })
    const step = result.steps.find((s) => s.stepId === 's1')
    expect(step?.status).toBe('done')
    expect((step as any).agentResult).toBe('ok')
  })

  it('step.failed transitions running → failed', () => {
    const run = runWithPendingSteps()
    const started = transitionStepToRunning(run, { type: 'step.started', runId: 'wf1', stepId: 's1', timestamp: 1500 })
    const result = transitionStepToFailed(started, { type: 'step.failed', runId: 'wf1', stepId: 's1', error: 'fail', timestamp: 2500 })
    const step = result.steps.find((s) => s.stepId === 's1')
    expect(step?.status).toBe('failed')
    expect((step as any).error).toBe('fail')
  })

  it('step.skipped transitions pending → skipped', () => {
    const run = runWithPendingSteps()
    const result = transitionStepToSkipped(run, { type: 'step.skipped', runId: 'wf1', stepId: 's1', timestamp: 1500 })
    const step = result.steps.find((s) => s.stepId === 's1')
    expect(step?.status).toBe('skipped')
  })

  it('step.skipped throws from running state', () => {
    const run = runWithPendingSteps()
    const started = transitionStepToRunning(run, { type: 'step.started', runId: 'wf1', stepId: 's1', timestamp: 1500 })
    expect(() => transitionStepToSkipped(started, { type: 'step.skipped', runId: 'wf1', stepId: 's1', timestamp: 2000 })).toThrow(
      IllegalTransitionError,
    )
  })

  it('step.completed throws from pending state', () => {
    const run = runWithPendingSteps()
    expect(() =>
      transitionStepToDone(run, { type: 'step.completed', runId: 'wf1', stepId: 's1', agentResult: '', timestamp: 2000 }),
    ).toThrow(IllegalTransitionError)
  })

  it('step.failed throws from pending state', () => {
    const run = runWithPendingSteps()
    expect(() => transitionStepToFailed(run, { type: 'step.failed', runId: 'wf1', stepId: 's1', error: '', timestamp: 2000 })).toThrow(
      IllegalTransitionError,
    )
  })
})

describe('isWorkflowActive', () => {
  it('returns true for pending, running, paused', () => {
    const pending = createRun(createdEvent())
    expect(isWorkflowActive(pending)).toBe(true)
    const running = createRunState()
    expect(isWorkflowActive(running)).toBe(true)
    const paused = transitionToPaused(running, { type: 'workflow.paused', runId: 'wf1', timestamp: 3000 })
    expect(isWorkflowActive(paused)).toBe(true)
  })

  it('returns false for done, failed, cancelled', () => {
    const run = createRunState()
    expect(isWorkflowActive(transitionToDone(run, { type: 'workflow.completed', runId: 'wf1', timestamp: 5000 }))).toBe(false)
    expect(isWorkflowActive(transitionToFailed(run, { type: 'workflow.failed', runId: 'wf1', error: '', timestamp: 5000 }))).toBe(false)
    expect(isWorkflowActive(transitionToCancelled(run, { type: 'workflow.cancelled', runId: 'wf1', timestamp: 5000 }))).toBe(false)
  })
})

describe('isStepActive', () => {
  it('returns true for pending and running', () => {
    expect(isStepActive({ stepId: 's1', status: 'pending' })).toBe(true)
    expect(isStepActive({ stepId: 's1', status: 'running', startedAt: 1000 })).toBe(true)
  })

  it('returns false for done, failed, skipped', () => {
    expect(isStepActive({ stepId: 's1', status: 'done', startedAt: 1000, endedAt: 2000 })).toBe(false)
    expect(isStepActive({ stepId: 's1', status: 'failed', startedAt: 1000, endedAt: 2000 })).toBe(false)
    expect(isStepActive({ stepId: 's1', status: 'skipped', startedAt: 1000, endedAt: 2000 })).toBe(false)
  })
})
