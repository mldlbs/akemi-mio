/**
 * RuntimeState — Agent 运行时生命周期状态枚举。
 *
 * 与现有 RunState（src/main/agent/runstate.ts）共存而非取代。
 * 非监督式 executor（ChatExecutor、TaskExecutor）继续使用 RunState 不变。
 */
export enum RuntimeState {
  READY = 'ready',
  RUNNING = 'running',
  WAITING_TOOL = 'waiting_tool',
  WAITING_SUPERVISOR = 'waiting_supervisor',
  PAUSED = 'paused',
  INTERRUPTED = 'interrupted',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

/** 合法状态转移矩阵 */
export const RUNTIME_TRANSITIONS: Record<RuntimeState, RuntimeState[]> = {
  [RuntimeState.READY]: [RuntimeState.RUNNING, RuntimeState.CANCELLED],
  [RuntimeState.RUNNING]: [
    RuntimeState.WAITING_TOOL,
    RuntimeState.WAITING_SUPERVISOR,
    RuntimeState.PAUSED,
    RuntimeState.INTERRUPTED,
    RuntimeState.COMPLETED,
    RuntimeState.FAILED,
    RuntimeState.CANCELLED,
  ],
  [RuntimeState.WAITING_TOOL]: [
    RuntimeState.RUNNING,
    RuntimeState.WAITING_SUPERVISOR,
    RuntimeState.PAUSED,
    RuntimeState.INTERRUPTED,
    RuntimeState.CANCELLED,
    RuntimeState.FAILED,
  ],
  [RuntimeState.WAITING_SUPERVISOR]: [RuntimeState.RUNNING, RuntimeState.PAUSED, RuntimeState.CANCELLED, RuntimeState.INTERRUPTED],
  [RuntimeState.PAUSED]: [RuntimeState.RUNNING, RuntimeState.CANCELLED, RuntimeState.INTERRUPTED],
  [RuntimeState.INTERRUPTED]: [RuntimeState.RUNNING, RuntimeState.CANCELLED],
  [RuntimeState.COMPLETED]: [RuntimeState.READY],
  [RuntimeState.FAILED]: [RuntimeState.READY],
  [RuntimeState.CANCELLED]: [RuntimeState.READY],
}

/** 安全转移 */
export function transitionState(from: RuntimeState, to: RuntimeState): boolean {
  const allowed = RUNTIME_TRANSITIONS[from]
  if (!allowed?.includes(to)) return false
  return true
}
