/**
 * 受 Supervisor 管理的 Agent 运行时状态枚举
 *
 * 与现有 RunState（src/main/agent/runstate.ts）共存而非取代。
 * 非监督式 executor（ChatExecutor、TaskExecutor）继续使用 RunState 不变。
 */
export enum AgentRuntimeState {
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
export const RUNTIME_TRANSITIONS: Record<AgentRuntimeState, AgentRuntimeState[]> = {
  [AgentRuntimeState.READY]: [
    AgentRuntimeState.RUNNING,
    AgentRuntimeState.CANCELLED,
  ],
  [AgentRuntimeState.RUNNING]: [
    AgentRuntimeState.WAITING_TOOL,
    AgentRuntimeState.WAITING_SUPERVISOR,
    AgentRuntimeState.PAUSED,
    AgentRuntimeState.INTERRUPTED,
    AgentRuntimeState.COMPLETED,
    AgentRuntimeState.FAILED,
    AgentRuntimeState.CANCELLED,
  ],
  [AgentRuntimeState.WAITING_TOOL]: [
    AgentRuntimeState.RUNNING,
    AgentRuntimeState.WAITING_SUPERVISOR,
    AgentRuntimeState.PAUSED,
    AgentRuntimeState.INTERRUPTED,
    AgentRuntimeState.CANCELLED,
    AgentRuntimeState.FAILED,
  ],
  [AgentRuntimeState.WAITING_SUPERVISOR]: [
    AgentRuntimeState.RUNNING,
    AgentRuntimeState.PAUSED,
    AgentRuntimeState.CANCELLED,
    AgentRuntimeState.INTERRUPTED,
  ],
  [AgentRuntimeState.PAUSED]: [
    AgentRuntimeState.RUNNING,
    AgentRuntimeState.CANCELLED,
    AgentRuntimeState.INTERRUPTED,
  ],
  [AgentRuntimeState.INTERRUPTED]: [
    AgentRuntimeState.RUNNING,
    AgentRuntimeState.CANCELLED,
  ],
  [AgentRuntimeState.COMPLETED]: [
    AgentRuntimeState.READY,
  ],
  [AgentRuntimeState.FAILED]: [
    AgentRuntimeState.READY,
  ],
  [AgentRuntimeState.CANCELLED]: [
    AgentRuntimeState.READY,
  ],
}

/** 安全转移 */
export function transitionRuntimeState(
  from: AgentRuntimeState,
  to: AgentRuntimeState,
): boolean {
  const allowed = RUNTIME_TRANSITIONS[from]
  if (!allowed?.includes(to)) return false
  return true
}
