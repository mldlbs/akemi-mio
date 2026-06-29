import type { SessionRecoveryManager, CheckpointData } from '../agent/SessionRecoveryManager';
import type { SessionHealthScorer } from './SessionHealthScorer';
import type { CheckpointHealthVerification } from './SessionGovernorTypes';
/**
 * CheckpointV2 — 带健康验证的检查点系统。
 *
 * 在 SessionRecoveryManager 基础上增加：
 * 1. 保存前健康验证
 * 2. 恢复时选最近健康状态
 * 3. 坏状态拒绝保存
 */
export declare class CheckpointV2 {
    private baseDir;
    private recoveryManager;
    private healthScorer;
    constructor(baseDir: string, recoveryManager: SessionRecoveryManager);
    setHealthScorer(scorer: SessionHealthScorer): void;
    /**
     * 验证当前是否可保存 checkpoint。
     */
    verifyCheckpointHealth(): CheckpointHealthVerification;
    /**
     * 查找健康分最高的 checkpoint（而非最新的）。
     */
    findHealthyCheckpoint(): {
        checkpoint: CheckpointData | null;
        score: number;
        path: string;
    } | null;
    private scoreCheckpoint;
}
