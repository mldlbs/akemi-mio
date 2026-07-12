/**
 * HybridArbitrator — MCP-Agent 混合流水线仲裁器
 *
 * 职责：
 * 1. 对比 Agent 路径和 MCP 路径在同一个汇合点的输出
 * 2. 计算分歧度（divergence score）
 * 3. 在分歧超过阈值时触发仲裁
 * 4. 仲裁方法：置信度择优 / 加权融合
 *
 * 仲裁策略：
 * - 分歧度 < 阈值 → 视为一致，直接采用置信度较高的结果
 * - 分歧度 >= 阈值 → 触发仲裁：
 *   - 类别型输出：置信度择优（pick by confidence）
 *   - 列表型输出：加权融合（weighted fusion）
 *   - 数值型输出：加权平均
 */

import { log } from '../logger/Logger'
import { DEFAULT_HYBRID_CONFIG } from './types'
import type {
  HybridPathOutput,
  ConvergenceResult,
  ConvergencePointName,
  ToolSelectionVerdict,
  ResultValidationOutput,
  ReplyQualityOutput,
  HybridPipelineConfig,
} from './types'

// =============================================================================
// 仲裁器
// =============================================================================

export class McpAgentArbitrator {
  private config: HybridPipelineConfig
  private totalArbitrations = 0
  private perMethodCount: Record<string, number> = {
    identical: 0,
    pick_agent: 0,
    pick_mcp: 0,
    weighted_fusion: 0,
  }
  private totalDivergenceSum = 0
  private totalMcpLatencyMs = 0
  private mcpCallCount = 0

  constructor(config?: Partial<HybridPipelineConfig>) {
    this.config = { ...DEFAULT_HYBRID_CONFIG, ...config }
  }

  /**
   * 对双路径输出进行仲裁。
   *
   * @param point    汇合点名称
   * @param agent    Agent 路径输出
   * @param mcp      MCP 路径输出
   * @param mcpLatencyMs MCP 路径执行耗时（毫秒）
   * @returns 仲裁结果
   */
  arbitrate<T>(
    point: ConvergencePointName,
    agent: HybridPathOutput<T>,
    mcp: HybridPathOutput<T>,
    mcpLatencyMs = 0,
  ): ConvergenceResult<T> {
    this.mcpCallCount++
    this.totalMcpLatencyMs += mcpLatencyMs

    const divergenceScore = this.computeDivergence(point, agent.output, mcp.output)

    let arbitratedOutput: T
    let method: ConvergenceResult<T>['arbitrationMethod']
    let rationale: string

    if (divergenceScore < this.config.divergenceThreshold) {
      // 分歧小 → 视为一致，取置信度高的结果
      if (agent.confidence >= mcp.confidence) {
        arbitratedOutput = agent.output
        method = 'identical'
        rationale =
          `分歧度 ${divergenceScore.toFixed(3)} < 阈值 ${this.config.divergenceThreshold}，` +
          `采用置信度更高的 Agent 路径 (${agent.confidence} ≥ ${mcp.confidence})`
      } else {
        arbitratedOutput = mcp.output
        method = 'identical'
        rationale =
          `分歧度 ${divergenceScore.toFixed(3)} < 阈值 ${this.config.divergenceThreshold}，` +
          `采用置信度更高的 MCP 路径 (${mcp.confidence} > ${agent.confidence})`
      }
    } else {
      // 分歧大 → 触发仲裁
      const result = this.resolveConflict(point, agent, mcp, divergenceScore)
      arbitratedOutput = result.output as T
      method = result.method
      rationale = result.rationale
    }

    this.totalArbitrations++
    this.totalDivergenceSum += divergenceScore
    this.perMethodCount[method]++

    if (this.config.verbose) {
      log('INFO', 'hybrid_arbitration_result', {
        point,
        method,
        divergenceScore: divergenceScore.toFixed(3),
        agentConfidence: agent.confidence,
        mcpConfidence: mcp.confidence,
        rationale,
      })
    }

    return {
      point,
      agentOutput: agent,
      mcpOutput: mcp,
      divergenceScore,
      arbitratedOutput,
      arbitrationMethod: method,
      rationale,
      durationMs: mcpLatencyMs,
    }
  }

