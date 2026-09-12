/**
 * ConvergenceDetector — 通用收敛检测器
 *
 * 核心抽象：将参数调整幅度的收敛/发散检测标准化。
 * 替代手动管理的均值/标准差/稳定计数/发散阈值 判断逻辑。
 *
 * 用法：
 *   const detector = new ConvergenceDetector()
 *   detector.record(0.05)
 *   detector.record(0.03)
 *   detector.record(0.04)
 *   detector.state       // 'converging' 或 'converged'
 *   detector.hasConverged // true
 *
 * 设计原则：
 * - 无偏见：不关心调整的含义，只管理数值统计
 * - 纯函数 + 类两种风格
 * - 使用滑动窗口分析最近 N 次调整幅度的均值和标准差
 * - 支持收敛、发散、探索三种状态的自动判断
 *
 * 来源分析（从以下模块提取的共性）：
 * - MCPFeedbackLoopService.checkConvergence — 均值/标准差/稳定计数/发散检测
 * - MCPPlanRadarFeedbackLoop.checkConvergence — 完全相同的检测逻辑
 */

import { BoundedBuffer } from './BoundedBuffer'

// ════════════════════════════════════════════════════════════════
//  类型
// ════════════════════════════════════════════════════════════════

/** 收敛状态 */
export type ConvergenceState = 'diverging' | 'exploring' | 'converging' | 'converged'

/** ConvergenceDetector 配置 */
export interface ConvergenceDetectorOptions {
  /** 收敛所需的最小连续稳定观察次数（默认 5） */
  requiredStableObservations?: number
  /** 稳定阈值：调整幅度低于此值视为稳定（默认 0.1） */
  stabilityThreshold?: number
  /** 发散阈值：调整幅度超过此值视为发散（默认 2.0） */
  divergenceThreshold?: number
  /** 分析窗口大小（最多保留最近 N 次调整幅度用于统计，默认 20） */
  windowSize?: number
  /** 最小样本数：不足此数量时始终处于 exploring（默认 3） */
  minSamplesRequired?: number
  /** 日志分类名前缀（默认 'convergence'） */
  loggerName?: string
}

/** 收敛检测器状态快照 */
export interface ConvergenceSnapshot {
  state: ConvergenceState
  recentAdjustmentMagnitude: number
  adjustmentStdDev: number
  stableObservationCount: number
  requiredStableObservations: number
  stabilityThreshold: number
  divergenceThreshold: number
  hasConverged: boolean
  totalObservations: number
  lastUpdated: number
}

// ════════════════════════════════════════════════════════════════
//  纯函数
// ════════════════════════════════════════════════════════════════

/**
 * 计算数值数组的均值。
 */
export function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((s, v) => s + v, 0) / values.length
}

/**
 * 计算数值数组的标准差（总体标准差）。
 */
