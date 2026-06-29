/**
 * PromptEvolutionManager — Prompt 版本管理与演化
 *
 * 管理三类 prompt 槽（analysis_prompt / system_prompt / execution_prompt），
 * 在退化检测时创建新版本（追加反模式指令），恢复时重置回基版本。
 * 纯本地操作，无额外 LLM 调用。
 */
export type PromptSlot = 'analysis_prompt' | 'system_prompt' | 'execution_prompt';
export interface PromptVersion {
    name: string;
    version: number;
    promptOverlay: string;
    applicableMode: PromptSlot;
    createdAt: number;
    appliedCycle?: string;
    performanceStats?: {
        totalCycles: number;
        successCount: number;
        failCount: number;
        avgScore: number;
    };
    parentVersion: number;
    evolutionReason: string;
}
export declare class PromptEvolutionManager {
    private promptsDir;
    private registry;
    private versions;
    private initialized;
    private persistenceDirty;
    constructor(promptsDir?: string);
    /** 获取指定槽位的当前 overlay 文本 */
    getOverlay(mode: PromptSlot): string;
    /** 获取当前版本号 */
    getCurrentVersion(mode: PromptSlot): number;
    /** 进化 prompt：以当前版本为 parent，追加反模式指令创建新版本 */
    evolvePrompt(mode: PromptSlot, reason: string, antiPatterns: string[]): PromptVersion | null;
    /** 重置到基版本（version 1） */
    resetToBase(mode: PromptSlot): PromptVersion | null;
    /** LLM 驱动的 prompt 进化：分析近期失败并生成针对性反模式指令 */
    llmEvolvePrompt(mode: PromptSlot, reason: string, failureSummary: string, agentRunner: {
        runSelfTask: (prompt: string, system?: string) => Promise<{
            success: boolean;
            summary: string;
        }>;
    }): Promise<PromptVersion | null>;
    recordCycleResult(mode: PromptSlot, version: number, success: boolean, score?: number): void;
    /** 将版本链中所有 overlays 总结为简洁规则，创建新版本 */
    summarizeOverlays(mode: PromptSlot): PromptVersion | null;
    /** 移除低分版本的 overlay 规则，返回清理数 */
    pruneStaleRules(mode: PromptSlot): number;
    /** 判断是否需要总结或清理 */
    shouldCompact(mode: PromptSlot): {
        needSummarize: boolean;
        needPrune: boolean;
    };
    /** 状态摘要（日志用） */
    getRegistrySummary(): string;
    private load;
    private save;
    private seedDefaults;
}