  /**
   * 计算分歧度（0=完全一致，1=完全分歧）。
   * 根据汇合点类型采用不同的比较策略。
   */
  private computeDivergence<T>(point: ConvergencePointName, a: T, b: T): number {
    switch (point) {
      case 'tool_selection':
        return this.divergenceForToolSelection(
          a as unknown as ToolSelectionVerdict,
          b as unknown as ToolSelectionVerdict,
        )
      case 'result_validation':
        return this.divergenceForResultValidation(
          a as unknown as ResultValidationOutput,
          b as unknown as ResultValidationOutput,
        )
      case 'reply_quality':
        return this.divergenceForReplyQuality(
          a as unknown as ReplyQualityOutput,
          b as unknown as ReplyQualityOutput,
        )
      default:
        return JSON.stringify(a) === JSON.stringify(b) ? 0 : 0.5
    }
  }

  /**
   * 工具选择分歧度：比较批准/拒绝/建议的工具集。
   */
  private divergenceForToolSelection(
    agent: ToolSelectionVerdict,
    mcp: ToolSelectionVerdict,
  ): number {
    // 评估结果不一致 → 高分歧
    if (agent.assessment !== mcp.assessment) return 0.7

    const allApproved = new Set([...agent.approvedTools, ...mcp.approvedTools])
    if (allApproved.size === 0) return 0

    // Jaccard 距离：比较 approved 工具集
    const agentSet = new Set(agent.approvedTools)
    const mcpSet = new Set(mcp.approvedTools)
    const intersection = new Set([...agentSet].filter((t) => mcpSet.has(t)))
    const union = new Set([...agentSet, ...mcpSet])
    const jaccardApproved = 1 - intersection.size / union.size

    // 拒绝工具分歧：一方拒绝而另一方未拒绝
    let rejectionDivergence = 0
    const allRejected = new Set([...agent.rejectedTools, ...mcp.rejectedTools])
    if (allRejected.size > 0) {
      const agentRejectSet = new Set(agent.rejectedTools)
      const mcpRejectSet = new Set(mcp.rejectedTools)
      const rejectIntersection = new Set([...agentRejectSet].filter((t) => mcpRejectSet.has(t)))
      const rejectUnion = new Set([...agentRejectSet, ...mcpRejectSet])
      rejectionDivergence = 1 - rejectIntersection.size / rejectUnion.size
    }

    // 加权综合
    return jaccardApproved * 0.6 + rejectionDivergence * 0.4
  }

  /**
   * 结果验证分歧度：比较 verdict + issue 重叠度。
   */
  private divergenceForResultValidation(
    agent: ResultValidationOutput,
    mcp: ResultValidationOutput,
  ): number {
    // 判定不一致 → 高分歧
    if (agent.verdict !== mcp.verdict) {
      return agent.verdict === 'consistent' && mcp.verdict === 'consistent' ? 0 : 0.6
    }

    // 比较 issue 列表
    const agentIssueDescs = new Set(agent.issues.map((i) => i.description))
    const mcpIssueDescs = new Set(mcp.issues.map((i) => i.description))
    if (agentIssueDescs.size === 0 && mcpIssueDescs.size === 0) return 0
    if (agentIssueDescs.size === 0 || mcpIssueDescs.size === 0) return 0.5

    const intersection = new Set([...agentIssueDescs].filter((d) => mcpIssueDescs.has(d)))
    const union = new Set([...agentIssueDescs, ...mcpIssueDescs])
    return 1 - intersection.size / union.size
  }

  /**
   * 回复质量分歧度：比较 verdict + issue 类型。
   */
  private divergenceForReplyQuality(
    agent: ReplyQualityOutput,
    mcp: ReplyQualityOutput,
  ): number {
    // 判定不一致 → 高分歧
    if (agent.verdict !== mcp.verdict) {
      const order = ['good', 'acceptable', 'poor']
      const agentIdx = order.indexOf(agent.verdict)
      const mcpIdx = order.indexOf(mcp.verdict)
      return Math.abs(agentIdx - mcpIdx) / (order.length - 1)
    }

    // 相同 verdict 时比较 issue 类型分布
    const agentIssueTypes = new Set(agent.issues.map((i) => i.type))
    const mcpIssueTypes = new Set(mcp.issues.map((i) => i.type))
    if (agentIssueTypes.size === 0 && mcpIssueTypes.size === 0) return 0

    const intersection = new Set([...agentIssueTypes].filter((t) => mcpIssueTypes.has(t)))
    const union = new Set([...agentIssueTypes, ...mcpIssueTypes])
    return 1 - intersection.size / union.size
  }

