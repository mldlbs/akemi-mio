import { log } from '@akemi-mio/core/logger/Logger'
import type { OdeSolver, OdeSystem, Solution, FixedStepConfig } from './types'

/**
 * 自适应步长配置
 */
export interface AdaptiveStepConfig {
  /** 初始步长 */
  initialStepSize?: number
  /** 绝对/相对容差（与单个分量比较） */
  tolerance?: number
  /** 最小允许步长 */
  minStepSize?: number
  /** 最大允许步长 */
  maxStepSize?: number
  /** 安全因子 (0 < safety < 1) */
  safety?: number
}

/**
 * EulerSolver — 自适应步长 RK45 (Fehlberg) 求解器
 *
 * 实现固定步长欧拉法的自适应升级，采用 Fehlberg 6(5) 阶公式。
 * 误差估计使用四阶与五阶解的差分，并依据相对误差调整步长。
 */
export class EulerSolver implements OdeSolver {
  readonly name = 'EulerSolver'
  readonly isFixedStep = false
  /** 初始步长 (从配置中读取) */
  readonly stepSize: number

  private readonly cfg: Required<AdaptiveStepConfig>

  constructor(config: Partial<AdaptiveStepConfig> = {}) {
    const defaults: Required<AdaptiveStepConfig> = {
      initialStepSize: 0.01,
      tolerance: 1e-6,
      minStepSize: 1e-8,
      maxStepSize: 0.1,
      safety: 0.9,
    }
    this.cfg = { ...defaults, ...config }
    this.stepSize = this.cfg.initialStepSize
  }

  async solve(system: OdeSystem, config: FixedStepConfig): Promise<Solution> {
    const { tStart, tEnd, y0 } = config
    const dim = system.dimension
    const startTime = process.hrtime.bigint()

    try {
      // 初始状态
      let t = tStart
      let y = new Float64Array(y0)
      let h = Math.max(this.cfg.minStepSize, Math.min(this.cfg.maxStepSize, this.stepSize))

      // 存储结果
      const tList: number[] = [t]
      const yList: Float64Array[] = [y]

      // 主循环
      while (t < tEnd) {
        // 最后一步精确对齐终点
        if (t + h > tEnd) {
          h = tEnd - t
        }

        // 临时数组，用于各阶段计算（复用分配）
        const yTmp = new Float64Array(dim)

        // ---- 计算 6 个阶段 ----

        // k1
        const k1 = system.func(t, y)

        // k2 : t + h/4
        const t2 = t + h / 4
        for (let j = 0; j < dim; j++) yTmp[j] = y[j] + (h * k1[j]) / 4
        const k2 = system.func(t2, yTmp)

        // k3 : t + 3h/8
        const t3 = t + (3 * h) / 8
        for (let j = 0; j < dim; j++) yTmp[j] = y[j] + h * ((3 / 32) * k1[j] + (9 / 32) * k2[j])
        const k3 = system.func(t3, yTmp)

        // k4 : t + 12h/13
        const t4 = t + (12 * h) / 13
        for (let j = 0; j < dim; j++) yTmp[j] = y[j] + h * ((1932 / 2197) * k1[j] - (7200 / 2197) * k2[j] + (7296 / 2197) * k3[j])
        const k4 = system.func(t4, yTmp)

        // k5 : t + h
        const t5 = t + h
        for (let j = 0; j < dim; j++) yTmp[j] = y[j] + h * ((439 / 216) * k1[j] - 8 * k2[j] + (3680 / 513) * k3[j] - (845 / 4104) * k4[j])
        const k5 = system.func(t5, yTmp)

        // k6 : t + h/2
        const t6 = t + h / 2
        for (let j = 0; j < dim; j++)
          yTmp[j] = y[j] + h * ((-8 / 27) * k1[j] + 2 * k2[j] - (3544 / 2565) * k3[j] + (1859 / 4104) * k4[j] - (11 / 40) * k5[j])
        const k6 = system.func(t6, yTmp)

        // ---- 计算 5 阶解 (推进解) ----
        const y5 = new Float64Array(dim)
        for (let j = 0; j < dim; j++) {
          y5[j] = y[j] + h * ((16 / 135) * k1[j] + (6656 / 12825) * k3[j] + (28561 / 56430) * k4[j] - (9 / 50) * k5[j] + (2 / 55) * k6[j])
        }

        // ---- 计算 4 阶解 (误差估计) ----
        const y4 = new Float64Array(dim)
        for (let j = 0; j < dim; j++) {
          y4[j] = y[j] + h * ((25 / 216) * k1[j] + (1408 / 2565) * k3[j] + (2197 / 4104) * k4[j] - (1 / 5) * k5[j])
        }

        // ---- 相对误差估计 (最大分量) ----
        let errMax = 0
        for (let j = 0; j < dim; j++) {
          const err = Math.abs(y5[j] - y4[j])
          const scale = this.cfg.tolerance + this.cfg.tolerance * Math.max(Math.abs(y[j]), Math.abs(y5[j]))
          const ratio = err / scale
          if (ratio > errMax) errMax = ratio
        }

        if (errMax <= 1) {
          // 接受步长：推进时间，使用五阶解
          t += h
          y = y5
          tList.push(t)
          yList.push(y)

          // 调整下一步步长
          let factor = this.cfg.safety * Math.pow(1 / errMax, 0.2)
          factor = Math.max(0.1, Math.min(5, factor))
          h = Math.max(this.cfg.minStepSize, Math.min(this.cfg.maxStepSize, h * factor))
        } else {
          // 拒绝步长：缩小步长，重新尝试
          let factor = this.cfg.safety * Math.pow(1 / errMax, 0.2)
          factor = Math.max(0.1, factor)
          h = Math.max(this.cfg.minStepSize, Math.min(this.cfg.maxStepSize, h * factor))
        }
      }

      const endTime = process.hrtime.bigint()
      const elapsedUs = Number(endTime - startTime) / 1000

      return {
        t: new Float64Array(tList),
        y: yList,
        steps: tList.length,
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
