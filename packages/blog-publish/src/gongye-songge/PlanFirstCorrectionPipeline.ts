/**
 * PlanFirstCorrectionPipeline — 反 MCP 原型：Plan 主导的修正管线
 *
 * ═══════════════════════════════════════════════════════════════════
 *  设计分析：MCP ↔ Plan:修正工业颂歌19-27章 关系反转
 * ═══════════════════════════════════════════════════════════════════
 *
 * ── 当前前提（现状基线）──
 *
 * 前提 A：主从关系
 *   MCP 是基础设施容器，Plan 是 MCP 体系中执行的一个工具。
 *   证据：PlanTools.ts 定义 create_dev_plan 等工具，通过 MCP 工具注册表暴露；
 *         MCP LocalProvider 统一派发所有工具，包括 Plan 工具。
 *
 * 前提 B：执行顺序
 *   MCP 工具选择验证 → Agent 工具循环（含 Plan 工具） → MCP 结果验证。
 *   证据：McpAgentHybridPipeline.validateToolSelection() 在 Agent 执行前先做 MCP 路径验证；
 *         Convergence Point 1（tool_selection）发生在 Plan 执行之前。
 *
 * 前提 C：决策权
 *   MCP 仲裁器决定工具是否可用，Plan 仅按 MCP 过滤后的工具列表执行。
 *   证据：仲裁器中 MCP 路径可 reject tools（拦截/移除），Plan 无权否决。
 *
 * 前提 D：质量定义
 *   MCP 判定回复质量（ReplyQualityOutput.verdict），Plan 只是内容生产者。
 *   证据：ReplyQualityJudgePrompt 定义质量标准，Plan 不需要输出质量评估。
 *
 * ── 反转分析（每个前提的反向版本 + 可行性）──
 *
 * 反转 1: Plan 主、MCP 从
 *   Plan:修正工业颂歌19-27章 自建执行管线，MCP 作为可选验证子模块。
 *   可行性：高。Plan 已有完整章节评估能力（PlanSonggeCorrectionAdapter），
 *     将 MCP 格式化为 Plan 的可选下游步骤即可。不需要修改 MCP 基础设施。
 *
 * 反转 2: Plan 先执行、MCP 后验证
 *   Plan 完成章节修正评估后，MCP 独立验证 Plan 输出的一致性。
 *   可行性：中。需要定义 Plan→MCP 的新契约（PlanResult → MCPInput），
 *     但 MCP 的 chatJson 接口可以复用。
 *
 * 反转 3: Plan 决定工具选择、MCP 跟随
 *   Plan 定义需要哪些工具（correction_adapter / formatter / memory），
 *   MCP 按 Plan 指定的路径执行。
 *   可行性：中低。Plan 当前是纯数据类（评分+建议），不包含工具调度逻辑，
 *     需要引入 Plan 层的工具选择策略。
 *
 * 反转 4: Plan 定义质量标准、MCP 执行检查
 *   Plan:修正工业颂歌19-27章 的质量判定维度（designDocMatch 等）成为权威标准，
 *   MCP 的质量验证引用 Plan 的评分体系。
 *   可行性：中。MCP 的 judge prompt 可注入 Plan 的评判维度作为参考标准。
 *
 * ── 选择的原型方向：反转 1 + 部分反转 2 ──
 *   PlanFirstCorrectionPipeline 实现 Plan 主导的章节修正管线，
 *   MCP 作为可选的后置验证步骤。新文件、零侵入现有代码。
 *
 * ═══════════════════════════════════════════════════════════════════
 *  原型实现：PlanFirstCorrectionPipeline
 * ═══════════════════════════════════════════════════════════════════
 *
 * ── 架构关系（反转后）──
 *   Plan:修正工业颂歌19-27章（主导方）
 *       ↓  执行章节评估 + 生成修正建议
 *   SonggeCorrectionAdapter
 *       ↓  完成评估后
 *   MCP Verify（可选的下游验证方）
 *       ↓  验证 Plan 输出的一致性
 *   用户（接收 Plan 修正结果 + MCP 验证标签）
 *
 * ── 与现有架构的差异 ──
 *   原生 MCP 管线：
 *     MCP 验证工具选择 → Agent 调用 PlanTools → MCP 验证结果 → Agent 回复
 *   本管线（反转后）：
 *     Plan 评估章节 → Plan 生成修正建议 → [可选] MCP 验证 Plan 输出 → 返回结果
 *
 * ── 设计原则 ──
 * - 零侵入：不修改现有 MCP / Plan / Agent 代码
 * - 可开关：通过 feature flag 控制是否启用 MCP 后置验证
 * - 可降级：MCP 验证失败时透明降级为纯 Plan 输出
 * - 可观测：所有步骤记录日志和事件
 */

