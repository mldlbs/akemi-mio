/**
 * EvolutionStrategizer — 进化流水线 Stage 2
 *
 * 职责：基于上下文选择进化策略，记录策略评分，提供策略报告
 * 封装 EvolutionStrategyLearner，暴露 ISubsystem 接口
 */
import { EvolutionStrategyLearner } from '../EvolutionStrategy';
import type { StrategyConfig, CycleEvaluation } from '../EvolutionStrategy';
import type { ISubsystem, HealthCheckResult, SubsystemState } from '../../core/lifecycle/types';
import type { StrategyContext } from './types';
export declare class EvolutionStrategizer implements ISubsystem {
    readonly name = "EvolutionStrategizer";
    state: SubsystemState;
    private learner;
    constructor(options?: {
        scoreFilePath?: string;
    });
    init(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    destroy(): Promise<void>;
    healthCheck(): Promise<HealthCheckResult>;
    /** 根据上下文选择最优策略 */
    select(context: StrategyContext): StrategyConfig;
    /** 循环结束后评分 */
    evaluate(strategyName: string, evalResult: CycleEvaluation): void;
    /** 获取格式化策略报告 */
    getFormattedContext(): string;
    /** 元进化分析 */
    learn(): {
        recommendation?: string;
        insight: string;
    };
    /** 获取原始学习者（高级用） */
    getLearner(): EvolutionStrategyLearner;
}
