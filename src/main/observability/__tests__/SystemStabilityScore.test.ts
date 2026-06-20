/**
 * SystemStabilityScore 测试
 *
 * 验证六因子乘法模型、趋势检测、健康/临界状态判断和推荐策略。
 */
import { describe, it, expect } from 'vitest'

import { SystemStabilityScore } from '../SystemStabilityScore'
import type { StabilityFactors } from '../SystemStabilityScore'

describe('SystemStabilityScore', () => {
  it('初始值为 100', () => {
    const ss = new SystemStabilityScore()
    expect(ss.getScore()).toBe(100)
  })

  it('全 1 因子 equals 100', () => {
    const ss = new SystemStabilityScore()
    const factors: StabilityFactors = {
      memoryHealth: 1,
      taskFlowEfficiency: 1,
      schedulerBalance: 1,
      evolutionRiskControl: 1,
      errorRateInverse: 1,
      guardrailHealth: 1,
    }
    expect(ss.compute(factors)).toBe(100)
  })

  it('0.5 因子计算正确 (0.5^6 * 100 ≈ 1.56)', () => {
    const ss = new SystemStabilityScore()
    const factors: StabilityFactors = {
      memoryHealth: 0.5,
      taskFlowEfficiency: 0.5,
      schedulerBalance: 0.5,
      evolutionRiskControl: 0.5,
      errorRateInverse: 0.5,
      guardrailHealth: 0.5,
    }
    expect(ss.compute(factors)).toBe(2)
  })

  it('isHealthy 返回 true 当 >= 70', () => {
    const ss = new SystemStabilityScore()
    expect(ss.isHealthy()).toBe(true)
    // 0.95^6 = 0.735 → score 74 → healthy
    ss.compute({
      memoryHealth: 0.95,
      taskFlowEfficiency: 0.95,
      schedulerBalance: 0.95,
      evolutionRiskControl: 0.95,
      errorRateInverse: 0.95,
      guardrailHealth: 0.95,
    })
    expect(ss.isHealthy()).toBe(true)
  })

  it('isCritical 返回 true 当 < 40', () => {
    const ss = new SystemStabilityScore()
    ss.compute({
      memoryHealth: 0.3,
      taskFlowEfficiency: 0.3,
      schedulerBalance: 0.3,
      evolutionRiskControl: 0.3,
      errorRateInverse: 0.3,
      guardrailHealth: 0.3,
    })
    expect(ss.isCritical()).toBe(true)
  })

  it('临界状态下给出降级建议', () => {
    const ss = new SystemStabilityScore()
    ss.compute({
      memoryHealth: 0.3,
      taskFlowEfficiency: 0.3,
      schedulerBalance: 0.3,
      evolutionRiskControl: 0.3,
      errorRateInverse: 0.3,
      guardrailHealth: 0.3,
    })
    const recs = ss.getRecommendations()
    expect(recs.length).toBeGreaterThanOrEqual(3)
    expect(recs.some((r) => r.includes('停止'))).toBe(true)
  })

  it('健康状态下给出常规建议', () => {
    const ss = new SystemStabilityScore()
    const recs = ss.getRecommendations()
    expect(recs.length).toBeGreaterThanOrEqual(1)
    expect(recs.some((r) => r.includes('稳定') || r.includes('极佳'))).toBe(true)
  })

  describe('趋势检测', () => {
    it('不足 20 个点时返回 stable', () => {
      const ss = new SystemStabilityScore()
      expect(ss.getTrend()).toBe('stable')
    })

    it('持续上升返回 improving', () => {
      const ss = new SystemStabilityScore()
      for (let i = 0; i < 10; i++) {
        ss.compute({
          memoryHealth: 0.4,
          taskFlowEfficiency: 0.4,
          schedulerBalance: 0.4,
          evolutionRiskControl: 0.4,
          errorRateInverse: 0.4,
          guardrailHealth: 0.4,
        })
      }
      for (let i = 0; i < 10; i++) {
        ss.compute({
          memoryHealth: 0.95,
          taskFlowEfficiency: 0.95,
          schedulerBalance: 0.95,
          evolutionRiskControl: 0.95,
          errorRateInverse: 0.95,
          guardrailHealth: 0.95,
        })
      }
      expect(ss.getTrend()).toBe('improving')
    })

    it('持续下降返回 declining', () => {
      const ss = new SystemStabilityScore()
      for (let i = 0; i < 10; i++) {
        ss.compute({
          memoryHealth: 0.95,
          taskFlowEfficiency: 0.95,
          schedulerBalance: 0.95,
          evolutionRiskControl: 0.95,
          errorRateInverse: 0.95,
          guardrailHealth: 0.95,
        })
      }
      for (let i = 0; i < 10; i++) {
        ss.compute({
          memoryHealth: 0.3,
          taskFlowEfficiency: 0.3,
          schedulerBalance: 0.3,
          evolutionRiskControl: 0.3,
          errorRateInverse: 0.3,
          guardrailHealth: 0.3,
        })
      }
      expect(ss.getTrend()).toBe('declining')
    })
  })

  describe('getStatus', () => {
    it('>= 70 返回 healthy', () => {
      const ss = new SystemStabilityScore()
      expect(ss.getStatus()).toBe('healthy')
    })

    it('40-69 返回 degraded', () => {
      const ss = new SystemStabilityScore()
      // 0.88^6 = 0.464 → raw 46, smoothing converges to ~46 → degraded
      const factors: StabilityFactors = {
        memoryHealth: 0.88,
        taskFlowEfficiency: 0.88,
        schedulerBalance: 0.88,
        evolutionRiskControl: 0.88,
        errorRateInverse: 0.88,
        guardrailHealth: 0.88,
      }
      for (let i = 0; i < 20; i++) ss.compute(factors)
      expect(ss.getStatus()).toBe('degraded')
    })

    it('< 40 返回 critical', () => {
      const ss = new SystemStabilityScore()
      ss.compute({
        memoryHealth: 0.3,
        taskFlowEfficiency: 0.3,
        schedulerBalance: 0.3,
        evolutionRiskControl: 0.3,
        errorRateInverse: 0.3,
        guardrailHealth: 0.3,
      })
      expect(ss.getStatus()).toBe('critical')
    })
  })

  it('getHistory 返回所有历史点', () => {
    const ss = new SystemStabilityScore()
    ss.compute({
      memoryHealth: 0.9,
      taskFlowEfficiency: 0.9,
      schedulerBalance: 0.9,
      evolutionRiskControl: 0.9,
      errorRateInverse: 0.9,
      guardrailHealth: 0.9,
    })
    ss.compute({
      memoryHealth: 0.8,
      taskFlowEfficiency: 0.8,
      schedulerBalance: 0.8,
      evolutionRiskControl: 0.8,
      errorRateInverse: 0.8,
      guardrailHealth: 0.8,
    })
    expect(ss.getHistory().length).toBe(2)
  })

  it('历史点数不超过 60 个', () => {
    const ss = new SystemStabilityScore()
    for (let i = 0; i < 100; i++) {
      ss.compute({
        memoryHealth: 0.9,
        taskFlowEfficiency: 0.9,
        schedulerBalance: 0.9,
        evolutionRiskControl: 0.9,
        errorRateInverse: 0.9,
        guardrailHealth: 0.9,
      })
    }
    expect(ss.getHistory().length).toBeLessThanOrEqual(60)
  })
})
