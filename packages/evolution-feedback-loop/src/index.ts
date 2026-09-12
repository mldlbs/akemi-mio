/**
 * MCP ↔ UserBehavior 强化回路 — 入口
 *
 * 导出 MCPFeedbackLoopService 及关联类型，供系统初始化时使用。
 *
 * @example
 * ```ts
 * import { createMCPFeedbackLoop } from './user-behavior/feedback-loop'
 *
 * const loop = createMCPFeedbackLoop({ initialMode: 'monitor', debug: true })
 * loop.start()
 * ```
 */

import { MCPFeedbackLoopService } from './MCPFeedbackLoopService'
export { MCPFeedbackLoopService } from './MCPFeedbackLoopService'
export type { MCPFeedbackLoopConfig } from './MCPFeedbackLoopService'
export type {
  ToolExecutionQuality,
  ToolQualitySnapshot,
  BehaviorParameterSet,
  ParameterAdjustment,
  ParameterAdjustmentType,
  DampingState,
  ConvergenceMetrics,
  ConvergenceState,
  FeedbackLoopMode,
  FeedbackLoopState,
  FeedbackLoopStateChangePayload,
  ParameterAdjustmentPayload,
  DEFAULT_PARAMETERS,
  DEFAULT_DAMPING_CONFIG,
  DEFAULT_CONVERGENCE_CONFIG,
  PARAMETER_BOUNDS,
} from './types'

/**
 * 快捷工厂函数：创建并启动 MCPFeedbackLoopService
 *
 * 在 AgentService 初始化阶段或系统启动阶段调用。
 * 默认以 monitor 模式启动，收敛后可切至 auto 模式。
 */
export function createMCPFeedbackLoop(config?: { initialMode?: 'monitor' | 'auto'; debug?: boolean }): MCPFeedbackLoopService {
  const loop = new MCPFeedbackLoopService({
    initialMode: config?.initialMode ?? 'monitor',
    debug: config?.debug ?? false,
  })
  loop.start()
  return loop
}
