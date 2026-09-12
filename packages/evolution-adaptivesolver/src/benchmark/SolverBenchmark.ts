/**
 * SolverBenchmark — 求解器基准测试对比
 *
 * 运行新旧求解器在多个测试方程上的对比测试，
 * 生成 BenchmarkReport 供 AdaptiveSolverExecutor 判断是否合并。
 *
 * 判定标准：
 * - 精度提升 >= 20%（最终误差降低）
 * - 耗时增加 <= 10%
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type {
  OdeSolver,
  OdeSystem,
  Solution,
  FixedStepConfig,
  AdaptiveStepConfig,
  BenchmarkResult,
  BenchmarkReport,
} from '../solvers/types'

// =============================================================================
// 基准测试配置
// =============================================================================

export interface TestCase {
  name: string
  system: OdeSystem
  fixedConfig: FixedStepConfig
  adaptiveConfig: AdaptiveStepConfig
  /** 可选：参考解函数（用于计算参考误差） */
  referenceFunc?: (t: number) => number[]
}

export interface BenchmarkConfig {
  testCases: TestCase[]
  referenceStepSize: number
}

// =============================================================================
// 误差计算
// =============================================================================

/**
 * 计算两个解的误差。
 * 参考解使用极小步长计算，插值到新解的时间点。
 */
function computeErrors(
  oldSolution: Solution,
  newSolution: Solution,
  referenceSolution: Solution,
  system: OdeSystem,
): { oldError: number; newError: number; oldAvgError: number; newAvgError: number } {
  const dim = system.dimension

  // 计算最终误差（在最终时间点）
  const oldFinalIdx = oldSolution.t.length - 1
  const newFinalIdx = newSolution.t.length - 1
  const refFinalIdx = referenceSolution.t.length - 1

  let oldFinalError = 0
  let newFinalError = 0
  for (let j = 0; j < dim; j++) {
    const refVal = referenceSolution.y[refFinalIdx][j]
    const oldVal = oldSolution.y[oldFinalIdx][j]
    const newVal = newSolution.y[newFinalIdx][j]
    const scale = Math.max(Math.abs(refVal), 1e-10)
    oldFinalError += Math.abs(oldVal - refVal) / scale
    newFinalError += Math.abs(newVal - refVal) / scale
  }

  // 计算平均误差（沿整个时间轴采样）
  const sampleCount = Math.min(oldSolution.t.length, 1000)
  const step = Math.max(1, Math.floor(oldSolution.t.length / sampleCount))
  let oldSum = 0
  let newSum = 0
  let count = 0

  for (let i = 0; i < oldSolution.t.length; i += step) {
    const t = oldSolution.t[i]
    // 在参考解中找到对应时间点（最接近的）
    let refIdx = 0
    for (let r = 0; r < referenceSolution.t.length - 1; r++) {
      if (referenceSolution.t[r + 1] > t) {
        refIdx = r
        break
      }
    }
    for (let j = 0; j < dim; j++) {
      const scale = Math.max(Math.abs(referenceSolution.y[refIdx][j]), 1e-10)
      const oldRelErr = Math.abs(oldSolution.y[i][j] - referenceSolution.y[refIdx][j]) / scale
      oldSum += oldRelErr
      newSum += Math.abs(newSolution.y?.[i]?.[j] ?? 0 - referenceSolution.y[refIdx][j]) / scale
      count++
    }
  }

  return {
    oldError: oldFinalError / dim,
    newError: newFinalError / dim,
    oldAvgError: count > 0 ? oldSum / count : oldFinalError,
    newAvgError: count > 0 ? newSum / count : newFinalError,
  }
}

// =============================================================================
// 基准测试
// =============================================================================

/**
 * 运行一次完整的基准测试对比
 */