export function stdDev(values: number[]): number {
  if (values.length === 0) return 0
  const avg = mean(values)
  const variance = values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

/**
 * 判断调整幅度是否稳定（低于阈值）。
 */
export function isStable(magnitude: number, threshold: number): boolean {
  return magnitude < threshold
}

/**
 * 判断是否发散（存在超过发散阈值的调整幅度）。
 */
export function isDiverging(magnitudes: number[], threshold: number): boolean {
  return magnitudes.some((m) => m > threshold)
}

/**
 * 根据均值和稳定计数判断收敛状态。
 *
 * @returns [state, stableCount]
 */
export function evaluateConvergence(
  averageMagnitude: number,
  stableCount: number,
  requiredStable: number,
  stabilityThreshold: number,
  divergenceDetected: boolean,
): { state: ConvergenceState; stableCount: number } {
  if (divergenceDetected) {
    return { state: 'diverging', stableCount: 0 }
  }

  if (averageMagnitude < stabilityThreshold) {
    const newCount = stableCount + 1
    if (newCount >= requiredStable) {
      return { state: 'converged', stableCount: newCount }
    }
    return { state: 'converging', stableCount: newCount }
  }

  return { state: 'exploring', stableCount: 0 }
}

// ════════════════════════════════════════════════════════════════
//  有状态收敛检测器
// ════════════════════════════════════════════════════════════════

export class ConvergenceDetector {
  private config: Required<ConvergenceDetectorOptions>
  private _state: ConvergenceState = 'exploring'
  private stableCount = 0
  private _hasConverged = false
  private magnitudes: BoundedBuffer<number>
  private _lastUpdated: number = Date.now()

  constructor(options?: ConvergenceDetectorOptions) {
    this.config = {
      requiredStableObservations: options?.requiredStableObservations ?? 5,
      stabilityThreshold: options?.stabilityThreshold ?? 0.1,
      divergenceThreshold: options?.divergenceThreshold ?? 2.0,
      windowSize: options?.windowSize ?? 20,
      minSamplesRequired: options?.minSamplesRequired ?? 3,
      loggerName: options?.loggerName ?? 'convergence',
    }
    this.magnitudes = new BoundedBuffer<number>(this.config.windowSize)
  }

  // ── 只读属性 ──

  /** 当前收敛状态 */
  get state(): ConvergenceState {
    return this._state
  }

  /** 是否已达到收敛 */
  get hasConverged(): boolean {
    return this._hasConverged
  }

  /** 已记录的调整幅度数 */
  get totalObservations(): number {
    return this.magnitudes.size
  }

  /** 当前稳定计数 */
  get stableObservationCount(): number {
    return this.stableCount
  }

  /** 最近调整幅度的均值 */
  get recentAdjustmentMagnitude(): number {
    return mean(this.magnitudes.toArray())
  }

  // ── 核心 ──

  /**
   * 记录一次调整幅度并重新评估收敛状态。
   *
   * @param magnitude 本次调整的绝对值（|newValue - previousValue|）
   * @returns 更新后的收敛状态
   */
  record(magnitude: number): ConvergenceState {
    this.magnitudes.add(Math.abs(magnitude))
    this._lastUpdated = Date.now()
    this._state = this.evaluate()
    return this._state
  }

  /**
   * 基于当前缓冲区中的调整幅度评估收敛状态。
   */
  private evaluate(): ConvergenceState {
    const values = this.magnitudes.toArray()

    // 样本不足 → 探索
    if (values.length < this.config.minSamplesRequired) {
      this.stableCount = 0
      return 'exploring'
    }

    const avg = mean(values)
    const maxVal = Math.max(...values)

    // 发散检测：是否存在超过发散阈值的调整
    if (maxVal > this.config.divergenceThreshold) {
      this.stableCount = 0
      this._hasConverged = false
      return 'diverging'
    }

    // 稳定检测
    if (avg < this.config.stabilityThreshold) {
      this.stableCount++
      if (this.stableCount >= this.config.requiredStableObservations) {
        this._hasConverged = true
        return 'converged'
      }
      return 'converging'
    }

    // 不稳定
    this.stableCount = 0
    return 'exploring'
  }

  // ── 管理 ──

  /** 重置检测器（清除所有历史） */
  reset(): void {
    this.magnitudes.clear()
    this._state = 'exploring'
    this.stableCount = 0
    this._hasConverged = false
    this._lastUpdated = Date.now()
  }

  /** 获取快照 */
  snapshot(): ConvergenceSnapshot {
    return {
      state: this._state,
      recentAdjustmentMagnitude: this.recentAdjustmentMagnitude,
      adjustmentStdDev: stdDev(this.magnitudes.toArray()),
      stableObservationCount: this.stableCount,
      requiredStableObservations: this.config.requiredStableObservations,
      stabilityThreshold: this.config.stabilityThreshold,
      divergenceThreshold: this.config.divergenceThreshold,
      hasConverged: this._hasConverged,
      totalObservations: this.magnitudes.size,
      lastUpdated: this._lastUpdated,
    }
  }
}

// ════════════════════════════════════════════════════════════════
//  便捷工厂
// ════════════════════════════════════════════════════════════════

/**
 * 创建 ConvergenceDetector 实例。
 */
export function createConvergenceDetector(options?: ConvergenceDetectorOptions): ConvergenceDetector {
  return new ConvergenceDetector(options)
}