import { log, createRequestId } from '@akemi-mio/core/logger/Logger'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import type { LlmService } from '@akemi-mio/intelligence/llm/LlmService'
import {
  SonggeCorrectionAdapter,
  songgeCorrectionAdapter,
  type CorrectionInput,
  type CorrectionResult,
  type CorrectionSeverity,
} from '@akemi-mio/blog-publish/gongye-songge/PlanSonggeCorrectionAdapter'
import { formatBasic, detectFormatNeed, type WechatFormatOptions, type FormatResult } from '@akemi-mio/blog-publish/gongye-songge/formatters'

// ═══════════════════════════════════════════════════════════════════
//  类型定义
// ═══════════════════════════════════════════════════════════════════

/** MCP 后置验证的判定结果 */
export interface McpValidationVerdict {
  /** 整体判定 */
  verdict: 'consistent' | 'partially_inconsistent' | 'inconsistent'
  /** 发现的问题 */
  issues: Array<{
    chapterIndex: number
    category: 'scoring_discrepancy' | 'missing_issue' | 'formatting_gap'
    description: string
    severity: 'warning' | 'info'
  }>
  /** 建议追加的操作 */
  suggestedActions: string[]
  /** 验证依据 */
  rationale: string
  /** 置信度 (0-1) */
  confidence: number
  /** 执行耗时 (ms) */
  latencyMs: number
}

/** PlanFirst 管线运行模式 */
export type PlanFirstMode =
  /** 纯 Plan 模式：Plan 评估章节，不调用 MCP 验证 */
  | 'plan_only'
  /** 标准反转模式：Plan 主导 + MCP 后置验证 */
  | 'plan_first_with_mcp_verify'
  /** 纯 MCP 模式（回退到原生架构，与现状一致）*/
  | 'mcp_standard'

/** PlanFirst 管线配置 */
export interface PlanFirstConfig {
  /** 运行模式 */
  mode: PlanFirstMode
  /** MCP 验证超时（毫秒） */
  mcpTimeoutMs: number
  /** 调试模式 */
  debug: boolean
  /** 排版选项（传递给格式化器） */
  formatOptions?: Partial<WechatFormatOptions>
}

/** PlanFirst 管线输出 */
export interface PlanFirstPipelineOutput {
  /** Plan 的章节修正结果 */
  correctionResult: CorrectionResult | null
  /** MCP 后置验证结果（仅 plan_first_with_mcp_verify 模式） */
  mcpValidation?: McpValidationVerdict | null
  /** 是否降级（MCP 验证失败时降级） */
  degraded: boolean
  /** 运行模式 */
  mode: PlanFirstMode
  /** 格式化结果（如果进行了排版） */
  formatResult?: FormatResult | null
  /** 运行耗时 (ms) */
  totalLatencyMs: number
  /** 综合严重程度 */
  overallSeverity: CorrectionSeverity
  /** 运行 ID */
  runId: string
  /** 时间戳 */
  timestamp: number
}

/** Plan 主导的 MCP 验证 prompt */
const MCP_VERIFY_PROMPT = `你是一个独立的 Plan 输出验证器（Post-Plan Validator）。
你的职责是在 Plan:修正工业颂歌19-27章 完成章节评估后，独立验证其输出的合理性。

请输出 JSON 格式的评估结果：
- verdict: "consistent" | "partially_inconsistent" | "inconsistent"
- issues: 发现的问题列表，每项包含 chapterIndex, category("scoring_discrepancy"|"missing_issue"|"formatting_gap"), description, severity("warning"|"info")
- suggestedActions: 建议 Plan 追加的操作
- rationale: 你的分析依据

注意：
- Plan 的评估维度包括：设计文档符合度、风格一致性、结构准确性、内容质量、情节连续性
- 你的角色是验证 Plan 的判定是否合理，不是重复 Plan 的评分
- 如果 Plan 漏掉了明显需要修正的内容，标记为 missing_issue
- 如果 Plan 的评分与你的直觉偏离较大，标记为 scoring_discrepancy
- 默认倾向 consistent，有明确证据才标记不一致`

