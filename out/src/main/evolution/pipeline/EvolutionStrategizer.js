/**
 * EvolutionStrategizer — 进化流水线 Stage 2
 *
 * 职责：基于上下文选择进化策略，记录策略评分，提供策略报告
 * 封装 EvolutionStrategyLearner，暴露 ISubsystem 接口
 */
import { log } from '../../logger/Logger';
import { EvolutionStrategyLearner } from '../EvolutionStrategy';
export class EvolutionStrategizer {
    constructor(options) {
        this.name = 'EvolutionStrategizer';
        this.state = 'created';
        this.learner = new EvolutionStrategyLearner(options?.scoreFilePath);
    }
    async init() {
        this.state = 'initializing';
        log('INFO', 'evolution_strategizer.init');
        this.state = 'ready';
    }
    async start() {
        this.state = 'running';
    }
    async stop() {
        this.state = 'ready';
    }
    async destroy() {
        this.state = 'stopped';
    }
    async healthCheck() {
        return { healthy: true };
    }
    /** 根据上下文选择最优策略 */
    select(context) {
        return this.learner.select(context);
    }
    /** 循环结束后评分 */
    evaluate(strategyName, evalResult) {
        this.learner.evaluate(strategyName, evalResult);
    }
    /** 获取格式化策略报告 */
    getFormattedContext() {
        return this.learner.getFormattedContext();
    }
    /** 元进化分析 */
    learn() {
        return this.learner.learn();
    }
    /** 获取原始学习者（高级用） */
    getLearner() {
        return this.learner;
    }
}
