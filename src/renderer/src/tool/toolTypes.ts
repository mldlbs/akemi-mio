// ── Status (FSM discriminant) ──
export type ToolStatus = 'pending' | 'running' | 'success' | 'error' | 'timeout' | 'cancelled'

// ── State union (each status carries its own data) ──
export interface ToolPending {
  status: 'pending'
  id: string
  tool: string
  args?: Record<string, any>
  createdAt: number
}

export interface ToolRunning {
  status: 'running'
  id: string
  tool: string
  args?: Record<string, any>
  startedAt: number
}

export interface ToolTerminal {
  status: 'success' | 'error' | 'timeout' | 'cancelled'
  id: string
  tool: string
  args?: Record<string, any>
  startedAt: number
  endedAt: number
  latencyMs: number
  result?: string
  error?: string
}

export type ToolState = ToolPending | ToolRunning | ToolTerminal

export function isToolActive(state: ToolState): boolean {
  return state.status === 'pending' || state.status === 'running'
}

/**
 * 终态判定，带类型收窄。
 * 注意 TS 不会把 `filter((t) => !isToolActive(t))` 收窄成 ToolTerminal[]，
 * 所以需要这个显式谓词，才能在渲染 latencyMs / error 这类终态独有字段时通过检查。
 */
export function isToolTerminal(state: ToolState): state is ToolTerminal {
  return !isToolActive(state)
}

// ── Transition event union ──
export type ToolEvent =
  | { type: 'tool.started'; id: string; tool: string; args?: Record<string, any>; timestamp: number }
  | { type: 'tool.succeeded'; id: string; result: string; latencyMs: number; timestamp: number }
  | { type: 'tool.failed'; id: string; error: string; latencyMs: number; timestamp: number }
  | { type: 'tool.timedout'; id: string; latencyMs: number; timestamp: number }
  | { type: 'tool.cancelled'; id: string; latencyMs?: number; timestamp: number }

// ── Guards ──
export class IllegalTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Illegal FSM transition: ${from} → ${to}`)
    this.name = 'IllegalTransitionError'
  }
}

function assertNonTerminal(state: ToolState): asserts state is ToolPending | ToolRunning {
  if (state.status === 'success' || state.status === 'error' || state.status === 'timeout' || state.status === 'cancelled') {
    throw new IllegalTransitionError(state.status, 'running')
  }
}

function assertRunning(state: ToolState): asserts state is ToolRunning {
  if (state.status !== 'running') {
    throw new IllegalTransitionError(state.status, 'terminal')
  }
}

// ── Transition functions ──
export function createPending(event: ToolEvent & { type: 'tool.started' }): ToolPending {
  return {
    status: 'pending',
    id: event.id,
    tool: event.tool,
    args: event.args,
    createdAt: event.timestamp,
  }
}

export function transitionToRunning(state: ToolState, event: ToolEvent & { type: 'tool.started' }): ToolRunning {
  assertNonTerminal(state)
  return {
    status: 'running',
    id: state.id,
    tool: state.tool,
    args: state.args ?? event.args,
    startedAt: event.timestamp,
  }
}

export function transitionToSuccess(state: ToolState, event: ToolEvent & { type: 'tool.succeeded' }): ToolTerminal {
  assertRunning(state)
  return {
    status: 'success',
    id: state.id,
    tool: state.tool,
    args: state.args,
    startedAt: state.startedAt,
    endedAt: event.timestamp,
    latencyMs: event.latencyMs,
    result: event.result,
  }
}

export function transitionToError(state: ToolState, event: ToolEvent & { type: 'tool.failed' }): ToolTerminal {
  assertRunning(state)
  return {
    status: 'error',
    id: state.id,
    tool: state.tool,
    args: state.args,
    startedAt: state.startedAt,
    endedAt: event.timestamp,
    latencyMs: event.latencyMs,
    error: event.error,
  }
}

export function transitionToTimeout(state: ToolState, event: ToolEvent & { type: 'tool.timedout' }): ToolTerminal {
  assertRunning(state)
  return {
    status: 'timeout',
    id: state.id,
    tool: state.tool,
    args: state.args,
    startedAt: state.startedAt,
    endedAt: event.timestamp,
    latencyMs: event.latencyMs,
  }
}

export function transitionToCancelled(state: ToolState, event: ToolEvent & { type: 'tool.cancelled' }): ToolTerminal {
  assertRunning(state)
  return {
    status: 'cancelled',
    id: state.id,
    tool: state.tool,
    args: state.args,
    startedAt: state.startedAt,
    endedAt: event.timestamp,
    latencyMs: event.latencyMs ?? Date.now() - state.startedAt,
  }
}
