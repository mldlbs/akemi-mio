/**
 * Adaptive Solver — 通用类型定义
 *
 * 定义 ODE 求解器的共用接口和类型。
 * Evolution 系统扫描这些接口来识别可升级的求解器。
 */

// ── ODE 系统定义 ──

/**
 * ODE 右侧函数：dy/dt = f(t, y)
 * 输入当前时间 t 和状态向量 y，返回导数向量。
 */
export type OdeFunction = (t: number, y: Float64Array) => Float64Array

/**
 * ODE 系统 — 可包含多个方程的右侧函数
 */
export interface OdeSystem {
  /** 系统名称 */
  readonly name: string
  /** 维度（状态向量长度） */
  readonly dimension: number
  /** 右侧函数 */
  readonly func: OdeFunction
}

// ── 求解器配置 ──

/**
 * 固定步长求解器配置
 */
export interface FixedStepConfig {
  /** 步长 h */
  stepSize: number
  /** 起始时间 */
  tStart: number
  /** 结束时间 */
  tEnd: number
  /** 初始状态 */
  y0: Float64Array
}

/**
 * 自适应步长求解器配置
 */
export interface AdaptiveStepConfig {
  /** 初始步长 */
  initialStepSize: number
  /** 最小步长（防止无限缩小） */
  minStepSize: number
  /** 最大步长 */
  maxStepSize: number
  /** 容差（控制误差） */
  tolerance: number
  /** 安全因子（通常 0.8-0.9） */
  safetyFactor: number
  /** 起始时间 */
  tStart: number
  /** 结束时间 */
  tEnd: number
  /** 初始状态 */
  y0: Float64Array
}

// ── 求解结果 ──

/**
 * 求解结果
 */
export interface Solution {
  /** 时间点数组 */
  t: Float64Array
  /** 状态矩阵，每行对应一个时间点，每列对应一个维度 */
  y: Float64Array[]
  /** 实际使用的步数 */
  steps: number
  /** 总耗时（微秒） */
  elapsedUs: number
  /** 是否成功 */
  success: boolean
  /** 错误信息（失败时） */
  error?: string
}

// ── 求解器接口 ──

/**
 * ODE 求解器接口
 * 所有求解器（Euler / RK4 / AdaptiveRK45）实现此接口。
 * Evolution 系统通过此接口识别可升级的求解器。
 */
export interface OdeSolver {
  /** 求解器名称 */
  readonly name: string
  /** 是否使用固定步长 */
  readonly isFixedStep: boolean
  /** 当前步长 */
  readonly stepSize: number
  /** 求解 ODE 系统 */
  solve(system: OdeSystem, config: FixedStepConfig | AdaptiveStepConfig): Promise<Solution>
}

// ── 基准测试结果 ──

/**
 * 单个测试方程的基准测试结果
 */
export interface BenchmarkResult {
  /** 方程名称（如 "LorenzSystem"） */
  equationName: string
  /** 求解器名称 */
  solverName: string
  /** 是否自适应 */
  isAdaptive: boolean
  /** 步长 */
  stepSize: number
  /** 最终误差（与参考解对比） */
  finalError: number
  /** 平均误差 */
  averageError: number
  /** 总步数 */
  steps: number
  /** 耗时（微秒） */
  elapsedUs: number
}

/**
 * 基准测试对比报告
 */
export interface BenchmarkReport {
  /** 旧求解器（固定步长）结果 */
  oldResult: BenchmarkResult
  /** 新求解器（自适应）结果 */
  newResult: BenchmarkResult
  /** 精度提升百分比（正数表示提升） */
  accuracyImprovementPercent: number
  /** 耗时变化百分比（正数表示增加） */
  timeChangePercent: number
  /** 是否通过（精度≥20% 且 耗时≤10%） */
  passed: boolean
}

// ── 收集器扫描结果 ──

/**
 * Evolution 采集器扫描到的固定步长求解器信息
 */
export interface FixedSolverScanResult {
  /** 文件路径 */
  filePath: string
  /** 行号 */
  lineNumber: number
  /** 求解器名称 */
  solverName: string
  /** 步长变量名 */
  stepVarName: string
  /** 步长值 */
  stepValue: number
  /** 循环结构描述 */
  loopStructure: string
  /** 代码片段 */
  snippet: string
}
