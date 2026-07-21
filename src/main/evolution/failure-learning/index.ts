/**
 * Failure Learning — 基于失败学习的自修复模块
 *
 * 该模块集成到 SelfEvolutionService 的进化周期中，
 * 通过分析 Agent 执行失败日志，自动生成改进建议并应用，
 * 同时支持失败率上升时的自动回滚。
 *
 * 使用方法：
 *
 * 1. 在 AppRuntime 或 SelfEvolutionService 处创建实例：
 *    const failureLearning = new FailureLearningService()
 *    failureLearning.setLlmService(llmService)
 *    failureLearning.start()
 *
 * 2. 在 Evolution 周期的后处理阶段调用：
 *    const result = await failureLearning.runFullCycle()
 *
 * 3. 集成到 SelfEvolutionService.runAnalysisCycle() 的
 *    管道执行后的步骤中（见 TODO 标记）。
 */
export { FailureLearningService } from './FailureLearningService'
export { FailureDatabase, failureDatabase } from './FailureDatabase'
export { ConfigSnapshotManager, configSnapshotManager } from './ConfigSnapshotManager'
export * from './types'
