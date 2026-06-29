export declare enum RollbackLevel {
    TASK = "task",
    MODULE = "module",
    SYSTEM = "system"
}
/**
 * Git 操作 — 自动 commit/stash/restore。
 * 从 SelfEvolutionService 提取。
 */
export declare class EvolutionGitOps {
    constructor();
    autoGitCommit(planTitle: string): Promise<void>;
    workspacePreCheck(lastSuccessTime: number): Promise<boolean>;
    workspacePostRestore(): Promise<void>;
    collectChangedFiles(): Promise<{
        newFiles: string[];
        modifiedFiles: string[];
    }>;
    getCurrentBranch(): Promise<string>;
    createSnapshot(tag: string): Promise<string | null>;
    rollbackToSnapshot(branch: string, level?: RollbackLevel): Promise<boolean>;
    rollback(level: RollbackLevel, ref: string): Promise<boolean>;
    cleanupSnapshot(branch: string): Promise<boolean>;
}
