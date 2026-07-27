/**
 * LorenzSystem — 洛伦兹吸引子测试方程
 *
 * dx/dt = sigma * (y - x)
 * dy/dt = x * (rho - z) - y
 * dz/dt = x * y - beta * z
 *
 * 经典混沌系统，对步长敏感，是测试自适应步长求解器的理想用例。
 * 参数：sigma=10, rho=28, beta=8/3
 */

import type { OdeSystem, FixedStepConfig, AdaptiveStepConfig } from '../solvers/types'

const SIGMA = 10
const RHO = 28
const BETA = 8 / 3

export const lorenzSystem: OdeSystem = {
  name: 'LorenzSystem',
  dimension: 3,

  func: (t: number, y: Float64Array): Float64Array => {
    const x = y[0]
    const yy = y[1]
    const z = y[2]

    const out = new Float64Array(3)
    out[0] = SIGMA * (yy - x)          // dx/dt
    out[1] = x * (RHO - z) - yy        // dy/dt
    out[2] = x * yy - BETA * z         // dz/dt
    return out
  },
}

/** 默认固定步长配置 */
export const lorenzFixedConfig: FixedStepConfig = {
  stepSize: 0.01,
  tStart: 0,
  tEnd: 20,
  y0: new Float64Array([1.0, 1.0, 1.0]),
}

/** 默认自适应配置 */
export const lorenzAdaptiveConfig: AdaptiveStepConfig = {
  initialStepSize: 0.1,
  minStepSize: 1e-6,
  maxStepSize: 0.5,
  tolerance: 1e-6,
  safetyFactor: 0.9,
  tStart: 0,
  tEnd: 20,
  y0: new Float64Array([1.0, 1.0, 1.0]),
}

/**
 * 获取 Lorenz 系统的高精度参考解（使用极小步长 RK4 计算）
 * 用于计算数值误差。
 */
export function getLorenzReferenceSolution(): FixedStepConfig {
  return {
    stepSize: 1e-4,        // 参考解步长
    tStart: 0,
    tEnd: 20,
    y0: new Float64Array([1.0, 1.0, 1.0]),
  }
}
