import { log } from '@akemi-mio/core/logger/Logger'
import type { OdeSolver, OdeSystem, Solution, AdaptiveStepConfig } from './types'

/**
 * RK4Solver — 自适应步长 RK45（Fehlberg）求解器
 *
 * 采用 Fehlberg 6-stage 嵌入格式：
 *   低阶解（RK4）用于误差估计
 *   高阶解（RK5）用于推进
 *
 * 步长控制器基于局部误差估计：
 *   err = max_i |y5_i - y4_i|
 * 若 err <= tolerance，则接受步长，并使用 y5 推进；
 * 否则拒绝步长，并缩小步长重新尝试。
 */
export class RK4Solver implements OdeSolver {
  readonly name = 'RK4Solver'
  readonly isFixedStep = false
  readonly stepSize: number

  private readonly minStepSize: number
  private readonly maxStepSize: number
  private readonly tolerance: number
  private readonly safetyFactor = 0.9

  constructor(config: AdaptiveStepConfig = {} as AdaptiveStepConfig) {
    this.stepSize = config.initialStepSize ?? 0.01
    this.minStepSize = config.minStepSize ?? 1e-12
    this.maxStepSize = config.maxStepSize ?? 0.1
    this.tolerance = config.tolerance ?? 1e-6
  }

  async solve(system: OdeSystem, config: AdaptiveStepConfig): Promise<Solution> {
    const tStart = config.tStart ?? 0
    const tEnd = config.tEnd ?? 1
    const y0 = config.y0 ?? new Float64Array(0)
    let h = config.initialStepSize ?? this.stepSize

    const minStepSize = config.minStepSize ?? this.minStepSize
    const maxStepSize = config.maxStepSize ?? this.maxStepSize
    const tolerance = config.tolerance ?? this.tolerance

    const dim = system.dimension
    const startTime = process.hrtime.bigint()

    try {
      const t: number[] = [tStart]
      const y: Float64Array[] = [new Float64Array(y0)]

      let currentT = tStart
      let currentY = new Float64Array(y0)

      // 临时向量，避免重复分配
      const k1 = new Float64Array(dim)
      const k2 = new Float64Array(dim)
      const k3 = new Float64Array(dim)
      const k4 = new Float64Array(dim)
      const k5 = new Float64Array(dim)
      const k6 = new Float64Array(dim)
      const tmp = new Float64Array(dim)
      const y4 = new Float64Array(dim)
      const y5 = new Float64Array(dim)
      const errVec = new Float64Array(dim)

      while (currentT < tEnd) {
        // 不超过终止时间
        if (currentT + h > tEnd) {
          h = tEnd - currentT
        }

        // ---- RK45 Fehlberg 6 级求值 ----

        // K1 = f(t_n, y_n)
        const f1 = system.func(currentT, currentY)
        for (let j = 0; j < dim; j++) k1[j] = f1[j]

        // K2 = f(t_n + h/4, y_n + h * (1/4) K1)
        const t2 = currentT + h * 0.25
        for (let j = 0; j < dim; j++) tmp[j] = currentY[j] + h * 0.25 * k1[j]
        const f2 = system.func(t2, tmp)
        for (let j = 0; j < dim; j++) k2[j] = f2[j]

        // K3 = f(t_n + 3h/8, y_n + h * (3/32 K1 + 9/32 K2))
        const t3 = currentT + (h * 3) / 8
        for (let j = 0; j < dim; j++) {
          tmp[j] = currentY[j] + h * ((3 / 32) * k1[j] + (9 / 32) * k2[j])
        }
        const f3 = system.func(t3, tmp)
        for (let j = 0; j < dim; j++) k3[j] = f3[j]

        // K4 = f(t_n + 12h/13, y_n + h * (1932/2197 K1 - 7200/2197 K2 + 7296/2197 K3))
        const t4 = currentT + (h * 12) / 13
        for (let j = 0; j < dim; j++) {
          tmp[j] = currentY[j] + h * ((1932 / 2197) * k1[j] - (7200 / 2197) * k2[j] + (7296 / 2197) * k3[j])
        }
        const f4 = system.func(t4, tmp)
        for (let j = 0; j < dim; j++) k4[j] = f4[j]

        // K5 = f(t_n + h, y_n + h * (439/216 K1 - 8 K2 + 3680/513 K3 - 845/4104 K4))
        const t5 = currentT + h
        for (let j = 0; j < dim; j++) {
          tmp[j] = currentY[j] + h * ((439 / 216) * k1[j] - 8 * k2[j] + (3680 / 513) * k3[j] - (845 / 4104) * k4[j])
        }
        const f5 = system.func(t5, tmp)
        for (let j = 0; j < dim; j++) k5[j] = f5[j]

        // K6 = f(t_n + h/2, y_n + h * (-8/27 K1 + 2 K2 - 3544/2565 K3 + 1859/4104 K4 - 11/40 K5))
        const t6 = currentT + h * 0.5
        for (let j = 0; j < dim; j++) {
          tmp[j] = currentY[j] + h * ((-8 / 27) * k1[j] + 2 * k2[j] - (3544 / 2565) * k3[j] + (1859 / 4104) * k4[j] - (11 / 40) * k5[j])
        }
        const f6 = system.func(t6, tmp)
        for (let j = 0; j < dim; j++) k6[j] = f6[j]

        // ---- 计算低阶解 y4 与高阶解 y5 ----
        for (let j = 0; j < dim; j++) {
          y4[j] = currentY[j] + h * ((25 / 216) * k1[j] + (1408 / 2565) * k3[j] + (2197 / 4104) * k4[j] - (1 / 5) * k5[j])

          y5[j] =
            currentY[j] + h * ((16 / 135) * k1[j] + (6656 / 12825) * k3[j] + (28561 / 56430) * k4[j] - (9 / 50) * k5[j] + (2 / 55) * k6[j])

          errVec[j] = Math.abs(y5[j] - y4[j])
        }

        // ---- 误差估计（取最大分量） ----
        let errMax = 0
        for (let j = 0; j < dim; j++) {
          if (errVec[j] > errMax) errMax = errVec[j]
        }

        // 接受 / 拒绝步长
        if (errMax === 0) {
          // 零误差，直接接受并增大步长
          currentT = t5
          currentY = new Float64Array(y5)
          t.push(currentT)
          y.push(currentY)
          h = Math.min(maxStepSize, h * 5)
        } else if (errMax <= tolerance) {
          // 接受步长，使用高阶解 y5 推进
          currentT = t5
          currentY = new Float64Array(y5)
          t.push(currentT)
          y.push(currentY)

          // 计算新步长（含安全因子与限制）
          let factor = this.safetyFactor * Math.pow(tolerance / errMax, 0.2)
          if (factor > 5) factor = 5
          if (factor < 0.2) factor = 0.2
          h = Math.min(maxStepSize, h * factor)
        } else {
          // 拒绝步长，缩小后重试
          let factor = this.safetyFactor * Math.pow(tolerance / errMax, 0.2)
          if (factor > 0.8) factor = 0.8 // 拒绝时最大缩小比例
          if (factor < 0.1) factor = 0.1
          h = Math.max(minStepSize, h * factor)

          if (h <= minStepSize || currentT + h <= currentT) {
            throw new Error('步长低于最小值或无法进一步缩小，求解终止')
          }
          continue
        }

        // 保护步长范围
        if (h < minStepSize) h = minStepSize
        if (h > maxStepSize) h = maxStepSize

        // 防止数值上步长不再前进
        if (currentT >= tEnd || currentT + h <= currentT) {
          break
        }
      }

      const endTime = process.hrtime.bigint()
      const elapsedUs = Number(endTime - startTime) / 1000

      return {
        t: Float64Array.from(t),
        y,
        steps: t.length,
        elapsedUs,
        success: true,
      }
    } catch (err: any) {
      log('ERROR', 'rk45_solver_error', { error: err.message })
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