  // =============================================================================
  // 冲突解决
  // =============================================================================

  private resolveConflict<T>(
    point: ConvergencePointName,
    agent: HybridPathOutput<T>,
    mcp: HybridPathOutput<T>,
    divergenceScore: number,
  ): { output: unknown; method: ConvergenceResult<T>['arbitrationMethod']; rationale: string } {
    switch (point) {
      case 'tool_selection':
        return this.resolveToolSelectionConflict(
          agent as unknown as HybridPathOutput<ToolSelectionVerdict>,
          mcp as unknown as HybridPathOutput<ToolSelectionVerdict>,
        )
      case 'result_validation':
        return this.resolveResultValidationConflict(
          agent as unknown as HybridPathOutput<ResultValidationOutput>,
          mcp as unknown as HybridPathOutput<ResultValidationOutput>,
        )
      case 'reply_quality':
        return this.resolveReplyQualityConflict(
          agent as unknown as HybridPathOutput<ReplyQualityOutput>,
          mcp as unknown as HybridPathOutput<ReplyQualityOutput>,
          divergenceScore,
        )
      default:
        return this.pickByConfidence(agent, mcp)
    }
  }

  /**
   * 工具选择冲突解决：
   * - Agent 高置信度（>= 0.7）或 agentPathWeight 优势大 → 采纳 Agent
   * - MCP 高置信度（>= 0.7） → 采纳 MCP
   * - 否则加权融合：approve 取并集，reject 取交集
   */
  private resolveToolSelectionConflict(
    agent: HybridPathOutput<ToolSelectionVerdict>,
    mcp: HybridPathOutput<ToolSelectionVerdict>,
  ): { output: ToolSelectionVerdict; method: 'weighted_fusion' | 'pick_agent' | 'pick_mcp'; rationale: string } {
    // Agent 高置信度且权重优势 → 采纳 Agent
    if (agent.confidence >= 0.7 && this.config.agentPathWeight >= this.config.mcpPathWeight * 1.5) {
      return {
        output: agent.output,
        method: 'pick_agent',
        rationale: `Agent 置信度高 (${agent.confidence}) 且权重优势明显 (${this.config.agentPathWeight} vs ${this.config.mcpPathWeight})，采纳 Agent 路径`,
      }
    }

    // MCP 高置信度且与 Agent 有分歧 → 采纳 MCP（保守策略）
    if (mcp.confidence >= 0.7 && agent.output.assessment !== mcp.output.assessment) {
      return {
        output: mcp.output,
        method: 'pick_mcp',
        rationale: `MCP 置信度高 (${mcp.confidence}) 且与 Agent 分歧，保守采纳 MCP 路径`,
      }
    }

    // 加权融合
    const approvedSet = new Set([...agent.output.approvedTools, ...mcp.output.approvedTools])
    // rejected 取交集（只有双方都拒绝才拒绝）
    const agentRejectSet = new Set(agent.output.rejectedTools)
    const mcpRejectSet = new Set(mcp.output.rejectedTools)
    const rejectedIntersection = [...agentRejectSet].filter((t) => mcpRejectSet.has(t))
    // suggested 取并集
    const suggestedSet = new Set([
      ...agent.output.suggestedAdditionalTools,
      ...mcp.output.suggestedAdditionalTools,
    ])
    // 排除被拒绝的工具
    const finalApproved = [...approvedSet].filter((t) => !rejectedIntersection.includes(t))

    return {
      output: {
        approvedTools: finalApproved,
        rejectedTools: rejectedIntersection,
        suggestedAdditionalTools: [...suggestedSet].filter((t) => !finalApproved.includes(t)),
        assessment:
          rejectedIntersection.length > finalApproved.length
            ? 'rejected'
            : rejectedIntersection.length > 0
              ? 'partially_approved'
              : 'approved',
        rationale: `加权融合：Agent approve ${agent.output.approvedTools.length} / reject ${agent.output.rejectedTools.length}，MCP approve ${mcp.output.approvedTools.length} / reject ${mcp.output.rejectedTools.length}，融合后 approve ${finalApproved.length} / reject ${rejectedIntersection.length}`,
      },
      method: 'weighted_fusion',
      rationale: `工具选择分歧，执行加权融合：Agent 路径 ${this.config.agentPathWeight} + MCP 路径 ${this.config.mcpPathWeight}`,
    }
  }

