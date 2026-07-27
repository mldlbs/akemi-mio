/**
 * StiffSystem — 刚性方程测试
 *
 * y' = -1000 * y + sin(t)
 * y(0) = 1
 *
 * 该方程具有快变分量（-1000y）和慢变分量（sin(t)），
 * 经典显式 Euler 法需要极小步长才能稳定。
 * 自适应步长求解器应能自动减小步长通过刚性区域。
 *
 * 解析解：y(t) = (1001/1000001) * sin(t) - (1000/1000001) * cos(t) + (1000000/1000001) * exp(-1000t)
 * 当 t 较大时，exp(-1000t) → 0，解趋近于稳态震荡。
 */

import type { OdeSystem, FixedStepConfig, AdaptiveStepConfig } from '../solvers/types'

export const stiffSystem: OdeSystem = {
  name: 'StiffEquation',
  dimension: 1,

  func: (t: number, y: Float64Array): Float64Array => {
    const out = new Float64Array(1)
    out[0] = -1000 * y[0] + Math.sin(t)
    return out
  },
}

/** 解析解（用于误差比较） */
export function stiffAnalyticSolution(t: number): number {
  const expTerm = Math.exp(-1000 * t)
  const sinTerm = (1001 / 1000001) * Math.sin(t)
  const cosTerm = (1000 / 1000001) * Math.cos(t)
  const expCoeff = 1000000 / 1000001
  return sinTerm - cosTerm + expCoeff * expTerm
}

/** 默认固定步长配置（Euler 需要极小的步长才稳定） */
export const stiffFixedConfig: FixedStepConfig = {
  stepSize: 0.0001,
  tStart: 0,
  tEnd: 0.1,
  y0: new Float64Array([1.0]),
}

/** 默认自适应配置 */
export const stiffAdaptiveConfig: AdaptiveStepConfig = {
  initialStepSize: 0.01,
  minStepSize: 1e-8,
  maxStepSize: 0.1,
  tolerance: 1e-8,
  safetyFactor: 0.85,
  tStart: 0,
  tEnd: 0.1,
  y0: new Float64Array([1.0]),
}
