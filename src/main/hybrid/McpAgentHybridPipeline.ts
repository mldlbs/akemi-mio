/**
 * McpAgentHybridPipeline — MCP-Agent 混合流水线编排器
 *
 * 将 MCP 的处理流程嵌入 Agent 的管线，在关键节点插入独立判断逻辑。
 *
 * 路径 A（Agent 路径）：LLM 驱动的当前 toolLoop 流程
 * 路径 B（MCP 路径）：独立 MCP 风格分析流程（轻量 LLM 判断）
 *
 * 汇合点：
 * 1. tool_selection       — LLM 选出工具后，MCP 独立验证工具选择
 * 2. result_validation    — 工具执行后，MCP 独立分析执行结果
 * 3. reply_quality        — Agent 生成回复前，MCP 验证回复质量
 *
 * 集成方式：
 * - ChatExecutor / TaskExecutor 在 toolLoop 关键节点调用本流水线
 * - 返回的仲裁结果包含 actions（拦截/警告/继续）
 * - 调用方根据 actions 决定后续流程
 *
 * 设计原则：
 * - 可降级：任一路径失败时透明降级到另一路径
 * - 可配置：通过 HybridPipelineConfig 控制行为和阈值
 * - 低开销：MCP 路径使用轻量 chatJson 调用，默认 < 3s
 * - 无递归：MCP 路径不调用 ToolScheduler，避免工具循环递归
 */

import { log, createRequestId } from '../logger/Logger'
import { eventBus } from '../core/EventBus'
import type { LlmService } from '../llm/LlmService'
import type { ToolCallInfo } from '../llm/LlmService'
import type { ToolResult } from '../agent/ToolScheduler'
import { McpAgentArbitrator } from './arbitrator'
import { DEFAULT_HYBRID_CONFIG } from './types'
import type {
  HybridPathOutput,
  ConvergenceResult,
  ConvergencePointName,
  ToolSelectionVerdict,
  ResultValidationOutput,
  ReplyQualityOutput,
  HybridPipelineConfig,
  HybridPipelineMetrics,
} from './types'

// =============================================================================
// 各路径基线置信度
// =============================================================================

/** Agent 路径基线置信度 */
const AGENT_BASE_CONFIDENCE = 0.75

/** MCP 路径基线置信度 */
const MCP_BASE_CONFIDENCE = 0.65

// =============================================================================
// MCP 路径分析 prompt 模板
// =============================================================================

const TOOL_SELECTION_JUDGE_PROMPT = `你是一个独立的工具选择验证器（MCP Judge）。
你的职责是独立分析当前即将执行的工具调用，判断它们是否合适。

请输出 JSON 格式的评估结果，包含：
- approvedTools: 你认为应该保留的工具名称列表
- rejectedTools: 你认为应该拦截/移除的工具名称列表（这些工具有问题、不必要或风险高）
- suggestedAdditionalTools: 你认为应该添加但 Agent 未选的工具名称列表
- assessment: "approved" | "partially_approved" | "rejected" — 总体评估
- rationale: 你的分析依据

准则：
- 如果工具有明显风险（删除文件、覆写配置等），优先拒绝
- 如果工具目标与当前对话目标不符，优先拒绝
- 如果工具参数明显错误或危险，标记拒绝
- 只有当工具绝对必要且安全时，才完全批准`

const RESULT_VALIDATION_JUDGE_PROMPT = `你是一个独立的工具结果验证器（MCP Judge）。
你的职责是独立分析工具执行结果，判断是否有隐藏问题。

请输出 JSON 格式的评估结果，包含：
- verdict: "consistent" | "inconsistent" | "uncertain"
- issues: 发现的问题列表，每项包含 toolName, severity("error"|"warning"|"info"), description
- needsReExecution: boolean — 是否需要重新执行某些工具
- additionalContext: 建议追加的额外上下文（可选）
- rationale: 你的分析依据

准则：
- 检查执行结果是否存在错误（exit code ≠ 0、error 字段非空）
- 检查结果是否出乎预期（如空输出、异常长度）
- 检查结果中是否包含可能误导 LLM 的信息`

