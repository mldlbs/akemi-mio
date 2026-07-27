/**
 * AdaptiveSolver — 自进化自适应步长求解器子系统
 *
 * 模块组成：
 * - solvers/     : ODE 求解器实现（Euler, RK4, AdaptiveRK45）
 * - test/        : 测试方程（Lorenz 系统、刚性方程）和基准测试
 * - SolverScannerCollector : 固定步长求解器扫描采集器
 * - AdaptiveSolverExecutor : 自适应步长升级执行器
 *
 * 工作流：
 * 1. SolverScannerCollector 在 Evolution 周期中扫描求解器代码
 * 2. 检测到固定步长求解器 → 生成 Problem
 * 3. AdaptiveSolverExecutor 消费 Problem
 * 4. LLM 生成自适应 RK45 代码
 * 5. 运行基准测试（Lorenz + 刚性方程）对比精度和耗时
 * 6. 精度≥20%↑ 且 耗时≤10%↑ → 替换源文件 + tsc 验证 + Git 提交
 * 7. 否则 → 回滚快照
 */

export { SolverScannerCollector } from './SolverScannerCollector'
export { AdaptiveSolverExecutor } from './AdaptiveSolverExecutor'
export { EulerSolver, RK4Solver, AdaptiveRK45Solver } from './solvers'
export {
  lorenzSystem,
  lorenzFixedConfig,
  lorenzAdaptiveConfig,
  stiffSystem,
  stiffFixedConfig,
  stiffAdaptiveConfig,
  stiffAnalyticSolution,
  runBenchmark,
} from './test'
export type {
  OdeSystem,
  OdeFunction,
  OdeSolver,
  Solution,
  FixedStepConfig,
  AdaptiveStepConfig,
  BenchmarkResult,
  BenchmarkReport,
  FixedSolverScanResult,
} from './solvers/types'