// ═══════════════════════════════════════════════════════════════════
//  PlanFirstCorrectionPipeline
// ═══════════════════════════════════════════════════════════════════

/**
 * PlanFirstCorrectionPipeline — 反 MCP 原型
 *
 * Plan:修正工业颂歌19-27章 作为主导方执行章节修正管线，
 * MCP 作为可选的后置验证步骤。
 *
 * 本原型验证「反转 1（Plan 主、MCP 从）」+「反转 2（Plan 先执行、MCP 后验证）」
 * 的可行性及效果。
 *
 * ── 使用示例 ──
 * ```ts
 * const pipeline = new PlanFirstCorrectionPipeline({ mode: 'plan_first_with_mcp_verify' })
 *
 * const result = await pipeline.execute({
 *   chapters: { 19: '...', 20: '...', 27: '...' },
 *   designDoc: '设计文档内容...',
 * })
 *
 * console.log(result.correctionResult?.compositeScore)
 * console.log(result.mcpValidation?.verdict)
 * ```
 */
export class PlanFirstCorrectionPipeline {
  private config: PlanFirstConfig
  private adapter: SonggeCorrectionAdapter
  private llmService: LlmService | null = null

  constructor(config?: Partial<PlanFirstConfig>) {
    this.config = {
      mode: 'plan_first_with_mcp_verify', // 默认反转模式
      mcpTimeoutMs: 5000,
      debug: false,
      ...config,
    }
    this.adapter = songgeCorrectionAdapter

    log('INFO', 'plan_first_pipeline_init', {
      mode: this.config.mode,
      mcpTimeoutMs: this.config.mcpTimeoutMs,
    })
  }

  /**
   * 注入 LLM 服务引用（MCP 后置验证使用 chatJson 做独立分析）。
   */
  setLlmService(service: LlmService): void {
    this.llmService = service
  }

  /**
   * 设置运行模式。
   */
  setMode(mode: PlanFirstMode): void {
    this.config.mode = mode
    log('INFO', 'plan_first_pipeline_mode_set', { mode })
  }

  /**
   * 获取当前配置。
   */
  getConfig(): PlanFirstConfig {
    return { ...this.config }
  }

  // ═════════════════════════════════════════════════════════════
  //  核心执行方法
  // ═════════════════════════════════════════════════════════════

