const STEP_INTERVAL = 5;
const TOOL_INTERVAL = 5;
const DEBOUNCE_MS = 3000;
/**
 * 评估是否到达里程碑，应创建检查点
 */
export function evaluateMilestone(params) {
    if (params.runContext.interruptFlag) {
        return { shouldCheckpoint: false, trigger: 'milestone' };
    }
    if (Date.now() - params.lastCheckpointTime < DEBOUNCE_MS) {
        return { shouldCheckpoint: false, trigger: 'milestone' };
    }
    if (params.activePlanChanged) {
        return { shouldCheckpoint: true, trigger: 'milestone' };
    }
    if (params.step > 0 && params.step !== params.lastCheckpointStep && params.step % STEP_INTERVAL === 0) {
        return { shouldCheckpoint: true, trigger: 'milestone' };
    }
    if (params.toolResultsLength >= TOOL_INTERVAL && params.step !== params.lastCheckpointStep) {
        return { shouldCheckpoint: true, trigger: 'milestone' };
    }
    return { shouldCheckpoint: false, trigger: 'milestone' };
}
