export { getAllTools } from './getAllTools'
export { buildTool, type Tool, type ToolDef, toMCPToolDefinition, toMCPToolSchema, formatToolResult, formatToolError } from './types'
export { ToolStatsTracker, toolStatsTracker, type ToolCallSummary, type ProblematicTool } from './ToolStatsTracker'
export { ToolCallLogStore, toolCallLogStore, type ToolCallRecord, type CallLogQuery, type CallLogStats } from './ToolCallLogStore'
export {
  FailurePatternAnalyzer,
  failurePatternAnalyzer,
  type FailurePattern,
  type FailurePatternType,
  type FixTemplateType,
  type ArgPatternMatch,
} from './FailurePatternAnalyzer'
export { FixTemplateRegistry, fixTemplateRegistry, type FixTemplate } from './FixTemplateRegistry'
export {
  ToolAnalytics,
  toolAnalytics,
  type ToolAnalyticsReport,
  type ToolAnalyticsSummary,
  type LatencyPercentiles,
  type SuccessRateTrend,
  type PriorityRecommendation,
} from './ToolAnalytics'

// ===== Memory 模式迁移：ToolProviderRegistry =====
export { toolProviderRegistry, ToolProviderRegistry } from './registry'
export { type IToolProvider, adaptToToolProvider } from './IToolProvider'

// ===== 多工具错误聚合与自动降级 =====
export {
  ToolErrorAggregator,
  toolErrorAggregator,
  SharedResultQueue,
  type ToolExecutionEvent,
  type AggregatedBatchResult,
  type BatchAdvice,
  type MinimalToolResult,
} from './ToolErrorAggregator'
export {
  ToolFallbackRegistry,
  toolFallbackRegistry,
  type FallbackSuggestion,
} from './ToolFallbackRegistry'
export {
  DEFAULT_DEGRADATION_CONFIG,
  type DegradationConfig,
  type DegradationRule,
  type DegradationStrategy,
  type DegradationCondition,
  findMatchingRules,
} from './ToolDegradationConfig'
