/**
 * Hybrid Pipeline — MCP-Agent 混合流水线
 *
 * 将 MCP 的处理流程嵌入 Agent 的管线，
 * 在关键节点插入 MCP 的独立判断逻辑。
 * 两条路径并行执行并在汇合点进行交叉验证，
 * 不一致时触发仲裁机制取最优或加权融合。
 */

export { McpAgentHybridPipeline, mcpAgentHybridPipeline } from '@akemi-mio/intelligence/hybrid/McpAgentHybridPipeline'
export { McpAgentArbitrator } from '@akemi-mio/intelligence/hybrid/arbitrator'
export {
  DEFAULT_HYBRID_CONFIG,
  type HybridPipelineConfig,
  type HybridPipelineMetrics,
  type HybridPathOutput,
  type ConvergenceResult,
  type ConvergencePointName,
  type ToolSelectionVerdict,
  type ResultValidationOutput,
  type ReplyQualityOutput,
} from '@akemi-mio/intelligence/hybrid/types'
