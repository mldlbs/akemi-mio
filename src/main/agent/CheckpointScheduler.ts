import type { CheckpointData } from './SessionRecoveryManager'
import type { RunContext } from './runstate'

// =============================================================================
// 里程碑决策 — 判断何时应创建检查点
// =============================================================================

export interface MilestoneParams {
  step: number
  toolResultsLength: number
  runContext: RunContext
  activePlanChanged: boolean
  lastCheckpointStep: number
  lastCheckpointTime: number
  consecutiveTimeoutRecoveries: number
}

export interface MilestoneDecision {
  shouldCheckpoint: boolean
  trigger: CheckpointData['meta']['trigger']
}

const STEP_INTERVAL = 5
const TOOL_INTERVAL = 5
const DEBOUNCE_MS = 3000

/**
 * 评估是否到达里程碑，应创建检查点
 */
export function evaluateMilestone(params: MilestoneParams): MilestoneDecision {
  if (params.runContext.interruptFlag) {
    return { shouldCheckpoint: false, trigger: 'milestone' }
  }

  if (Date.now() - params.lastCheckpointTime < DEBOUNCE_MS) {
    return { shouldCheckpoint: false, trigger: 'milestone' }
  }

  if (params.activePlanChanged) {
    return { shouldCheckpoint: true, trigger: 'milestone' }
  }

  if (params.step > 0 && params.step !== params.lastCheckpointStep && params.step % STEP_INTERVAL === 0) {
    return { shouldCheckpoint: true, trigger: 'milestone' }
  }

  if (params.toolResultsLength >= TOOL_INTERVAL && params.step !== params.lastCheckpointStep) {
    return { shouldCheckpoint: true, trigger: 'milestone' }
  }

  return { shouldCheckpoint: false, trigger: 'milestone' }
}
