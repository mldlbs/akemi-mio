/**
 * IdentityModule 类型定义
 *
 * CoreIdentity — 从 CONSTITUTION.md 冷启动解析的不可变核心自我认知
 * EvolvedTrait — 运行时观测到的可进化特质（随交互积累更新）
 * GrowthMetrics — 运行统计数据，用于驱动 trait 演化
 */
export interface CoreIdentity {
    constitutionHash: string;
    name: string;
    role: string;
    personality: string[];
    capabilities: string[];
    constraints: string[];
    createdAt: number;
    updatedAt: number;
}
export type TraitTrend = 'growing' | 'stable' | 'declining';
export interface EvolvedTrait {
    name: string;
    value: number;
    trend: TraitTrend;
    sampleCount: number;
    updatedAt: number;
}
export declare const DEFAULT_TRAITS: EvolvedTrait[];
export interface GrowthMetrics {
    sessionsCompleted: number;
    toolsUsed: number;
    goalsCompleted: number;
    goalsDrifted: number;
    avgScore: number;
    constitutionChecksum: string;
    lastUpdated: number;
}
export type SessionType = 'chat' | 'development' | 'evolution' | 'maintenance';
export interface TraitUpdateInput {
    /** 本次成功/失败的绝对值（0-1） */
    score: number;
    /** 更新原因标签 */
    reason: string;
    /** 工具名或目标类别（可选） */
    context?: string;
}
export declare function rowToCoreIdentity(row: Record<string, any>): CoreIdentity;
export declare function rowToEvolvedTrait(row: Record<string, any>): EvolvedTrait;
export declare function rowToGrowthMetrics(row: Record<string, any>): GrowthMetrics;
