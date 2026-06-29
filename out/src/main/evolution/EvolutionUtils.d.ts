/**
 * 获取系统状态快照（用于错误日志增强）。
 * 基础版本 — 用于 EvolutionHistoryManager 等独立模块的日志场景。
 */
export declare function getSystemStateSnapshot(): Record<string, any>;
/**
 * 收集变更文件列表（按 git 状态区分新增和修改）。
 * 从 SelfEvolutionService 提取为独立工具函数。
 */
export declare function collectChangedFiles(projectRoot: string): {
    newFiles: string[];
    modifiedFiles: string[];
};
