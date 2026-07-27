/**
 * RK4Solver — 固定步长经典龙格-库塔法求解器
 *
 * 四阶 Runge-Kutta 方法。局部截断误差 O(h^5)，全局误差 O(h^4)。
 *
 * k1 = f(t_n, y_n)
 * k2 = f(t_n + h/2, y_n + h*k1/2)
 * k3 = f(t_n + h/2, y_n + h*k2/2)
 * k4 = f(t_n + h, y_n + h*k3)
 * y_{n+1} = y_n + h/6 * (k1 + 2*k2 + 2*k3 + k4)
 *
 * Evolution 目标：该求解器的步长参数将被 SolverScannerCollector 识别，
 * 并由 AdaptiveSolverExecutor 升级为自适应步长版本（RK45）。
 */

import { log } from '../../../logger/Logger'
import type { OdeSolver, OdeSystem, Solution, FixedStepConfig } from './types'

export class RK4Solver implements OdeSolver {
  readonly name = 'RK4Solver'
  readonly isFixedStep = true
  readonly stepSize: number

  constructor(defaultStepSize: number = 0.01) {
    this.stepSize = defaultStepSize
  }

  async solve(system: OdeSystem, config: FixedStepConfig): Promise<Solution> {
    const { stepSize: h, tStart, tEnd, y0 } = config
    const dim = system.dimension
    const steps = Math.ceil((tEnd - tStart) / h)
    const startTime = process.hrtime.bigint()

    try {
      // 预分配结果数组
      const t = new Float64Array(steps + 1)
      const y: Float64Array[] = new Array(steps + 1)
      t[0] = tStart
      y[0] = new Float64Array(y0)

      // 临时向量（避免重复分配）
      const k1 = new Float64Array(dim)
      const k2 = new Float64Array(dim)
      const k3 = new Float64Array(dim)
      const k4 = new Float64Array(dim)
      const tmp1 = new Float64Array(dim)
      const tmp2 = new Float64Array(dim)

      // 主循环：固定步长 RK4
      for (let i = 0; i < steps; i++) {
        const currentT = t[i]
        const currentY = y[i]

        // k1 = f(t_n, y_n)
        const f1 = system.func(currentT, currentY)
        for (let j = 0; j < dim; j++) k1[j] = f1[j]

        // k2 = f(t_n + h/2, y_n + h*k1/2)
        const halfH = h * 0.5
        for (let j = 0; j < dim; j++) tmp1[j] = currentY[j] + halfH * k1[j]
        const f2 = system.func(currentT + halfH, tmp1)
        for (let j = 0; j < dim; j++) k2[j] = f2[j]

        // k3 = f(t_n + h/2, y_n + h*k2/2)
        for (let j = 0; j < dim; j++) tmp2[j] = currentY[j] + halfH * k2[j]
        const f3 = system.func(currentT + halfH, tmp2)
        for (let j = 0; j < dim; j++) k3[j] = f3[j]

        // k4 = f(t_n + h, y_n + h*k3)
        for (let j = 0; j < dim; j++) tmp1[j] = currentY[j] + h * k3[j]
        const f4 = system.func(currentT + h, tmp1)
        for (let j = 0; j < dim; j++) k4[j] = f4[j]

        // y_{n+1} = y_n + h/6 * (k1 + 2*k2 + 2*k3 + k4)
        const nextY = new Float64Array(dim)
        const h6 = h / 6
        for (let j = 0; j < dim; j++) {
          nextY[j] = currentY[j] + h6 * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j])
        }

        t[i + 1] = currentT + h
        y[i + 1] = nextY
      }

      const endTime = process.hrtime.bigint()
      const elapsedUs = Number(endTime - startTime) / 1000

      return {
        t,
        y,
        steps: steps + 1,
        elapsedUs,
        success: true,
      }
    } catch (err: any) {
      log('ERROR', 'rk4_solver_error', { error: err.message })
      return {
        t: new Float64Array(0),
        y: [],
        steps: 0,
        elapsedUs: 0,
        success: false,
        error: err.message,
      }
    }
  }
}
