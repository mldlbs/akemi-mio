import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EvolutionStrategizer } from '../pipeline/EvolutionStrategizer'

vi.mock('../../logger/Logger', () => ({ log: vi.fn() }))

describe('EvolutionStrategizer', () => {
  let strategizer: EvolutionStrategizer

  beforeEach(() => {
    strategizer = new EvolutionStrategizer()
  })

  it('init 状态转换', async () => {
    expect((strategizer as any).state).toBe('created')
    await strategizer.init()
    expect((strategizer as any).state).toBe('ready')
  })

  it('select 返回策略配置', () => {
    const config = strategizer.select({
      consecutiveFailures: 0,
      isFirstRun: true,
      isRecovering: false,
      hoursSinceLastRun: 0,
      isDegenerate: false,
    })
    expect(config.name).toBe('full')
  })

  it('select 退化时返回 review', () => {
    const config = strategizer.select({
      consecutiveFailures: 0,
      isFirstRun: false,
      isRecovering: false,
      hoursSinceLastRun: 24,
      isDegenerate: true,
    })
    expect(config.name).toBe('review')
  })

  it('select 多次失败时返回 review', () => {
    const config = strategizer.select({
      consecutiveFailures: 5,
      isFirstRun: false,
      isRecovering: false,
      hoursSinceLastRun: 24,
      isDegenerate: false,
    })
    expect(config.name).toBe('review')
  })

  it('evaluate 更新策略分', () => {
    strategizer.evaluate('balanced', {
      success: true,
      durationMs: 5000,
      planCreated: true,
      stepsPlanned: 2,
      hadTimeout: false,
      hadRetry: false,
      promptTrimmed: false,
    })
    const learner = strategizer.getLearner()
    expect(learner).toBeDefined()
  })

  it('getFormattedContext 返回非空字符串', () => {
    strategizer.evaluate('balanced', {
      success: true,
      durationMs: 5000,
      planCreated: true,
      stepsPlanned: 2,
      hadTimeout: false,
      hadRetry: false,
      promptTrimmed: false,
    })
    expect(strategizer.getFormattedContext().length).toBeGreaterThan(0)
  })

  it('learn 返回 insight', () => {
    expect(typeof strategizer.learn().insight).toBe('string')
  })

  it('getLearner 返回底层学习器', () => {
    expect(strategizer.getLearner().constructor.name).toBe('EvolutionStrategyLearner')
  })
})
