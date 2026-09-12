/**
 * Test — 导出测试方程和基准测试工具
 */
export { lorenzSystem, lorenzFixedConfig, lorenzAdaptiveConfig, getLorenzReferenceSolution } from './LorenzSystem'
export { stiffSystem, stiffFixedConfig, stiffAdaptiveConfig, stiffAnalyticSolution } from './StiffSystem'
export { runBenchmark } from './SolverBenchmark'
export type { TestCase, BenchmarkConfig } from './SolverBenchmark'