const REPLY_QUALITY_JUDGE_PROMPT = `你是一个独立的回复质量验证器（MCP Judge）。
你的职责是独立分析 Agent 即将生成的回复，判断是否准确、完整、安全。

请输出 JSON 格式的评估结果，包含：
- verdict: "good" | "acceptable" | "poor"
- issues: 发现的问题列表，每项包含 type("factual_error"|"incomplete"|"misleading"|"style_mismatch"), description
- suggestion: 改进建议
- needsRegeneration: boolean — 是否需要重新生成

准则：
- 检查是否存在事实性错误
- 检查是否遗漏了关键信息
- 检查是否可能误导用户
- 检查语气/风格是否恰当`

// =============================================================================
// McpAgentHybridPipeline
// =============================================================================

export class McpAgentHybridPipeline {
  private llmService: LlmService | null = null
  private arbitrator: McpAgentArbitrator
  private config: HybridPipelineConfig

  /** 最近一次各汇合点的仲裁结果 */
  private lastResults = new Map<ConvergencePointName, ConvergenceResult<unknown>>()

  /** 运行计数 */
  private convergenceCounts: Record<ConvergencePointName, number> = {
    tool_selection: 0,
    result_validation: 0,
    reply_quality: 0,
  }

  /** 是否已初始化 */
  private initialized = false

  constructor(config?: Partial<HybridPipelineConfig>) {
    this.config = { ...DEFAULT_HYBRID_CONFIG, ...config }
    this.arbitrator = new McpAgentArbitrator(config)
  }

  /**
   * 注入 LLM 服务引用（MCP 路径使用 chatJson 做轻量独立判断）。
   */
  setLlmService(service: LlmService): void {
    this.llmService = service
  }

  /**
   * 初始化混合流水线。
   */
  init(): void {
    if (this.initialized) return
    this.initialized = true
    log('INFO', 'mcp_agent_hybrid_init', {
      enabled: this.config.enabled,
      points: this.config.points,
      agentWeight: this.config.agentPathWeight,
      mcpWeight: this.config.mcpPathWeight,
      divergenceThreshold: this.config.divergenceThreshold,
    })
    eventBus.emit('hybrid.mcp_agent.initialized', {
      config: this.config,
      timestamp: Date.now(),
    })
  }

  /**
   * 获取仲裁器引用。
   */
  getArbitrator(): McpAgentArbitrator {
    return this.arbitrator
  }

  /**
   * 检查混合流水线是否已启用。
   */
  isEnabled(): boolean {
    return this.config.enabled
  }

  /**
   * 检查指定汇合点是否已启用。
   */
  isPointEnabled(point: ConvergencePointName): boolean {
    return this.config.enabled && this.config.points[point]
  }

  /**
   * 启用/禁用混合流水线。
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled
    log('INFO', 'mcp_agent_hybrid_enabled', { enabled })
  }

  /**
   * 更新配置。
   */
  updateConfig(partial: Partial<HybridPipelineConfig>): void {
    this.config = { ...this.config, ...partial }
    log('INFO', 'mcp_agent_hybrid_config_updated', {
      enabled: this.config.enabled,
      points: this.config.points,
    })
  }

  /**
   * 获取当前配置。
   */
  getConfig(): HybridPipelineConfig {
    return { ...this.config }
  }

  // =============================================================================
  // 汇合点 1：工具选择验证
  // =============================================================================

