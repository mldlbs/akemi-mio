/**
 * AdaptiveRK45Solver — 自适应步长 RK45 求解器（Fehlberg 方法）
 *
 * 使用四阶 RK4 与五阶 RK5 的差值作为误差估计，自动调整步长。
 * 是自适应步长求解的代表算法，Evolution 系统将以此为目标模板
 * 升级固定步长求解器。
 *
 * 局部截断误差估计：|rk5 - rk4|
 * 新步长：h_new = h * safety * (tol / err)^(1/4)
 *
 * Butcher 系数（Fehlberg）：
 *   0
 *   1/4        1/4
 *   3/8        3/32       9/32
 *   12/13      1932/2197  -7200/2197  7296/2197
 *   1          439/216    -8          3680/513   -845/4104
 *   1/2        -8/27       2          -3544/2565  1859/4104  -11/40
 *   ─────────────────────────────────────────────────────────────
 *   RK4:       25/216     0          1408/2565   2197/4104  -1/5       0
 *   RK5:       16/135     0          6656/12825  28561/56430 -9/50     2/55
 */

import { log } from '../../../logger/Logger'
import type { OdeSolver, OdeSystem, Solution, AdaptiveStepConfig } from './types'

/**
 * Butcher 系数表 — Fehlberg RK45
 *
 * a[i][j]: j < i 的系数
 * b4[j]:   RK4 权重（误差估计用低阶）
 * b5[j]:   RK5 权重（解用高阶）
 * c[i]:    时间偏移
 */

// 时间偏移 c
const C: number[] = [0, 1 / 4, 3 / 8, 12 / 13, 1, 1 / 2]

// RK4 权重（低阶，用于误差估计）
const B4: number[] = [25 / 216, 0, 1408 / 2565, 2197 / 4104, -1 / 5, 0]

// RK5 权重（高阶，用于推进解）
const B5: number[] = [16 / 135, 0, 6656 / 12825, 28561 / 56430, -9 / 50, 2 / 55]

// K 系数矩阵（展开为平铺数组，每个 stage 的系数列表）
const A: Map<number, number[]> = new Map([
  [0, [1 / 4]],
  [1, [3 / 32, 9 / 32]],
  [2, [1932 / 2197, -7200 / 2197, 7296 / 2197]],
  [3, [439 / 216, -8, 3680 / 513, -845 / 4104]],
  [4, [-8 / 27, 2, -3544 / 2565, 1859 / 4104, -11 / 40]],
])

export class AdaptiveRK45Solver implements OdeSolver {
  readonly name = 'AdaptiveRK45Solver'
  readonly isFixedStep = false
  readonly stepSize: number

  constructor(defaultStepSize: number = 0.1) {
    this.stepSize = defaultStepSize
  }

  async solve(system: OdeSystem, config: AdaptiveStepConfig): Promise<Solution> {
    const {
      initialStepSize: h0,
      minStepSize,
      maxStepSize,
      tolerance: tol,
      safetyFactor: safety,
      tStart,
      tEnd,
      y0,
    } = config

    const dim = system.dimension
    const startTime = process.hrtime.bigint()

    try {
      // 预分配（使用动态数组，步数未知）
      const tValues: number[] = [tStart]
      const yValues: Float64Array[] = [new Float64Array(y0)]
      let h = Math.min(h0, maxStepSize)
      let tCurrent = tStart
      let yCurrent = new Float64Array(y0)
      const MAX_STEPS = 100_000
      let stepCount = 0
      let rejectedCount = 0

      // 临时向量池（重用以减少 GC）
      const k: Float64Array[] = []
      for (let i = 0; i < 6; i++) {
        k.push(new Float64Array(dim))
      }
      const tmp = new Float64Array(dim)

      while (tCurrent < tEnd && stepCount < MAX_STEPS) {
        stepCount++
        const hRemaining = tEnd - tCurrent
        const hActual = Math.min(h, hRemaining)

        // Stage 0: k0 = f(t_n, y_n)
        const f0 = system.func(tCurrent, yCurrent)
        for (let j = 0; j < dim; j++) k[0][j] = f0[j]

        // Stages 1-5
        for (let stage = 1; stage < 6; stage++) {
          // 计算时间偏移
          const ti = tCurrent + C[stage] * hActual

          // 计算 y_i = y_n + sum(a[i][j] * k[j]) * h
          const coeffs = A.get(stage - 1)!
          for (let j = 0; j < dim; j++) {
            let sum = 0
            for (let cIdx = 0; cIdx < coeffs.length; cIdx++) {
              sum += coeffs[cIdx] * k[cIdx][j]
            }
            tmp[j] = yCurrent[j] + hActual * sum
          }

          const fi = system.func(ti, tmp)
          for (let j = 0; j < dim; j++) k[stage][j] = fi[j]
        }

        // 计算 RK4 和 RK5 估计
        const y4 = new Float64Array(dim)
        const y5 = new Float64Array(dim)
        for (let j = 0; j < dim; j++) {
          let sum4 = 0
          let sum5 = 0
          for (let s = 0; s < 6; s++) {
            sum4 += B4[s] * k[s][j]
            sum5 += B5[s] * k[s][j]
          }
          y4[j] = yCurrent[j] + hActual * sum4
          y5[j] = yCurrent[j] + hActual * sum5
        }

        // 误差估计（取最大相对误差）
        let maxErr = 0
        for (let j = 0; j < dim; j++) {
          const absY = Math.max(Math.abs(y5[j]), 1e-10)
          const diff = Math.abs(y5[j] - y4[j])
          const relErr = diff / absY
          if (relErr > maxErr) maxErr = relErr
        }

        // 计算新步长
        if (maxErr < 1e-14) {
          // 误差过小，激进增大步长
          h = Math.min(hActual * 5, maxStepSize)
        } else {
          // h_new = h * safety * (tol / err)^(1/4)
          const ratio = Math.pow(tol / maxErr, 0.25)
          h = Math.min(hActual * safety * ratio, maxStepSize)
        }
        h = Math.max(h, minStepSize)
        h = Math.min(h, maxStepSize)

        // 判断是否接受该步
        if (maxErr <= tol) {
          // 接受 — 使用高阶解（RK5）推进
          tCurrent = Math.min(tCurrent + hActual, tEnd)
          yCurrent = y5
          tValues.push(tCurrent)
          yValues.push(new Float64Array(y5))
        } else {
          rejectedCount++
          // 拒绝 — 缩小步长重试
          continue
        }

        // 动态数组保护
        if (tValues.length > 1_000_000) {
          log('WARN', 'adaptive_rk45_too_many_steps', { steps: tValues.length })
          break
        }
      }

      const endTime = process.hrtime.bigint()
      const elapsedUs = Number(endTime - startTime) / 1000

      const t = new Float64Array(tValues)
      const y = yValues

      log('INFO', 'adaptive_rk45_complete', {
        steps: tValues.length,
        rejected: rejectedCount,
        elapsedUs: Math.round(elapsedUs),
        finalH: h,
      })

      return {
        t,
        y,
        steps: tValues.length,
        elapsedUs,
        success: true,
      }
    } catch (err: any) {
      log('ERROR', 'adaptive_rk45_error', { error: err.message })
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