export async function runBenchmark(oldSolver: OdeSolver, newSolver: OdeSolver, config: BenchmarkConfig): Promise<BenchmarkReport> {
  let totalOldError = 0
  let totalNewError = 0
  let totalOldTime = 0
  let totalNewTime = 0
  let totalOldSteps = 0
  let totalNewSteps = 0

  for (const testCase of config.testCases) {
    log('INFO', 'benchmark_run_case', {
      equation: testCase.name,
      oldSolver: oldSolver.name,
      newSolver: newSolver.name,
    })

    // 运行旧求解器（固定步长）
    const oldResult = await oldSolver.solve(testCase.system, testCase.fixedConfig)

    // 运行新求解器（自适应）
    const newResult = await newSolver.solve(testCase.system, testCase.adaptiveConfig)

    if (!oldResult.success || !newResult.success) {
      log('ERROR', 'benchmark_solver_failed', {
        equation: testCase.name,
        oldSuccess: oldResult.success,
        newSuccess: newResult.success,
      })
      continue
    }

    // 计算参考解（用极小步长的 RK4 或固定步长）
    // 如果设置了参考解函数，使用它计算精确误差
    const refStep = testCase.fixedConfig.stepSize / 10
    const refConfig: FixedStepConfig = {
      stepSize: refStep,
      tStart: testCase.fixedConfig.tStart,
      tEnd: testCase.fixedConfig.tEnd,
      y0: new Float64Array(testCase.fixedConfig.y0),
    }
    const referenceSolution = await oldSolver.solve(testCase.system, refConfig)

    // 如果没有参考解函数，使用数值参考解
    const errors = testCase.referenceFunc
      ? computeAnalyticErrors(oldResult, newResult, testCase)
      : computeErrors(oldResult, newResult, referenceSolution, testCase.system)

    totalOldError += errors.oldError
    totalNewError += errors.newError
    totalOldTime += oldResult.elapsedUs
    totalNewTime += newResult.elapsedUs
    totalOldSteps += oldResult.steps
    totalNewSteps += newResult.steps
  }

  // 计算综合指标
  const accuracyImprovementPercent = totalOldError > 0 ? ((totalOldError - totalNewError) / totalOldError) * 100 : 0

  const timeChangePercent = totalOldTime > 0 ? ((totalNewTime - totalOldTime) / totalOldTime) * 100 : 0

  const passed = accuracyImprovementPercent >= 20 && timeChangePercent <= 10

  // 构建旧/新求解器的结果对象
  const oldBenchResult: BenchmarkResult = {
    equationName: config.testCases.map((t) => t.name).join('+'),
    solverName: oldSolver.name,
    isAdaptive: false,
    stepSize: config.testCases[0]?.fixedConfig.stepSize ?? 0.01,
    finalError: totalOldError,
    averageError: totalOldError,
    steps: totalOldSteps,
    elapsedUs: totalOldTime,
  }

  const newBenchResult: BenchmarkResult = {
    equationName: config.testCases.map((t) => t.name).join('+'),
    solverName: newSolver.name,
    isAdaptive: true,
    stepSize: 0,
    finalError: totalNewError,
    averageError: totalNewError,
    steps: totalNewSteps,
    elapsedUs: totalNewTime,
  }

  const report: BenchmarkReport = {
    oldResult: oldBenchResult,
    newResult: newBenchResult,
    accuracyImprovementPercent,
    timeChangePercent,
    passed,
  }

  log('INFO', 'benchmark_complete', {
    accuracyImprovementPercent: accuracyImprovementPercent.toFixed(2),
    timeChangePercent: timeChangePercent.toFixed(2),
    passed,
  })

  return report
}

/**
 * 当有解析解函数时，计算真实误差
 */
function computeAnalyticErrors(
  oldSolution: Solution,
  newSolution: Solution,
  testCase: TestCase,
): { oldError: number; newError: number; oldAvgError: number; newAvgError: number } {
  if (!testCase.referenceFunc) {
    return { oldError: 0, newError: 0, oldAvgError: 0, newAvgError: 0 }
  }

  const dim = testCase.system.dimension
  const sampleCount = Math.min(oldSolution.t.length, 1000)
  const step = Math.max(1, Math.floor(oldSolution.t.length / sampleCount))

  let oldSum = 0
  let newSum = 0
  let count = 0

  for (let i = 0; i < oldSolution.t.length; i += step) {
    const t = oldSolution.t[i]
    const ref = testCase.referenceFunc(t)
    for (let j = 0; j < dim; j++) {
      const scale = Math.max(Math.abs(ref[j]), 1e-10)
      const oldVal = oldSolution.y[i]?.[j] ?? 0
      const newVal = newSolution.y?.[i]?.[j] ?? 0
      oldSum += Math.abs(oldVal - ref[j]) / scale
      newSum += Math.abs(newVal - ref[j]) / scale
      count++
    }
  }

  const oldAvg = count > 0 ? oldSum / count : 0
  const newAvg = count > 0 ? newSum / count : 0

  return {
    oldError: oldAvg,
    newError: newAvg,
    oldAvgError: oldAvg,
    newAvgError: newAvg,
  }
}