  /**
   * 验证 LLM 选择的工具集。
   *
   * 路径 A（Agent）：LLM 通过 chatWithTools 返回的 toolCalls
   * 路径 B（MCP）：独立 chatJson 调用做工具适宜性分析
   *
   * @param toolCalls   LLM 返回的待执行工具调用
   * @param contextText 当前上下文摘要（用于 MCP 路径分析）
   * @param requestId   请求 ID（可选）
   * @returns 仲裁结果，或 null（任一通道无数据）
   */
  async validateToolSelection(
    toolCalls: ToolCallInfo[],
    contextText: string,
    requestId?: string,
  ): Promise<ConvergenceResult<ToolSelectionVerdict> | null> {
    if (!this.isPointEnabled('tool_selection') || !toolCalls.length) return null

    const rid = requestId || createRequestId()

    // ── 路径 A：Agent 路径 —— 从 toolCalls 构建基线 ──
    const agentVerdict = this.buildAgentToolSelection(toolCalls)

    // ── 路径 B：MCP 路径 —— 独立分析 ──
    const mcpResult = await this.runMcpToolSelection(toolCalls, contextText, rid)

    // ── 汇合：仲裁 ──
    const agentOutput: HybridPathOutput<ToolSelectionVerdict> = {
      path: 'agent',
      output: agentVerdict,
      confidence: AGENT_BASE_CONFIDENCE,
    }

    const mcpOutput: HybridPathOutput<ToolSelectionVerdict> = {
      path: 'mcp',
      output: mcpResult.verdict,
      confidence: mcpResult.confidence ?? MCP_BASE_CONFIDENCE,
      metadata: { mcpLatencyMs: mcpResult.latencyMs },
    }

    const result = this.arbitrator.arbitrate<ToolSelectionVerdict>(
      'tool_selection',
      agentOutput,
      mcpOutput,
      mcpResult.latencyMs,
    )

    this.recordConvergence('tool_selection', result)

    eventBus.emit('hybrid.tool_selection.completed', {
      point: 'tool_selection',
      divergenceScore: result.divergenceScore,
      method: result.arbitrationMethod,
      approvedCount: result.arbitratedOutput.approvedTools.length,
      rejectedCount: result.arbitratedOutput.rejectedTools.length,
      assessment: result.arbitratedOutput.assessment,
      durationMs: result.durationMs,
      timestamp: Date.now(),
    })

    if (this.config.verbose) {
      log('INFO', 'hybrid_tool_selection', {
        request_id: rid,
        divergenceScore: result.divergenceScore.toFixed(3),
        method: result.arbitrationMethod,
        agentApproved: agentVerdict.approvedTools.length,
        mcpApproved: mcpResult.verdict.approvedTools.length,
        finalAssessment: result.arbitratedOutput.assessment,
        mcpLatencyMs: mcpResult.latencyMs,
      })
    }

    return result
  }

  /**
   * Agent 路径的工具选择构建：将 toolCalls 映射为「全部批准」基线。
   */
  private buildAgentToolSelection(toolCalls: ToolCallInfo[]): ToolSelectionVerdict {
    return {
      approvedTools: toolCalls.map((t) => t.name),
      rejectedTools: [],
      suggestedAdditionalTools: [],
      assessment: 'approved',
      rationale: 'Agent 原始路径: LLM 选择了这些工具',
    }
  }

  /**
   * MCP 路径的工具选择分析：使用 chatJson 做独立判断。
   */
  private async runMcpToolSelection(
    toolCalls: ToolCallInfo[],
    contextText: string,
    requestId: string,
  ): Promise<{ verdict: ToolSelectionVerdict; confidence: number; latencyMs: number }> {
    const t0 = Date.now()

    try {
      if (!this.llmService) {
        // LLM 服务不可用时，回退到与 Agent 一致的判定
        return {
          verdict: this.buildAgentToolSelection(toolCalls),
          confidence: 0.4,
          latencyMs: Date.now() - t0,
        }
      }

      const toolList = toolCalls
        .map((t) => `- ${t.name}(${JSON.stringify(t.arguments)})`)
        .join('\n')

      const userText = `## 当前上下文\n${contextText.slice(0, 1000)}\n\n## 待执行工具\n${toolList}\n\n请判断这些工具是否合适。`

      const result = await this.llmService.chatJson(userText, {
        system: TOOL_SELECTION_JUDGE_PROMPT,
        temperature: 0.2,
        timeoutMs: this.config.mcpTimeoutMs,
        requestId,
      })

      if (result.error || !result.data) {
        log('WARN', 'hybrid_mcp_tool_selection_failed', {
          request_id: requestId,
          error: result.error,
        })
        return {
          verdict: this.buildAgentToolSelection(toolCalls),
          confidence: 0.4,
          latencyMs: Date.now() - t0,
        }
      }

      const data = result.data as Partial<ToolSelectionVerdict>
      return {
        verdict: {
          approvedTools: Array.isArray(data.approvedTools) ? data.approvedTools : toolCalls.map((t) => t.name),
          rejectedTools: Array.isArray(data.rejectedTools) ? data.rejectedTools : [],
          suggestedAdditionalTools: Array.isArray(data.suggestedAdditionalTools) ? data.suggestedAdditionalTools : [],
          assessment: (data.assessment as ToolSelectionVerdict['assessment']) || 'approved',
          rationale: data.rationale || 'MCP 分析完成',
        },
        confidence: MCP_BASE_CONFIDENCE,
        latencyMs: Date.now() - t0,
      }
    } catch (err) {
      log('WARN', 'hybrid_mcp_tool_selection_error', {
        request_id: requestId,
        error: String(err),
      })
      return {
        verdict: this.buildAgentToolSelection(toolCalls),
        confidence: 0.3,
        latencyMs: Date.now() - t0,
      }
    }
  }

