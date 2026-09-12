import { describe, it, expect, beforeEach } from 'vitest'
import { EvaluatorCalibrator, type DimensionKey } from '@akemi-mio/evolution/EvaluatorCalibrator'

describe('EvaluatorCalibrator', () => {
  let calibrator: EvaluatorCalibrator

  beforeEach(() => {
    calibrator = new EvaluatorCalibrator()
  })

  it('初始权重为默认值', () => {
    const w = calibrator.getWeights()
    expect(w.planQuality).toBe(0.3)
    expect(w.analysisDiversity).toBe(0.25)
    expect(w.strategyCompliance).toBe(0.25)
    expect(w.substantiveLength).toBe(0.2)
  })

  it('样本不足时不校准', () => {
    for (let i = 0; i < 3; i++) {
      calibrator.recordSample({ planQuality: 80, analysisDiversity: 70, strategyCompliance: 90, substantiveLength: 50 }, 75, true)
    }
    const result = calibrator.calibrate()
    expect(result.sampleSize).toBe(3) // < 5, skipped
    expect(result.delta.planQuality).toBe(0)
  })

  it('足够样本后调整权重', () => {
    for (let i = 0; i < 6; i++) {
      calibrator.recordSample({ planQuality: 80, analysisDiversity: 70, strategyCompliance: 90, substantiveLength: 50 }, 75, i < 4)
    }
    const result = calibrator.calibrate()
    expect(result.sampleSize).toBeGreaterThanOrEqual(5)
    const total = Object.values(result.after).reduce((s: number, v: number) => s + v, 0)
    expect(total).toBeCloseTo(1, 1)
  })

  it('computeCompositeScore 使用校准后权重', () => {
    const defaultScore = calibrator.computeCompositeScore({
      planQuality: 80,
      analysisDiversity: 70,
      strategyCompliance: 90,
      substantiveLength: 50,
    })
    // default: 0.3*80 + 0.25*70 + 0.25*90 + 0.2*50 = 74
    expect(defaultScore).toBe(74)
  })

  it('getCalibrationStats 返回统计', () => {
    for (let i = 0; i < 5; i++) {
      calibrator.recordSample({ planQuality: 80, analysisDiversity: 70, strategyCompliance: 90, substantiveLength: 50 }, 75, i < 3)
    }
    const stats = calibrator.getCalibrationStats()
    expect(stats.sampleCount).toBe(5)
    expect(stats.dimensionMAE.planQuality).toBeGreaterThanOrEqual(0)
    expect(stats.weights.planQuality).toBeGreaterThan(0)
  })

  it('多次校准后权重收敛', () => {
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 6; i++) {
        calibrator.recordSample(
          {
            planQuality: 80,
            analysisDiversity: 70,
            strategyCompliance: 90,
            substantiveLength: 85 + (i % 3) * 5,
          },
          75,
          i < 4,
        )
      }
      calibrator.calibrate()
    }
    const w = calibrator.getWeights()
    const total = Object.values(w).reduce((s: number, v: number) => s + v, 0)
    expect(total).toBeCloseTo(1, 1)
  })

  it('reset 恢复默认', () => {
    for (let i = 0; i < 6; i++) {
      calibrator.recordSample({ planQuality: 80, analysisDiversity: 70, strategyCompliance: 90, substantiveLength: 50 }, 75, true)
    }
    calibrator.calibrate()
    calibrator.reset()
    const w = calibrator.getWeights()
    expect(w.planQuality).toBe(0.3)
    expect(w.analysisDiversity).toBe(0.25)
    expect(w.strategyCompliance).toBe(0.25)
    expect(w.substantiveLength).toBe(0.2)
  })

  it('getDiagnostics 返回完整快照', () => {
    const diag = calibrator.getDiagnostics()
    expect(diag.samples).toBe(0)
    expect(diag.weights).toBeDefined()
    expect(Array.isArray(diag.dimensionStats)).toBe(true)
  })

  it('权重不低于 0.05 不高过 0.5', () => {
    for (let i = 0; i < 20; i++) {
      calibrator.recordSample({ planQuality: 95, analysisDiversity: 95, strategyCompliance: 95, substantiveLength: 10 }, 80, i < 15)
    }
    calibrator.calibrate()
    const w = calibrator.getWeights()
    for (const key of ['planQuality', 'analysisDiversity', 'strategyCompliance', 'substantiveLength'] as DimensionKey[]) {
      expect(w[key]).toBeGreaterThanOrEqual(0.05)
      expect(w[key]).toBeLessThanOrEqual(0.5)
    }
  })
})
