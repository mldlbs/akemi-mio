/**
 * CI/CD Orchestrator — 模块入口
 *
 * 将 CI/CD MCP 工具集整合为 Evolution 系统可消费的模块。
 * 提供 CicdOrchestrator 单例和 CicdCollector 管道采集器。
 */

export { CicdOrchestrator } from './CicdOrchestrator'
export { CicdCollector } from './CicdCollector'
export { PlanStepMapper, planStepMapper } from './PlanStepMapper'
export type { CicdAction, CicdStepResult, CicdCycleReport, CicdOrchestratorConfig, StepMapping } from './types'