  // =============================================================================
  // 汇合点 2：结果验证
  // =============================================================================

  /**
   * 验证工具执行结果。
   *
   * 路径 A（Agent）：从 ToolResult 格式提取验证结论
   * 路径 B（MCP）：独立 chatJson 调用做结果分析
   *
   * @param toolResults 工具执行结果列表
   * @param contextText 当前上下文摘要（用于 MCP 路径分析）
   * @param requestId   请求 ID（可选）
   * @returns 仲裁结果，或 null
   */
  async validateResults(
    toolResults: ToolResult[],
    contextText: string,
    requestId?: string,
  ): Promise<ConvergenceResult<ResultValidationOutput> | null> {
    if (!this.isPointEnabled('result_validation') || !toolResults.length) return null

    const rid = requestId || createRequestId()

    // ── 路径 A：Agent 路径 —— 从 ToolResult 构建基线 ──
    const agentOutput = this.buildAgentResultValidation(toolResults)

    // ── 路径 B：MCP 路径 —— 独立分析 ──
    const mcpResult = await this.runMcpResultValidation(toolResults, contextText, rid)

    const agentPathOutput: HybridPathOutput<ResultValidationOutput> = {
      path: 'agent',
      output: agentOutput,
      confidence: AGENT_BASE_CONFIDENCE,
    }

    const mcpPathOutput: HybridPathOutput<ResultValidationOutput> = {
      path: 'mcp',
      output: mcpResult.verdict,
      confidence: mcpResult.confidence ?? MCP_BASE_CONFIDENCE,
      metadata: { mcpLatencyMs: mcpResult.latencyMs },
    }

    const result = this.arbitrator.arbitrate<ResultValidationOutput>(
      'result_validation',
      agentPathOutput,
      mcpPathOutput,
      mcpResult.latencyMs,
    )

    this.recordConvergence('result_validation', result)

    eventBus.emit('hybrid.result_validation.completed', {
      point: 'result_validation',
      divergenceScore: result.divergenceScore,
      method: result.arbitrationMethod,
      verdict: result.arbitratedOutput.verdict,
      issueCount: result.arbitratedOutput.issues.length,
      needsReExecution: result.arbitratedOutput.needsReExecution,
      durationMs: result.durationMs,
      timestamp: Date.now(),
    })

    if (this.config.verbose) {
      log('INFO', 'hybrid_result_validation', {
        request_id: rid,
        divergenceScore: result.divergenceScore.toFixed(3),
        method: result.arbitrationMethod,
        agentVerdict: agentOutput.verdict,
        mcpVerdict: mcpResult.verdict.verdict,
        finalVerdict: result.arbitratedOutput.verdict,
        mcpLatencyMs: mcpResult.latencyMs,
      })
    }

    return result
  }

  /**
   * Agent 路径的结果验证：从 ToolResult 提取已知错误。
   */
  private buildAgentResultValidation(toolResults: ToolResult[]): ResultValidationOutput {
    const issues: ResultValidationOutput['issues'] = []
    for (const r of toolResults) {
      if (!r.success) {
        issues.push({
          toolName: r.name,
          severity: 'error',
          description: r.error || '工具执行失败',
        })
      }
      if (r.latencyMs > 10000) {
        issues.push({
          toolName: r.name,
          severity: 'warning',
          description: `工具执行耗时 ${r.latencyMs}ms（较慢）`,
        })
      }
      if (r.success && !r.content?.trim()) {
        issues.push({
          toolName: r.name,
          severity: 'info',
          description: '工具返回空结果',
        })
      }
    }

    return {
      verdict: issues.some((i) => i.severity === 'error') ? 'inconsistent' : 'consistent',
      issues,
      needsReExecution: issues.some((i) => i.severity === 'error'),
      rationale: issues.length > 0
        ? `Agent 路径检测到 ${issues.length} 个问题`
        : 'Agent 路径: 所有工具执行成功',
    }
  }

