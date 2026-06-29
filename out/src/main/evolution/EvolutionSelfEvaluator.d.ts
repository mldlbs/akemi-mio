/**
 * EvolutionSelfEvaluator — 进化自评估器
 *
 * 在分析 cycle 完成后，对输出的质量进行自我评估。
 * 四个维度，纯本地字符串分析，无额外 LLM 调用。
 */
import type { EngineeringMemory } from '../memory/EngineeringMemory';
export interface SelfEvaluationResult {
    score: number;
    timestamp: number;
    strategyName: string;
    analysisMode: string;
    dimensions: {
        planQuality: number;
        analysisDiversity: number;
        strategyCompliance: number;
        substantiveLength: number;
    };
    feedback: string[];
    outcome?: boolean;
}
export declare class EvolutionSelfEvaluator {
    private recentEvaluations;
    private maxHistory;
    private engineering;
    constructor(historyMaxEntries?: number);
    injectEngineering(eng: EngineeringMemory): void;
    /** 事后记录该次演化的实际结果（plan 是否成功执行） */
    recordOutcome(score: number, succeeded: boolean): void;
    /** 评估器校准：对比评分与实际成功率 */
    getCalibration(): {
        bias: number;
        sampleSize: number;
        isReliable: boolean;
    };
    evaluate(params: {
        strategyName: string;
        promptMode: string;
        analysisSummary: string;
        planCreated: boolean;
        planSteps: string[];
        recentHistory: string[];
        analysisMode: string;
    }): SelfEvaluationResult;
    getRecentEvaluations(count?: number): SelfEvaluationResult[];
    /** 跨周期趋势分析：比较最近 5 次与前 5 次的分数变化 */
    getTrend(): 'upward' | 'downward' | 'stagnant' | 'volatile' | 'insufficient_data';
    /** 识别持续薄弱的维度，为策略变异提供目标 */
    getStrategyRecommendation(): {
        targetDimension: string | null;
        avgDimScores: Record<string, number>;
        trend: string;
    };
    /** 计划质量：步骤描述中是否包含实际文件引用 */
    private evaluatePlanQuality;
    /** 分析多样性：与近期历史摘要的 Jaccard 相似度 */
    private evaluateDiversity;
    /** 策略合规 */
    private evaluateStrategyCompliance;
    /** 摘要长度：是否足够详细 */
    private evaluateSubstantiveLength;
    private tokenize;
}