  /**
   * 执行 Plan 主导的章节修正管线。
   *
   * 步骤：
   * 1. Plan 评估：使用 SonggeCorrectionAdapter 对第19-27章做多维度评分
   * 2. Plan 修正建议：基于评分生成修正问题列表
   * 3. [可选] MCP 后置验证：独立验证 Plan 输出的合理性
   * 4. 聚合输出：返回 Plan 修正结果 + MCP 验证标签
   *
   * @param input 修正输入（章节内容 + 设计文档 + 风格指南）
   * @returns 管线输出（含 Plan 修正结果 + MCP 验证）
   */
  async execute(input: CorrectionInput): Promise<PlanFirstPipelineOutput> {
    const t0 = Date.now()
    const runId = createRequestId()

    log('INFO', 'plan_first_pipeline_execute', {
      mode: this.config.mode,
      runId,
      chapterCount: Object.keys(input.chapters).length,
    })

    try {
      // ── 步骤 1 + 2：Plan 评估章节 → 生成修正建议 ──
      const correctionResult = this.adapter.evaluateChapters(input)

      if (!correctionResult || correctionResult.snapshots.length === 0) {
        log('WARN', 'plan_first_pipeline_empty_result', { runId })
        return {
          correctionResult: null,
          degraded: false,
          mode: this.config.mode,
          totalLatencyMs: Date.now() - t0,
          overallSeverity: 'info',
          runId,
          timestamp: Date.now(),
        }
      }

      // ── 步骤 2.5：排版格式化（Plan 内部的格式化能力） ──
      let formatResult: FormatResult | null = null
      if (input.formatOptions || input.styleGuide) {
        const formatText = this.buildFormattedSummary(correctionResult)
        formatResult = formatBasic(formatText, {
          publishReady: true,
          sentenceDensity: 'normal',
          paragraphSpacing: 'normal',
          ...input.formatOptions,
        })
      }

      // ── 步骤 3（可选）：MCP 后置验证 ──
      let mcpValidation: McpValidationVerdict | null = null
      if (this.config.mode === 'plan_first_with_mcp_verify') {
        mcpValidation = await this.runMcpPostVerification(correctionResult, input, runId)
      }

      // 判定是否降级
      const degraded = mcpValidation !== null && mcpValidation.verdict === 'inconsistent'

      if (degraded) {
        log('WARN', 'plan_first_pipeline_degraded', {
          runId,
          mcpIssues: mcpValidation!.issues.length,
        })
      }

      const output: PlanFirstPipelineOutput = {
        correctionResult,
        mcpValidation,
        degraded,
        mode: this.config.mode,
        formatResult,
        totalLatencyMs: Date.now() - t0,
        overallSeverity: correctionResult.severity,
        runId,
        timestamp: Date.now(),
      }

      // 发送事件（可选，供监控/分析消费）
      eventBus.emit('plan_first_pipeline.completed', {
        runId,
        mode: this.config.mode,
        totalLatencyMs: output.totalLatencyMs,
        chaptersEvaluated: correctionResult.snapshots.length,
        totalIssues: correctionResult.totalIssues,
        overallSeverity: correctionResult.severity,
        mcpVerdict: mcpValidation?.verdict,
        degraded,
        timestamp: Date.now(),
      })

      if (this.config.debug) {
        log('INFO', 'plan_first_pipeline_done', {
          runId,
          mode: this.config.mode,
          totalLatencyMs: output.totalLatencyMs,
          chaptersEvaluated: correctionResult.snapshots.length,
          totalIssues: correctionResult.totalIssues,
          overallSeverity: correctionResult.severity,
          mcpVerified: mcpValidation !== null,
          mcpVerdict: mcpValidation?.verdict,
          degraded,
        })
      }

      return output
    } catch (err: any) {
      log('WARN', 'plan_first_pipeline_error', {
        runId,
        error: String(err),
      })

      return {
        correctionResult: null,
        degraded: true,
        mode: this.config.mode,
        totalLatencyMs: Date.now() - t0,
        overallSeverity: 'info',
        runId,
        timestamp: Date.now(),
      }
    }
  }

  // ═════════════════════════════════════════════════════════════
  //  MCP 后置验证
  // ═════════════════════════════════════════════════════════════

  /**
   * MCP 后置验证：在 Plan 完成章节评估后，独立验证 Plan 输出的合理性。
   *
   * 这是「反转 2」的核心实现：
   *   当前：MCP 先验证工具选择 → Plan 再执行
   *   反转：Plan 先执行评估 → MCP 再验证 Plan 输出
   *
   * MCP 在此管线中不再有"工具选择拦截"权限，
   * 而是作为 Plan 输出的审计方，输出验证标签。
   */
  private async runMcpPostVerification(
    correctionResult: CorrectionResult,
    input: CorrectionInput,
    runId: string,
  ): Promise<McpValidationVerdict | null> {
    const t0 = Date.now()

    try {
      if (!this.llmService) {
        log('WARN', 'plan_first_mcp_verify_no_llm', { runId })
        return null
      }

      // 构建 Plan 输出摘要供 MCP 分析
      const planOutputSummary = this.buildPlanOutputSummary(correctionResult, input)

      const result = await this.llmService.chatJson(planOutputSummary, {
        system: MCP_VERIFY_PROMPT,
        temperature: 0.2,
        timeoutMs: this.config.mcpTimeoutMs,
        requestId: runId,
      })

      if (result.error || !result.data) {
        log('WARN', 'plan_first_mcp_verify_failed', {
          runId,
          error: result.error,
        })
        return null
      }

      const data = result.data as Partial<McpValidationVerdict>
      const latencyMs = Date.now() - t0

      const verdict: McpValidationVerdict = {
        verdict: (data.verdict as McpValidationVerdict['verdict']) || 'consistent',
        issues: Array.isArray(data.issues) ? data.issues : [],
        suggestedActions: Array.isArray(data.suggestedActions) ? data.suggestedActions : [],
        rationale: data.rationale || 'MCP 后置验证完成',
        confidence: typeof data.confidence === 'number' ? data.confidence : 0.65,
        latencyMs,
      }

      if (this.config.debug) {
        log('INFO', 'plan_first_mcp_verify_done', {
          runId,
          verdict: verdict.verdict,
          issues: verdict.issues.length,
          latencyMs,
        })
      }

      return verdict
    } catch (err) {
      log('WARN', 'plan_first_mcp_verify_error', {
        runId,
        error: String(err),
      })
      return null
    }
  }

