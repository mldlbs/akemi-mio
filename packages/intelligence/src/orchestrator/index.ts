/**
 * orchestrator/index.ts — 工具链编排模块入口
 *
 * 提供 ToolChainOrchestrator 全局单例和核心类型导出。
 *
 * 使用示例：
 * ```typescript
 * import { toolChainOrchestrator } from './orchestrator'
 * const result = await toolChainOrchestrator.orchestrate('帮我查天气并设置闹钟')
 * ```
 */

export { ToolChainOrchestrator, getToolChainOrchestrator, setToolChainOrchestrator } from '@akemi-mio/intelligence/orchestrator/ToolChainOrchestrator'
export { OrchestrationBridge } from '@akemi-mio/intelligence/orchestrator/OrchestrationBridge'
export { ToolChainDecomposer, toToolSummaries } from '@akemi-mio/intelligence/orchestrator/ToolChainDecomposer'
export type {
  OrchestrationPlan,
  OrchestrationStep,
  OrchestrationProgress,
  OrchestrationResult,
  OrchestratorConfig,
  StepStatus,
  ProgressEventType,
  DecompositionResult,
  DecomposedStep,
} from '@akemi-mio/intelligence/orchestrator/types'
export { DEFAULT_ORCHESTRATOR_CONFIG, ORCHESTRATION_EVENTS } from '@akemi-mio/intelligence/orchestrator/types'