  /**
   * MCP 路径的结果验证：独立分析工具执行结果。
   */
  private async runMcpResultValidation(
    toolResults: ToolResult[],
    contextText: string,
    requestId: string,
  ): Promise<{ verdict: ResultValidationOutput; confidence: number; latencyMs: number }> {
    const t0 = Date.now()

    try {
      if (!this.llmService) {
        return {
          verdict: this.buildAgentResultValidation(toolResults),
          confidence: 0.4,
          latencyMs: Date.now() - t0,
        }
      }

      const resultsText = toolResults
        .map((r) =>
          `- ${r.name}: ${r.success ? '成功' : '失败'}\n  ${r.content?.slice(0, 200) || ''}\n  ${r.error ? `错误: ${r.error}` : ''}`
        )
        .join('\n')

      const userText = `## 当前上下文\n${contextText.slice(0, 800)}\n\n## 工具执行结果\n${resultsText}\n\n请分析这些结果是否存在隐藏问题。`

      const result = await this.llmService.chatJson(userText, {
        system: RESULT_VALIDATION_JUDGE_PROMPT,
        temperature: 0.2,
        timeoutMs: this.config.mcpTimeoutMs,
        requestId,
      })

      if (result.error || !result.data) {
        return {
          verdict: this.buildAgentResultValidation(toolResults),
          confidence: 0.4,
          latencyMs: Date.now() - t0,
        }
      }

      const data = result.data as Partial<ResultValidationOutput>
      return {
        verdict: {
          verdict: (data.verdict as ResultValidationOutput['verdict']) || 'uncertain',
          issues: Array.isArray(data.issues) ? data.issues : [],
          needsReExecution: !!data.needsReExecution,
          additionalContext: data.additionalContext,
          rationale: data.rationale || 'MCP 分析完成',
        },
        confidence: MCP_BASE_CONFIDENCE,
        latencyMs: Date.now() - t0,
      }
    } catch (err) {
      log('WARN', 'hybrid_mcp_result_validation_error', {
        request_id: requestId,
        error: String(err),
      })
      return {
        verdict: this.buildAgentResultValidation(toolResults),
        confidence: 0.3,
        latencyMs: Date.now() - t0,
      }
    }
  }

  // =============================================================================
  // 汇合点 3：回复质量
  // =============================================================================

  /**
   * 验证 Agent 回复质量。
   *
   * 路径 A（Agent）：从原始回复提取质量基线
   * 路径 B（MCP）：独立 chatJson 调用做质量分析
   *
   * @param reply       Agent 回复文本
   * @param contextText 当前上下文摘要
   * @param requestId   请求 ID（可选）
   * @returns 仲裁结果，或 null
   */
  async validateReplyQuality(
    reply: string,
    contextText: string,
    requestId?: string,
  ): Promise<ConvergenceResult<ReplyQualityOutput> | null> {
    if (!this.isPointEnabled('reply_quality') || !reply?.trim()) return null

    const rid = requestId || createRequestId()

    // ── 路径 A：Agent 路径 —— 默认基线（回复已生成，视为 good） ──
    const agentOutput: ReplyQualityOutput = {
      verdict: 'good',
      issues: [],
      suggestion: '',
      needsRegeneration: false,
    }

    // ── 路径 B：MCP 路径 —— 独立质量分析 ──
    const mcpResult = await this.runMcpReplyQuality(reply, contextText, rid)

    const agentPathOutput: HybridPathOutput<ReplyQualityOutput> = {
      path: 'agent',
      output: agentOutput,
      confidence: AGENT_BASE_CONFIDENCE,
    }

    const mcpPathOutput: HybridPathOutput<ReplyQualityOutput> = {
      path: 'mcp',
      output: mcpResult.verdict,
      confidence: mcpResult.confidence ?? MCP_BASE_CONFIDENCE,
      metadata: { mcpLatencyMs: mcpResult.latencyMs },
    }

    const result = this.arbitrator.arbitrate<ReplyQualityOutput>(
      'reply_quality',
      agentPathOutput,
      mcpPathOutput,
      mcpResult.latencyMs,
    )

    this.recordConvergence('reply_quality', result)

    eventBus.emit('hybrid.reply_quality.completed', {
      point: 'reply_quality',
      divergenceScore: result.divergenceScore,
      method: result.arbitrationMethod,
      verdict: result.arbitratedOutput.verdict,
      needsRegeneration: result.arbitratedOutput.needsRegeneration,
      issueCount: result.arbitratedOutput.issues.length,
      durationMs: result.durationMs,
      timestamp: Date.now(),
    })

    if (this.config.verbose) {
      log('INFO', 'hybrid_reply_quality', {
        request_id: rid,
        divergenceScore: result.divergenceScore.toFixed(3),
        method: result.arbitrationMethod,
        mcpVerdict: mcpResult.verdict.verdict,
        finalVerdict: result.arbitratedOutput.verdict,
        needsRegeneration: result.arbitratedOutput.needsRegeneration,
        mcpLatencyMs: mcpResult.latencyMs,
      })
    }

    return result
  }

