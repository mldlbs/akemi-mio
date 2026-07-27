/**
 * EulerSolver — 固定步长欧拉法求解器
 *
 * y_{n+1} = y_n + h * f(t_n, y_n)
 *
 * Evolution 目标：该求解器的步长参数将被 SolverScannerCollector 识别，
 * 并由 AdaptiveSolverExecutor 升级为自适应步长版本。
 */

import { log } from '../../../logger/Logger'
import type { OdeSolver, OdeSystem, Solution, FixedStepConfig } from './types'

export class EulerSolver implements OdeSolver {
  readonly name = 'EulerSolver'
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

      // 主循环：固定步长欧拉法
      for (let i = 0; i < steps; i++) {
        const currentT = t[i]
        const currentY = y[i]

        // 计算导数 k = f(t_n, y_n)
        const k = system.func(currentT, currentY)

        // y_{n+1} = y_n + h * k
        const nextY = new Float64Array(dim)
        for (let j = 0; j < dim; j++) {
          nextY[j] = currentY[j] + h * k[j]
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
      log('ERROR', 'euler_solver_error', { error: err.message })
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
