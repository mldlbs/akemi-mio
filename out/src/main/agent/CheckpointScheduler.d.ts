import type { CheckpointData } from './SessionRecoveryManager';
import type { RunContext } from './runstate';
export interface MilestoneParams {
    step: number;
    toolResultsLength: number;
    runContext: RunContext;
    activePlanChanged?: boolean;
    lastCheckpointStep: number;
    lastCheckpointTime: number;
    consecutiveTimeoutRecoveries: number;
}
export interface MilestoneDecision {
    shouldCheckpoint: boolean;
    trigger: CheckpointData['meta']['trigger'];
}
/**
 * 评估是否到达里程碑，应创建检查点
 */
export declare function evaluateMilestone(params: MilestoneParams): MilestoneDecision;
