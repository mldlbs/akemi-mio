import type { CreativitySource } from './types';
/**
 * SourceBuilder — 每轮创造力周期动态构建来源
 *
 * 相比旧版 AppRuntime 的静态字符串，这里注入：
 * 1. 来自各模块的实际运行数据（延迟、计数、错误率）
 * 2. 外部 Provocation 概念（跨领域刺激 + 反向约束）
 * 3. 已拒绝思路的重组片段
 */
export declare class SourceBuilder {
    private rng;
    /** Provocation 池：外部领域概念 — 不是类比，而是冲突/极限/失效 */
    private domainConcepts;
    /** Provocation 池：反向约束 */
    private constraints;
    /** 已经用过的 provocation 索引 */
    private usedProvocations;
    private usedConstraints;
    constructor(seed?: number);
    /**
     * 构建一轮创造力来源
     * @param moduleData 各模块运行时数据
     * @param rejectedIdeas 最近被拒绝的假设片段
     */
    build(moduleData: {
        memory?: {
            entryCount: number;
            recentTopics: string[];
            lastAddedAt: number;
        };
        userBehavior?: {
            interactionCount: number;
            recentLabels: string[];
            peakHours: string;
        };
        asr?: {
            avgLatencyMs: number;
            errorRate: number;
            domainTerms: string[];
        };
        tts?: {
            charsSynthesized: number;
            queueLength: number;
        };
        agent?: {
            toolCalls: number;
            successRate: number;
            topTools: string[];
        };
        evolution?: {
            generation: number;
            strategyCount: number;
            recentEvents: string[];
        };
        observer?: {
            trends: string[];
            insights: string[];
        };
    }, rejectedIdeas?: string[], worldTrends?: string[]): CreativitySource[];
    /**
     * 从 domain 概念池中选一个未用过的
     */
    private pickProvocation;
    /**
     * 从约束池中选一个未用过的
     */
    private pickConstraint;
    /** 重置 provocation 使用记录（新梦周期触发） */
    resetProvocations(): void;
}
