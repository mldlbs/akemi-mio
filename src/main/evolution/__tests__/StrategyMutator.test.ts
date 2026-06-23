import { describe, it, expect } from 'vitest'
import { EvolutionStrategyLearner, StrategyMutator, type StrategyConfig } from '../EvolutionStrategy'

/** 创建一个已有一个非默认策略的 mutator */
function createMutator(): { mutator: StrategyMutator; history: Array<any> } {
  const learner = new EvolutionStrategyLearner()
  // Access the internal strategies map via mutate (first call tries seeding)
  const mutator = learner.getMutator()
  const history = Array.from({ length: 15 }, () => ({
    strategy: 'balanced',
    eval: { success: true, durationMs: 1000, planCreated: true, stepsPlanned: 2, hadTimeout: false, hadRetry: false, promptTrimmed: false },
  }))
  // Manually add a non-default strategy so mutate() has viable candidates
  const strategies: Map<string, StrategyConfig> = (mutator as any).strategies
  const scores: Map<string, any> = (mutator as any).scores
  strategies.set('_test_v1', {
    name: '_test_v1',
    description: 'test child',
    promptMode: 'balanced',
    timeoutMs: 120000,
    trimMode: false,
    maxHistoryEntries: 3,
    safetyMode: 'auto',
    degenerationThreshold: 3,
  })
  scores.set('_test_v1', {
    strategyName: '_test_v1',
    score: 60,
    samples: 3,
    avgSuccessRate: 0.7,
    avgExecutionMs: 1000,
    lastUsed: Date.now(),
    createdAt: Date.now(),
  })
  return { mutator, history }
}

describe('StrategyMutator', () => {
  it('targetDimension planQuality 变异 promptMode', () => {
    const { mutator, history } = createMutator()
    let foundTargeted = false
    for (let i = 0; i < 20; i++) {
      const m = mutator.mutate(history, 'planQuality')
      if (m && (m.reason === 'promptMode' || m.reason === 'timeoutMs')) foundTargeted = true
    }
    expect(foundTargeted).toBe(true)
  })

  it('targetDimension analysisDiversity 变异 degenerationThreshold', () => {
    const { mutator, history } = createMutator()
    let foundTargeted = false
    for (let i = 0; i < 20; i++) {
      const m = mutator.mutate(history, 'analysisDiversity')
      if (m && (m.reason === 'degenerationThreshold' || m.reason === 'maxHistoryEntries')) foundTargeted = true
    }
    expect(foundTargeted).toBe(true)
  })

  it('无 targetDimension 时行为不变', () => {
    const { mutator, history } = createMutator()
    const results: string[] = []
    for (let i = 0; i < 5; i++) {
      const m = mutator.mutate(history)
      if (m && m.reason) results.push(m.reason)
    }
    expect(results.length).toBeGreaterThan(0)
  })
})
