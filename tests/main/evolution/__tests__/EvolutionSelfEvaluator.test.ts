import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EvolutionSelfEvaluator } from '@akemi-mio/evolution/EvolutionSelfEvaluator'

describe('EvolutionSelfEvaluator', () => {
  let evaluator: EvolutionSelfEvaluator

  beforeEach(() => {
    evaluator = new EvolutionSelfEvaluator(20)
  })

  it('evaluate 返回加权分数', () => {
    const r = evaluator.evaluate({
      strategyName: 'balanced',
      promptMode: 'full',
      analysisSummary: '分析了三个模块的性能问题，提出了优化方案，涉及 src/core/EventBus.ts 和 packages/intelligence/src/agent/ChatExecutor.ts',
      planCreated: true,
      planSteps: ['优化 EventBus.ts 的事件分发', '重写 ChatExecutor.ts 的 toolLoop'],
      recentHistory: ['之前分析了 UI 组件'],
      analysisMode: 'auto',
    })
    expect(r.score).toBeGreaterThanOrEqual(0)
    expect(r.score).toBeLessThanOrEqual(100)
    expect(r.dimensions.planQuality).toBeGreaterThanOrEqual(0)
    expect(r.dimensions.analysisDiversity).toBeGreaterThanOrEqual(0)
    expect(r.dimensions.strategyCompliance).toBeGreaterThanOrEqual(0)
    expect(r.dimensions.substantiveLength).toBeGreaterThanOrEqual(0)
  })

  it('planQuality 对无引用的计划扣分', () => {
    const r = evaluator.evaluate({
      strategyName: 'full',
      promptMode: 'full',
      analysisSummary: 'test',
      planCreated: true,
      planSteps: ['做一些改进'],
      recentHistory: [],
      analysisMode: 'auto',
    })
    expect(r.dimensions.planQuality).toBeLessThanOrEqual(50)
  })

  it('analysisDiversity 检测重复内容', () => {
    const r = evaluator.evaluate({
      strategyName: 'quick',
      promptMode: 'minimal',
      analysisSummary: '测试',
      planCreated: false,
      planSteps: [],
      recentHistory: ['测试'],
      analysisMode: 'auto',
    })
    expect(r.dimensions.analysisDiversity).toBeLessThan(100)
  })

  it('getHotTrend 在数据不足时返回 insufficient_data', () => {
    expect(evaluator.getTrend()).toBe('insufficient_data')
  })

  it('getStrategyRecommendation 识别薄弱维度', () => {
    for (let i = 0; i < 5; i++) {
      evaluator.evaluate({
        strategyName: 'quick',
        promptMode: 'minimal',
        analysisSummary: '很短',
        planCreated: false,
        planSteps: [],
        recentHistory: ['相同内容'],
        analysisMode: 'auto',
      })
    }
    const rec = evaluator.getStrategyRecommendation()
    expect(rec.avgDimScores).toBeDefined()
    expect(Object.keys(rec.avgDimScores).length).toBeGreaterThan(0)
  })

  it('recordOutcome 记录事后结果', () => {
    const r = evaluator.evaluate({
      strategyName: 'full',
      promptMode: 'full',
      analysisSummary: '分析了 src/core/EventBus.ts',
      planCreated: true,
      planSteps: ['修改 EventBus.ts'],
      recentHistory: [],
      analysisMode: 'auto',
    })
    evaluator.recordOutcome(r.score, true)
    const cal = evaluator.getCalibration()
    expect(cal.sampleSize).toBe(1)
  })

  it('getCalibration 在样本不足时返回不可靠', () => {
    const cal = evaluator.getCalibration()
    expect(cal.isReliable).toBe(false)
  })

  it('getCalibration 在足够样本后计算偏差', () => {
    for (let i = 0; i < 5; i++) {
      const r = evaluator.evaluate({
        strategyName: 'balanced',
        promptMode: 'full',
        analysisSummary: '测试',
        planCreated: false,
        planSteps: [],
        recentHistory: [],
        analysisMode: 'auto',
      })
      evaluator.recordOutcome(r.score, i < 3)
    }
    const cal = evaluator.getCalibration()
    expect(cal.sampleSize).toBe(5)
    expect(typeof cal.bias).toBe('number')
    expect(cal.isReliable).toBe(true)
  })
})
