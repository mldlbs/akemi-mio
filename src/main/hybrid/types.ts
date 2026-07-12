/**
 * HybridTypes — MCP-Agent 混合流水线类型定义
 *
 * 定义「MCP 处理流程」嵌入「Agent 管线」的核心契约。
 *
 * 路径 A（Agent 路径）：当前 LLM 驱动的 Agent toolLoop 流程
 * 路径 B（MCP 路径）：MCP 工具驱动的独立判断流程
 *
 * 汇合点（Convergence Points）：
 * 1. tool_selection    — LLM 选出工具后，MCP 路径独立验证工具选择
 * 2. result_validation — 工具执行后，MCP 路径独立分析执行结果
 * 3. reply_quality     — Agent 生成回复前，MCP 路径验证回复质量
 */

// =============================================================================
// 路径输出包装
// =============================================================================

/** 单一路径的输出包装，携带置信度 */
export interface HybridPathOutput<T> {
  /** 路径标识 */
  path: 'agent' | 'mcp'
  /** 实际输出 */
  output: T
  /** 置信度 0–1 */
  confidence: number
  /** 额外元数据（可选）*/
  metadata?: Record<string, unknown>
}

// =============================================================================
// 汇合点输出类型
// =============================================================================

/** 工具选择验证 — 每个汇合点的输出类型 */
export interface ToolSelectionVerdict {
  /** 建议保留的工具名称列表 */
  approvedTools: string[]
  /** 建议拦截/移除的工具名称列表 */
  rejectedTools: string[]
  /** 建议额外添加的工具名称列表（MCP 路径发现需要但 Agent 未选的工具） */
  suggestedAdditionalTools: string[]
  /** 总体评估 */
  assessment: 'approved' | 'partially_approved' | 'rejected'
  /** 评估依据 */
  rationale: string
}

/** 结果验证输出 */
export interface ResultValidationOutput {
  /** 验证结果 */
  verdict: 'consistent' | 'inconsistent' | 'uncertain'
  /** 发现的问题（如果有）*/
  issues: Array<{
    toolName: string
    severity: 'error' | 'warning' | 'info'
    description: string
  }>
  /** 是否需要重新执行某些工具 */
  needsReExecution: boolean
  /** 建议追加到 tool 结果的上下文 */
  additionalContext?: string
  /** 评估依据 */
  rationale: string
}

/** 回复质量验证输出 */
export interface ReplyQualityOutput {
  /** 质量判定 */
  verdict: 'good' | 'acceptable' | 'poor'
  /** 发现的问题 */
  issues: Array<{
    type: 'factual_error' | 'incomplete' | 'misleading' | 'style_mismatch'
    description: string
  }>
  /** 回复建议改进方向 */
  suggestion: string
  /** 是否需要 Agent 重新生成 */
  needsRegeneration: boolean
}

// =============================================================================
// 汇合点定义
// =============================================================================

/** 汇合点名称枚举 */
export type ConvergencePointName =
  | 'tool_selection'
  | 'result_validation'
  | 'reply_quality'

/**
 * 汇合点仲裁结果
 *
 * 记录两个路径在同一个汇合点的输出对比及仲裁结论。
 */
export interface ConvergenceResult<T> {
  /** 汇合点名称 */
  point: ConvergencePointName
  /** Agent 路径输出 */
  agentOutput: HybridPathOutput<T>
  /** MCP 路径输出 */
  mcpOutput: HybridPathOutput<T>
  /** 分歧度 0–1（0=完全一致，1=完全分歧）*/
  divergenceScore: number
  /** 仲裁后采用的输出 */
  arbitratedOutput: T
  /** 仲裁方法 */
  arbitrationMethod: 'identical' | 'pick_agent' | 'pick_mcp' | 'weighted_fusion'
  /** 仲裁理由 */
  rationale: string
  /** 执行耗时（毫秒）*/
  durationMs: number
}

// =============================================================================
// 混合流水线配置
// =============================================================================

/**
 * 混合流水线配置
 */
export interface HybridPipelineConfig {
  /** 是否启用双路径并行（默认 false — 需显式开启）*/
  enabled: boolean
  /** Agent 路径权重（0–1，融合时使用）*/
  agentPathWeight: number
  /** MCP 路径权重（0–1，融合时使用）*/
  mcpPathWeight: number
  /** 分歧阈值：超过此值才触发仲裁（默认 0.4）*/
  divergenceThreshold: number
  /** 每个汇合点的独立开关 */
  points: {
    tool_selection: boolean
    result_validation: boolean
    reply_quality: boolean
  }
  /** MCP 路径超时（毫秒）*/
  mcpTimeoutMs: number
  /** 日志详细程度 */
  verbose: boolean
}

export const DEFAULT_HYBRID_CONFIG: HybridPipelineConfig = {
  enabled: false,
  agentPathWeight: 0.6,
  mcpPathWeight: 0.4,
  divergenceThreshold: 0.4,
  points: {
    tool_selection: true,
    result_validation: true,
    reply_quality: false, // reply_quality 默认关闭（开销较大）
  },
  mcpTimeoutMs: 5000,
  verbose: false,
}

// =============================================================================
// 混合流水线指标
// =============================================================================

/** 混合流水线运行统计数据 */
export interface HybridPipelineMetrics {
  /** 总汇合次数 */
  totalConvergences: number
  /** 各汇合点处理次数 */
  perPointCount: Record<ConvergencePointName, number>
  /** 各仲裁方法使用次数 */
  perMethodCount: Record<string, number>
  /** 平均分歧度 */
  avgDivergence: number
  /** MCP 路径平均耗时（毫秒）*/
  avgMcpLatencyMs: number
  /** 最近一次仲裁结果摘要 */
  lastResult?: {
    point: ConvergencePointName
    method: string
    divergenceScore: number
    durationMs: number
  }
  /** 最近运行时间戳 */
  lastRunAt: number
}