  /**
   * MCP 路径的回复质量分析。
   */
  private async runMcpReplyQuality(
    reply: string,
    contextText: string,
    requestId: string,
  ): Promise<{ verdict: ReplyQualityOutput; confidence: number; latencyMs: number }> {
    const t0 = Date.now()

    try {
      if (!this.llmService) {
        return {
          verdict: { verdict: 'good', issues: [], suggestion: '', needsRegeneration: false },
          confidence: 0.3,
          latencyMs: Date.now() - t0,
        }
      }

      const userText = `## 当前上下文\n${contextText.slice(0, 800)}\n\n## 回复文本\n${reply.slice(0, 2000)}\n\n请分析回复质量。`

      const result = await this.llmService.chatJson(userText, {
        system: REPLY_QUALITY_JUDGE_PROMPT,
        temperature: 0.2,
        timeoutMs: this.config.mcpTimeoutMs,
        requestId,
      })

      if (result.error || !result.data) {
        return {
          verdict: { verdict: 'acceptable', issues: [], suggestion: '', needsRegeneration: false },
          confidence: 0.3,
          latencyMs: Date.now() - t0,
        }
      }

      const data = result.data as Partial<ReplyQualityOutput>
      return {
        verdict: {
          verdict: (data.verdict as ReplyQualityOutput['verdict']) || 'acceptable',
          issues: Array.isArray(data.issues) ? data.issues : [],
          suggestion: data.suggestion || '',
          needsRegeneration: !!data.needsRegeneration,
        },
        confidence: MCP_BASE_CONFIDENCE,
        latencyMs: Date.now() - t0,
      }
    } catch (err) {
      log('WARN', 'hybrid_mcp_reply_quality_error', {
        request_id: requestId,
        error: String(err),
      })
      return {
        verdict: { verdict: 'acceptable', issues: [], suggestion: '', needsRegeneration: false },
        confidence: 0.3,
        latencyMs: Date.now() - t0,
      }
    }
  }

  // =============================================================================
  // 内部方法
  // =============================================================================

  private recordConvergence(point: ConvergencePointName, result: ConvergenceResult<unknown>): void {
    this.convergenceCounts[point]++
    this.lastResults.set(point, result)
  }

  // =============================================================================
  // 查询接口
  // =============================================================================

  /**
   * 获取指定汇合点的最近一次仲裁结果。
   */
  getLastResult(point: ConvergencePointName): ConvergenceResult<unknown> | undefined {
    return this.lastResults.get(point)
  }

  /**
   * 获取混合流水线运行指标。
   */
  getMetrics(): HybridPipelineMetrics {
    const total = Object.values(this.convergenceCounts).reduce((s, c) => s + c, 0)
    const arbMetrics = this.arbitrator.getMetrics()
    return {
      totalConvergences: total,
      perPointCount: { ...this.convergenceCounts },
      perMethodCount: { ...arbMetrics.perMethodCount },
      avgDivergence: arbMetrics.avgDivergence,
      avgMcpLatencyMs: arbMetrics.avgMcpLatencyMs,
      lastRunAt: Date.now(),
    }
  }
}

// ===== 单例（可选，也可通过 DI 注入）=====
export const mcpAgentHybridPipeline = new McpAgentHybridPipeline()
