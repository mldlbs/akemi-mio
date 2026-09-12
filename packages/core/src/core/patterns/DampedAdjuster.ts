/**
 * DampedAdjuster — 通用阻尼参数调整器
 *
 * 核心抽象：将指数平滑阻尼参数调整标准化。
 * 替代 `prev*(1-factor) + target*factor` + 边界钳位 + 因子衰减 的手动实现。
 *
 * 用法：
 *   const adjuster = new DampedAdjuster({ initialFactor: 0.3 })
 *   let param = 0.5
 *   param = adjuster.adjust(param, 0.8, { min: 0, max: 1 })
 *   // → 0.5*(1-0.3) + 0.8*0.3 = 0.59
 *   adjuster.decay()  // factor *= decayRate
 *
 * 设计原则：
 * - 无偏见：不关心参数的含义，只管理数学变换
 * - 纯函数 + 类两种风格：静态方法用于一次计算，实例用于带状态衰减
 * - 整数参数自动四舍五入（检测整数边界）
 * - 变化幅度极小时自动跳过（防止频繁微小调整）
 *
 * 来源分析（从以下模块提取的共性）：
 * - MCPFeedbackLoopService.applyDampedAdjustment — 指数平滑 + 边界钳制 + 因子衰减
 * - MCPPlanRadarFeedbackLoop.applyDampedAdjustment — 完全相同公式
 * - MCPPlanRadarFeedbackLoop.applyDampedSourceWeight — 相同公式的嵌套对象版本
 */

import { clamp } from './clamp'

// ════════════════════════════════════════════════════════════════
//  类型
// ════════════════════════════════════════════════════════════════

/** 参数边界约束 */
export interface ParameterBounds {
  /** 最小值（含） */
  min: number
  /** 最大值（含） */
  max: number
}

/** DampedAdjuster 配置 */
export interface DampedAdjusterOptions {
  /** 初始阻尼因子（0-1），越接近 1 变化越激进（默认 0.3） */
  initialFactor?: number
  /** 最小阻尼因子，达到后不再衰减（默认 0.05） */
  minFactor?: number
  /** 衰减率：每次 decay() 后 factor *= decayRate（默认 0.85） */
  decayRate?: number
  /** 最小变化幅度，低于此值的调整跳过（默认 0.01） */
  minDelta?: number
}

/** DampedAdjuster 状态快照 */
export interface DampedAdjusterState {
  currentFactor: number
  initialFactor: number
  minFactor: number
  decayRate: number
  adjustCount: number
}

// ════════════════════════════════════════════════════════════════
//  纯函数
// ════════════════════════════════════════════════════════════════

/**
 * 指数平滑阻尼计算。
 * newValue = previousValue × (1 - dampingFactor) + targetValue × dampingFactor
 *
 * @param previous 调整前的值
 * @param target 调整的目标值（未经阻尼）
 * @param factor 阻尼因子（0-1），越接近 1 变化越激进
 * @param bounds 可选：边界约束
 * @returns 阻尼后的值
 */
export function dampValue(previous: number, target: number, factor: number, bounds?: ParameterBounds): number {
  const raw = previous * (1 - factor) + target * factor
  const clamped = bounds ? clamp(raw, bounds.min, bounds.max) : raw
  // 如果边界为整数，自动四舍五入
  if (bounds && Number.isInteger(bounds.min) && Number.isInteger(bounds.max)) {
    return Math.round(clamped)
  }
  // 保留 6 位小数精度（防止浮点误差累积）
  return Number(clamped.toFixed(6))
}

/**
 * 检查值是否在边界内。
 */
export function isInBounds(value: number, bounds: ParameterBounds): boolean {
  return value >= bounds.min && value <= bounds.max
}

/**
 * 检查变化幅度是否显著（超过最小阈值）。
 */
export function isSignificantChange(previous: number, newValue: number, minDelta: number = 0.01): boolean {
  return Math.abs(newValue - previous) >= minDelta
}

// ════════════════════════════════════════════════════════════════
//  有状态阻尼调整器
// ════════════════════════════════════════════════════════════════

export class DampedAdjuster {
  /** 当前阻尼因子 */
  currentFactor: number
  readonly initialFactor: number
  readonly minFactor: number
  readonly decayRate: number
  readonly minDelta: number
  adjustCount = 0

  constructor(options?: DampedAdjusterOptions) {
    this.initialFactor = options?.initialFactor ?? 0.3
    this.minFactor = options?.minFactor ?? 0.05
    this.decayRate = options?.decayRate ?? 0.85
    this.minDelta = options?.minDelta ?? 0.01
    this.currentFactor = this.initialFactor
  }

  /**
   * 执行一次带阻尼的参数调整。
   *
   * @param previous 调整前的值
   * @param target 调整的目标值（未经阻尼）
   * @param bounds 可选：边界约束
   * @returns 阻尼后的值，如果变化不显著则返回 previous
   */
  adjust(previous: number, target: number, bounds?: ParameterBounds): number {
    const damped = dampValue(previous, target, this.currentFactor, bounds)

    if (!isSignificantChange(previous, damped, this.minDelta)) {
      return previous
    }

    this.adjustCount++
    return damped
  }

  /**
   * 衰减阻尼因子。
   * currentFactor = max(minFactor, currentFactor * decayRate)
   */
  decay(): void {
    this.currentFactor = Math.max(this.minFactor, this.currentFactor * this.decayRate)
  }

  /** 重置阻尼因子到初始值 */
  reset(): void {
    this.currentFactor = this.initialFactor
    this.adjustCount = 0
  }

  /** 获取快照 */
  snapshot(): DampedAdjusterState {
    return {
      currentFactor: this.currentFactor,
      initialFactor: this.initialFactor,
      minFactor: this.minFactor,
      decayRate: this.decayRate,
      adjustCount: this.adjustCount,
    }
  }
}

// ════════════════════════════════════════════════════════════════
//  便捷工厂
// ════════════════════════════════════════════════════════════════

/**
 * 创建 DampedAdjuster 实例。
 */
export function createDampedAdjuster(options?: DampedAdjusterOptions): DampedAdjuster {
  return new DampedAdjuster(options)
}
