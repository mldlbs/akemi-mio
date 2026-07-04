// ── Status (FSM discriminants) ──
export type WorkflowStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'paused'
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

// ── Step run state ──
export interface StepPending {
  status: 'pending'
  stepId: string
}

export interface StepRunning {
  status: 'running'
  stepId: string
  startedAt: number
}

export interface StepTerminal {
  status: 'done' | 'failed' | 'skipped'
  stepId: string
  startedAt: number
  endedAt: number
  agentResult?: string
  error?: string
}

export type StepRun = StepPending | StepRunning | StepTerminal

// ── Workflow run state ──
export interface WorkflowPending {
  status: 'pending'
  runId: string
  workflowDefId: string
  workflowName: string
  steps: StepRun[]
  createdAt: number
}

export interface WorkflowRunning {
  status: 'running'
  runId: string
  workflowDefId: string
  workflowName: string
  steps: StepRun[]
  createdAt: number
  startedAt: number
}

export interface WorkflowPaused {
  status: 'paused'
  runId: string
  workflowDefId: string
  workflowName: string
  steps: StepRun[]
  createdAt: number
  startedAt: number
}

export interface WorkflowTerminal {
  status: 'done' | 'failed' | 'cancelled'
  runId: string
  workflowDefId: string
  workflowName: string
  steps: StepRun[]
  createdAt: number
  startedAt: number
  endedAt: number
  error?: string
}

export type WorkflowState = WorkflowPending | WorkflowRunning | WorkflowPaused | WorkflowTerminal

export function isWorkflowActive(state: WorkflowState): boolean {
  return state.status === 'pending' || state.status === 'running' || state.status === 'paused'
}

export function isStepActive(state: StepRun): boolean {
  return state.status === 'pending' || state.status === 'running'
}

// ── Transition event union ──
export type WorkflowEvent =
  | { type: 'workflow.created'; runId: string; workflowDefId: string; workflowName: string; steps: StepRun[]; timestamp: number }
  | { type: 'workflow.started'; runId: string; timestamp: number }
  | { type: 'workflow.completed'; runId: string; timestamp: number }
  | { type: 'workflow.failed'; runId: string; error: string; timestamp: number }
  | { type: 'workflow.cancelled'; runId: string; timestamp: number }
  | { type: 'workflow.paused'; runId: string; timestamp: number }
  | { type: 'workflow.resumed'; runId: string; timestamp: number }
  | { type: 'step.started'; runId: string; stepId: string; timestamp: number }
  | { type: 'step.completed'; runId: string; stepId: string; agentResult: string; timestamp: number }
  | { type: 'step.failed'; runId: string; stepId: string; error: string; timestamp: number }
  | { type: 'step.skipped'; runId: string; stepId: string; timestamp: number }

// ── Guards ──
export class IllegalTransitionError extends Error {
  constructor(from: string, to: string, context?: string) {
    super(`Illegal FSM transition${context ? ` [${context}]` : ''}: ${from} → ${to}`)
    this.name = 'IllegalTransitionError'
  }
}

function assertRunNonTerminal(state: WorkflowState): asserts state is WorkflowPending | WorkflowRunning | WorkflowPaused {
  if (state.status === 'done' || state.status === 'failed' || state.status === 'cancelled') {
    throw new IllegalTransitionError(state.status, 'running', 'workflow')
  }
}

function assertRunRunning(state: WorkflowState): asserts state is WorkflowRunning {
  if (state.status !== 'running') {
    throw new IllegalTransitionError(state.status, 'terminal', 'workflow')
  }
}

function assertStepPending(state: StepRun): asserts state is StepPending {
  if (state.status !== 'pending') {
    throw new IllegalTransitionError(state.status, 'running', 'step')
  }
}

function assertStepRunning(state: StepRun): asserts state is StepRunning {
  if (state.status !== 'running') {
    throw new IllegalTransitionError(state.status, 'terminal', 'step')
  }
}

// ── Run transition functions ──
export function createRun(event: WorkflowEvent & { type: 'workflow.created' }): WorkflowPending {
  return {
    status: 'pending',
    runId: event.runId,
    workflowDefId: event.workflowDefId,
    workflowName: event.workflowName,
    steps: event.steps,
    createdAt: event.timestamp,
  }
}

export function transitionToRunning(state: WorkflowState, event: WorkflowEvent & { type: 'workflow.started' }): WorkflowRunning {
  assertRunNonTerminal(state)
  return {
    ...state,
    status: 'running',
    startedAt: event.timestamp,
  }
}

export function transitionToDone(state: WorkflowState, event: WorkflowEvent & { type: 'workflow.completed' }): WorkflowTerminal {
  assertRunRunning(state)
  return {
    ...state,
    status: 'done',
    endedAt: event.timestamp,
  }
}

export function transitionToFailed(state: WorkflowState, event: WorkflowEvent & { type: 'workflow.failed' }): WorkflowTerminal {
  assertRunRunning(state)
  return {
    ...state,
    status: 'failed',
    endedAt: event.timestamp,
    error: event.error,
  }
}

export function transitionToCancelled(state: WorkflowState, event: WorkflowEvent & { type: 'workflow.cancelled' }): WorkflowTerminal {
  assertRunRunning(state)
  return {
    ...state,
    status: 'cancelled',
    endedAt: event.timestamp,
  }
}

export function transitionToPaused(state: WorkflowState, event: WorkflowEvent & { type: 'workflow.paused' }): WorkflowPaused {
  assertRunRunning(state)
  return {
    ...state,
    status: 'paused',
  }
}

export function transitionToResumed(state: WorkflowState, event: WorkflowEvent & { type: 'workflow.resumed' }): WorkflowRunning {
  if (state.status !== 'paused') {
    throw new IllegalTransitionError(state.status, 'running', 'workflow')
  }
  return {
    ...state,
    status: 'running',
    startedAt: event.timestamp,
  }
}

// ── Step transition functions ──
export function transitionStepToRunning(state: WorkflowState, event: WorkflowEvent & { type: 'step.started' }): WorkflowState {
  const steps = state.steps.map((s) => {
    if (s.stepId !== event.stepId) return s
    assertStepPending(s)
    return { status: 'running' as const, stepId: s.stepId, startedAt: event.timestamp }
  })
  return { ...state, steps }
}

export function transitionStepToDone(state: WorkflowState, event: WorkflowEvent & { type: 'step.completed' }): WorkflowState {
  const steps = state.steps.map((s) => {
    if (s.stepId !== event.stepId) return s
    assertStepRunning(s)
    return {
      status: 'done' as const,
      stepId: s.stepId,
      startedAt: s.startedAt,
      endedAt: event.timestamp,
      agentResult: event.agentResult,
    }
  })
  return { ...state, steps }
}

export function transitionStepToFailed(state: WorkflowState, event: WorkflowEvent & { type: 'step.failed' }): WorkflowState {
  const steps = state.steps.map((s) => {
    if (s.stepId !== event.stepId) return s
    assertStepRunning(s)
    return {
      status: 'failed' as const,
      stepId: s.stepId,
      startedAt: s.startedAt,
      endedAt: event.timestamp,
      error: event.error,
    }
  })
  return { ...state, steps }
}

export function transitionStepToSkipped(state: WorkflowState, event: WorkflowEvent & { type: 'step.skipped' }): WorkflowState {
  const steps = state.steps.map((s) => {
    if (s.stepId !== event.stepId) return s
    assertStepPending(s)
    return {
      status: 'skipped' as const,
      stepId: s.stepId,
      startedAt: event.timestamp,
      endedAt: event.timestamp,
    }
  })
  return { ...state, steps }
}