  /**
   * 结果验证冲突解决：取更严格的判定。
   */
  private resolveResultValidationConflict(
    agent: HybridPathOutput<ResultValidationOutput>,
    mcp: HybridPathOutput<ResultValidationOutput>,
  ): { output: ResultValidationOutput; method: 'pick_agent' | 'pick_mcp'; rationale: string } {
    const severityOrder = ['consistent', 'uncertain', 'inconsistent']
    const agentSeverity = severityOrder.indexOf(agent.output.verdict)
    const mcpSeverity = severityOrder.indexOf(mcp.output.verdict)

    // 取更严格的判定（更偏向 inconsistent）
    if (mcpSeverity > agentSeverity) {
      return {
        output: mcp.output,
        method: 'pick_mcp',
        rationale: `MCP 路径判定更严格 (${mcp.output.verdict} > ${agent.output.verdict})，采用 MCP 路径`,
      }
    }
    return {
      output: agent.output,
      method: 'pick_agent',
      rationale: `Agent 路径判定更严格 (${agent.output.verdict} >= ${mcp.output.verdict})，采用 Agent 路径`,
    }
  }

  /**
   * 回复质量冲突解决：取更审慎的判定（偏向指出问题）。
   */
  private resolveReplyQualityConflict(
    agent: HybridPathOutput<ReplyQualityOutput>,
    mcp: HybridPathOutput<ReplyQualityOutput>,
    divergenceScore: number,
  ): { output: ReplyQualityOutput; method: 'pick_agent' | 'pick_mcp'; rationale: string } {
    const qualityOrder = ['good', 'acceptable', 'poor']
    const agentQuality = qualityOrder.indexOf(agent.output.verdict)
    const mcpQuality = qualityOrder.indexOf(mcp.output.verdict)

    // 取更审慎的判定（更偏向 poor）
    if (mcpQuality > agentQuality) {
      return {
        output: mcp.output,
        method: 'pick_mcp',
        rationale: `MCP 路径判定更审慎 (${mcp.output.verdict} < ${agent.output.verdict})，采用 MCP 路径`,
      }
    }
    return {
      output: agent.output,
      method: 'pick_agent',
      rationale: `Agent 路径判定更审慎 (${agent.output.verdict} <= ${mcp.output.verdict})，采用 Agent 路径`,
    }
  }

  // =============================================================================
  // 通用的置信度择优
  // =============================================================================

  private pickByConfidence<T>(
    agent: HybridPathOutput<T>,
    mcp: HybridPathOutput<T>,
  ): { output: T; method: 'pick_agent' | 'pick_mcp'; rationale: string } {
    const better = agent.confidence >= mcp.confidence ? agent : mcp
    const other = agent.confidence >= mcp.confidence ? mcp : agent
    return {
      output: better.output,
      method: better.path === 'agent' ? 'pick_agent' : 'pick_mcp',
      rationale: `采用置信度更高的 ${better.path} 路径 (${better.confidence} ≥ ${other.confidence})`,
    }
  }

  // =============================================================================
  // 指标查询
  // =============================================================================

  getMetrics(): {
    totalArbitrations: number
    perMethodCount: Record<string, number>
    avgDivergence: number
    avgMcpLatencyMs: number
  } {
    return {
      totalArbitrations: this.totalArbitrations,
      perMethodCount: { ...this.perMethodCount },
      avgDivergence: this.totalArbitrations > 0 ? this.totalDivergenceSum / this.totalArbitrations : 0,
      avgMcpLatencyMs: this.mcpCallCount > 0 ? this.totalMcpLatencyMs / this.mcpCallCount : 0,
    }
  }
}