  // ═════════════════════════════════════════════════════════════
  //  辅助方法
  // ═════════════════════════════════════════════════════════════

  /**
   * 构建 Plan 输出摘要（供 MCP 验证消费）。
   *
   * 将 Plan:修正工业颂歌19-27章 的评分结果压缩为结构化文本，
   * 不暴露原始章节全文以减少 token 消耗。
   */
  private buildPlanOutputSummary(result: CorrectionResult, input: CorrectionInput): string {
    const lines: string[] = []

    lines.push(`## Plan:修正工业颂歌19-27章 评估结果`)
    lines.push(`整体复合评分: ${(result.compositeScore * 100).toFixed(1)}%`)
    lines.push(`综合严重程度: ${result.severity}`)
    lines.push(`总问题数: ${result.totalIssues}`)
    lines.push(`需修正章节数: ${result.chaptersNeedingFix}/${result.snapshots.length}`)
    lines.push('')

    for (const snap of result.snapshots) {
      lines.push(`--- 第${snap.chapterIndex}章 ---`)
      lines.push(`  复合评分: ${(snap.compositeScore * 100).toFixed(1)}% | 需要修正: ${snap.needsCorrection}`)
      lines.push(`  设计文档符合度: ${(snap.scores.designDocMatch * 100).toFixed(0)}%`)
      lines.push(`  风格一致性: ${(snap.scores.styleConsistency * 100).toFixed(0)}%`)
      lines.push(`  结构准确性: ${(snap.scores.structuralAccuracy * 100).toFixed(0)}%`)
      lines.push(`  内容质量: ${(snap.scores.contentQuality * 100).toFixed(0)}%`)
      lines.push(`  情节连续性: ${(snap.scores.continuityScore * 100).toFixed(0)}%`)

      if (snap.issues.length > 0) {
        lines.push(`  发现 ${snap.issues.length} 个问题:`)
        for (const issue of snap.issues) {
          lines.push(`    - [${issue.severity}] ${issue.category}: ${issue.description}`)
        }
      }
      lines.push('')
    }

    lines.push('## 请验证 Plan 的输出')
    lines.push('上述是 Plan:修正工业颂歌19-27章 对第19-27章的自动评估结果。')
    lines.push('请独立分析 Plan 的判定是否合理，是否有遗漏或误判。')

    return lines.join('\n')
  }

  /**
   * 构建格式化摘要（Plan 内部格式化能力）。
   * 将修正结果格式化为可读文本。
   */
  private buildFormattedSummary(result: CorrectionResult): string {
    const lines: string[] = []

    lines.push(`# 工业颂歌第19-27章修正评估报告`)
    lines.push('')
    lines.push(`总体得分：${(result.compositeScore * 100).toFixed(1)}% | 严重程度：${result.severity}`)
    lines.push(`需修正章节：${result.chaptersNeedingFix}/${result.snapshots.length}`)
    lines.push('')

    for (const snap of result.snapshots) {
      const status = snap.needsCorrection ? '⚠️ 需要修正' : '✅ 合格'
      lines.push(`## 第${snap.chapterIndex}章 ${status}`)
      lines.push(`评分：${(snap.compositeScore * 100).toFixed(1)}%`)

      if (snap.issues.length > 0) {
        lines.push('')
        lines.push('问题：')
        for (const issue of snap.issues) {
          lines.push(`- [${issue.severity}] ${issue.description}`)
          lines.push(`  建议：${issue.suggestion}`)
        }
      }
      lines.push('')
    }

    return lines.join('\n')
  }

  // ═════════════════════════════════════════════════════════════
  //  查询接口
  // ═════════════════════════════════════════════════════════════

  /**
   * 获取适配器引用（供外部直接调用）。
   */
  getAdapter(): SonggeCorrectionAdapter {
    return this.adapter
  }
}

// ═══════════════════════════════════════════════════════════════════
//  单例
// ═══════════════════════════════════════════════════════════════════

/** 全局单例 — 默认以 plan_first_with_mcp_verify 模式运行 */
export const planFirstCorrectionPipeline = new PlanFirstCorrectionPipeline()
