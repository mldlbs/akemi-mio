/**
 * EvolutionStrategizer — 进化流水线 Stage 2
 *
 * 职责：基于上下文选择进化策略，记录策略评分，提供策略报告
 * 封装 EvolutionStrategyLearner，暴露 ISubsystem 接口
 */

import { log } from '../../logger/Logger'
import { EvolutionStrategyLearner } from '../EvolutionStrategy'
import type { StrategyConfig, CycleEvaluation } from '../EvolutionStrategy'
import type { ISubsystem, HealthCheckResult, SubsystemState } from '../../core/lifecycle/types'
import type { StrategyContext } from './types'

export class EvolutionStrategizer implements ISubsystem {
  readonly name = 'EvolutionStrategizer'
  state: SubsystemState = 'created'

  private learner: EvolutionStrategyLearner

  constructor(options?: { scoreFilePath?: string }) {
    this.learner = new EvolutionStrategyLearner(options?.scoreFilePath)
  }

  async init(): Promise<void> {
    this.state = 'initializing'
    log('INFO', 'evolution_strategizer.init')
    this.state = 'ready'
  }

  async start(): Promise<void> {
    this.state = 'running'
  }
  async stop(): Promise<void> {
    this.state = 'ready'
  }
  async destroy(): Promise<void> {
    this.state = 'stopped'
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return { healthy: true }
  }

  /** 根据上下文选择最优策略 */
  select(context: StrategyContext): StrategyConfig {
    return this.learner.select(context)
  }

  /** 循环结束后评分 */
  evaluate(strategyName: string, evalResult: CycleEvaluation): void {
    this.learner.evaluate(strategyName, evalResult)
  }

  /** 获取格式化策略报告 */
  getFormattedContext(): string {
    return this.learner.getFormattedContext()
  }

  /** 元进化分析 */
  learn(): { recommendation?: string; insight: string } {
    return this.learner.learn()
  }

  /** 获取原始学习者（高级用） */
  getLearner(): EvolutionStrategyLearner {
    return this.learner
  }
}
