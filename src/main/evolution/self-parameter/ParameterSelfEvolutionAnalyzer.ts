/**
 * ParameterSelfEvolutionAnalyzer — 记忆驱动的参数自进化分析器（Collector）
 *
 * 每 24 小时扫描 Memory 反馈时间序列数据，分析用户交互指标，
 * 可选使用 LLM 生成参数调整提案，生成 Problem 供执行器消费。
 *
 * 分析维度：
 * 1. 用户满意度趋势 — 点赞/踩数据变化
 * 2. 任务成功率趋势 — 成功/失败任务比例
 * 3. 用户中断率趋势 — 用户打断对话的频率
 * 4. 响应延迟趋势 — 系统回复耗时变化
 * 5. 重复提问率趋势 — 用户反复询问同一问题的频率
 * 6. 错误频率趋势 — 工具调用失败/超时频率
 *
 * 安全措施：
 * - 最小分析间隔 24 小时
 * - 最少数据量要求（每个分类至少 5 个数据点）
 * - 参数变更需通过 LLM 合理性校验
 * - 输出包含置信度和预期影响
 *
 * 集成方式：
 * - 作为 SignalCollector 注册到 PipelineOrchestrator
 * - 生成的 Problem 由 ParameterSelfEvolutionExecutor 消费
 * - 可选注入 LlmService 以获得 LLM 驱动的提案生成
 * - 无 LLM 时自动降级为规则基准提案
 */

import { log } from '../../logger/Logger'
import type { Problem, SignalCollector } from '../automation/types'
import { feedbackMetadataStore } from './FeedbackMetadataStore'
import { parameterRegistry } from './ParameterRegistry'
import type {
  FeedbackMetricAnalysis,
  ParameterAdjustmentProposal,
  ParameterSelfEvolutionReport,
} from './types'
import type { LlmService } from '../../llm/LlmService'

// ═══════════════════════════════════════════════
//  配置常量
// ═══════════════════════════════════════════════

/** 最小分析间隔：24 小时 */
const MIN_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 每次采集最多生成的 Problem 数 */
const MAX_PROBLEMS_PER_CYCLE = 2

/** 每个分类需要的最少数据点数（低于此值视为数据不足） */
const MIN_DATA_POINTS_PER_CATEGORY = 5

/** 提案的最小置信度（低于此值不被采纳） */
const MIN_PROPOSAL_CONFIDENCE = 0.3

/**
 * 定义 metrics → expected parameter mappings 用于规则基准提案。
 * 当 LLM 不可用时，使用这些规则生成简单的参数调整建议。
 */
const RULE_BASED_MAPPINGS: Array<{
  metricCategories: string[]
  targetParam: string
  condition: 'degrading_high' | 'degrading_low'
  adjustment: number
  reason: string
}> = [
  {
    metricCategories: ['user_satisfaction'],
    targetParam: 'agent.temperature',
    condition: 'degrading_low',
    adjustment: -0.1, // 满意度下降 → 降低温度（更确定）
    reason: '用户满意度下降，降低 Agent 温度以增加回复确定性',
  },
  {
    metricCategories: ['repeat_question'],
    targetParam: 'agent.max_response_tokens',
    condition: 'degrading_high',
    adjustment: 256, // 重复提问上升 → 增加回复长度
    reason: '重复提问率上升，增加最大回复长度以提供更完整回答',
  },
  {
    metricCategories: ['interruption'],
    targetParam: 'agent.max_response_tokens',
    condition: 'degrading_high',
    adjustment: -256, // 中断率上升 → 缩短回复
    reason: '用户中断率上升，缩短回复长度以减少打断',
  },
  {
    metricCategories: ['latency'],
    targetParam: 'tool.cache_ttl_ms',
    condition: 'degrading_high',
    adjustment: -30_000, // 延迟上升 → 减小缓存 TTL
    reason: '响应延迟增加，减小工具缓存 TTL 以加速响应',
  },
  {
    metricCategories: ['interruption', 'latency'],
    targetParam: 'tts.speech_rate',
    condition: 'degrading_high',
    adjustment: 0.1, // 中断+延迟上升 → 提高 TTS 语速
    reason: '用户中断和延迟增加，提高 TTS 语速以缩短听觉时间',
  },
]

// ═══════════════════════════════════════════════
//  ParameterSelfEvolutionAnalyzer
// ═══════════════════════════════════════════════

export class ParameterSelfEvolutionAnalyzer implements SignalCollector {
  readonly name = 'parameter-self-evolution'
  readonly source = 'parameter' as const

  private lastRun = 0
  private minIntervalMs = MIN_INTERVAL_MS
  /** 已生成的 report 指纹（防重复） */
  private emittedReportIds = new Set<string>()
  /** 可选的 LLM 服务（注入后启用 LLM 提案生成） */
  private llmService: LlmService | null = null

  shouldRun(): boolean {
    if (Date.now() - this.lastRun < this.minIntervalMs) return false
    // 确保 FeedbackMetadataStore 有足够的数据
    const stats = feedbackMetadataStore.getStats()
    return stats.total >= MIN_DATA_POINTS_PER_CATEGORY
  }

  /** 注入 LLM 服务引用（可选，无 LLM 时使用规则基准提案） */
  setLlmService(llm: LlmService): void {
    this.llmService = llm
    log('INFO', 'param_self_evo_analyzer_llm_attached')
  }

  async collect(): Promise<Problem[]> {
    this.lastRun = Date.now()

    try {
      // ══════════════════════════════════════════
      // Stage 1: 执行指标分析
      // ══════════════════════════════════════════
      const analyses = feedbackMetadataStore.analyzeMetrics()

      const storeStats = feedbackMetadataStore.getStats()
      log('INFO', 'param_self_evo_analysis_stage1', {
        dataPoints: storeStats.total,
        byCategory: storeStats.byCategory,
        analysesCount: analyses.length,
        concerningCount: analyses.filter((a) => a.isConcerning).length,
      })

      // 过滤：至少有一些令人担忧的趋势才生成提案
      const concerningAnalyses = analyses.filter((a) => a.isConcerning)
      const nonConcerningAnalyses = analyses.filter((a) => !a.isConcerning && a.sampleCount >= MIN_DATA_POINTS_PER_CATEGORY)

      if (concerningAnalyses.length === 0 && nonConcerningAnalyses.length === 0) {
        log('INFO', 'param_self_evo_no_concerning_metrics', {
          totalAnalyses: analyses.length,
        })
        return []
      }

      // ══════════════════════════════════════════
      // Stage 2: 生成参数调整提案
      // ══════════════════════════════════════════
      let proposals: ParameterAdjustmentProposal[]

      if (this.llmService) {
        proposals = await this.generateProposalsWithLLM(analyses)
      } else {
        proposals = this.generateRuleBasedProposals(analyses)
      }

      // 过滤低置信度提案
      proposals = proposals.filter((p) => p.confidence >= MIN_PROPOSAL_CONFIDENCE)

      if (proposals.length === 0) {
        log('INFO', 'param_self_evo_no_valid_proposals', {
          totalAnalyses: analyses.length,
          concerningCount: concerningAnalyses.length,
        })
        return []
      }

      // ══════════════════════════════════════════
      // Stage 3: 构建分析报告和 Problem
      // ══════════════════════════════════════════
      const report = this.buildReport(analyses, proposals)

      // 去重
      if (this.emittedReportIds.has(report.id)) {
        log('INFO', 'param_self_evo_duplicate_report', { reportId: report.id })
        return []
      }
      this.emittedReportIds.add(report.id)

      // 清理旧报告 ID
      if (this.emittedReportIds.size > 50) {
        const entries = Array.from(this.emittedReportIds)
        this.emittedReportIds = new Set(entries.slice(-25))
      }

      const problems = this.reportToProblems(report)
      log('INFO', 'param_self_evo_analysis_complete', {
        dataPoints: storeStats.total,
        concerningMetrics: concerningAnalyses.length,
        proposals: proposals.length,
        problems: problems.length,
        usedLLM: this.llmService !== null,
      })

      return problems.slice(0, MAX_PROBLEMS_PER_CYCLE)
    } catch (err: any) {
      log('ERROR', 'param_self_evo_analysis_error', { error: err.message })
      return []
    }
  }

  // ═══════════════════════════════════════════════════
  //  LLM 驱动的提案生成
  // ═══════════════════════════════════════════════════

  /**
   * 使用 LLM 分析指标数据并生成参数调整提案。
   * 构建 prompt 将当前所有可调参数和指标趋势发送给 LLM，
   * 期望 LLM 以 JSON 格式返回调整建议列表。
   */
  private async generateProposalsWithLLM(analyses: FeedbackMetricAnalysis[]): Promise<ParameterAdjustmentProposal[]> {
    if (!this.llmService) return []

    const params = parameterRegistry.getAll()
    const concerningMetrics = analyses.filter((a) => a.isConcerning)

    // 构建 LLM prompt
    const systemPrompt = `你是一个智能系统参数调优专家。你的任务是基于用户交互反馈的指标趋势，分析是否需要调整系统参数，并输出结构化的调优建议。

规则：
1. 只对趋势恶化（degrading）或指标值异常的指标响应
2. 每个参数调整必须在安全范围内（参考每个参数定义的 min/max 范围）
3. 单次调整幅度不能超过 maxDeltaPerAdjustment
4. 如果指标趋势正常，不需要调整
5. 输出必须是一个 JSON 数组，每个元素包含：parameterKey, proposedValue, reason, confidence, expectedImpact, relatedMetrics
6. 如果不需要任何调整，输出空数组 []`

    const userPrompt = this.buildLLMUserPrompt(analyses, params)

    try {
      const result = await this.llmService.chatJson(userPrompt, {
        system: systemPrompt,
        temperature: 0.3,
        timeoutMs: 30_000,
        requestId: `param-self-evo-${Date.now()}`,
      })

      if (result.error || !result.data) {
        log('WARN', 'param_self_evo_llm_failed', { error: result.error || 'empty_response' })
        return this.generateRuleBasedProposals(analyses)
      }

      // LLM 可能返回对象或数组
      const rawProposals = Array.isArray(result.data) ? result.data : (result.data.proposals || [])

      if (!Array.isArray(rawProposals) || rawProposals.length === 0) {
        return []
      }

      // 验证和转换 LLM 输出
      const proposals: ParameterAdjustmentProposal[] = []
      for (const raw of rawProposals) {
        const param = parameterRegistry.get(raw.parameterKey)
        if (!param) {
          log('WARN', 'param_self_evo_llm_unknown_param', { key: raw.parameterKey })
          continue
        }

        const proposedValue = Number(raw.proposedValue)
        if (isNaN(proposedValue)) continue

        // 验证 Delta
        const delta = Math.abs(proposedValue - param.currentValue)
        if (delta > param.maxDeltaPerAdjustment) {
          log('WARN', 'param_self_evo_llm_delta_too_large', {
            key: raw.parameterKey,
            delta,
            maxDelta: param.maxDeltaPerAdjustment,
          })
          continue
        }

        proposals.push({
          parameterKey: raw.parameterKey,
          proposedValue,
          currentValue: param.currentValue,
          reason: raw.reason || `LLM 建议调整 ${param.name}`,
          confidence: Math.min(1, Math.max(0, Number(raw.confidence) || 0.5)),
          expectedImpact: raw.expectedImpact || '',
          withinSafeBounds: proposedValue >= param.min && proposedValue <= param.max,
          category: param.category,
          relatedMetrics: Array.isArray(raw.relatedMetrics) ? raw.relatedMetrics : [],
        })
      }

      if (proposals.length === 0) {
        log('INFO', 'param_self_evo_llm_no_valid_proposals')
        return this.generateRuleBasedProposals(analyses)
      }

      return proposals
    } catch (err: any) {
      log('WARN', 'param_self_evo_llm_error', { error: err.message })
      return this.generateRuleBasedProposals(analyses)
    }
  }

  /** 构建 LLM user prompt */
  private buildLLMUserPrompt(
    analyses: FeedbackMetricAnalysis[],
    params: Array<{ key: string; name: string; currentValue: number; min: number; max: number; maxDeltaPerAdjustment: number; description: string }>,
  ): string {
    const sections: string[] = ['## 当前指标趋势']

    for (const a of analyses) {
      sections.push(
        `- ${a.metric}: 当前值=${a.currentValue.toFixed(4)}, 前值=${a.previousValue.toFixed(4)}, 趋势=${a.trend}, 样本数=${a.sampleCount}${a.isConcerning ? ' ⚠️ 需关注' : ''}`,
      )
    }

    sections.push('', '## 可调参数列表')
    for (const p of params) {
      sections.push(
        `- ${p.key} (${p.name}): 当前值=${p.currentValue}, 范围=[${p.min}, ${p.max}], 单次最大调整=${p.maxDeltaPerAdjustment}, 描述: ${p.description}`,
      )
    }

    sections.push('', '## 调整要求')
    sections.push('请分析以上指标趋势，针对需要优化的指标输出参数调整建议（JSON 数组）。')
    sections.push('如果所有指标正常，输出空数组 []。')

    return sections.join('\n')
  }

  // ═══════════════════════════════════════════════════
  //  规则基准提案生成
  // ═══════════════════════════════════════════════════

  /**
   * 当 LLM 不可用时，使用规则基准生成提案。
   * 根据预定义的 metrics→parameter mappings 生成简单的调整建议。
   */
  private generateRuleBasedProposals(analyses: FeedbackMetricAnalysis[]): ParameterAdjustmentProposal[] {
    const proposals: ParameterAdjustmentProposal[] = []
    const concerningMap = new Map<string, FeedbackMetricAnalysis>()

    for (const a of analyses) {
      concerningMap.set(a.category, a)
    }

    for (const mapping of RULE_BASED_MAPPINGS) {
      // 检查所有需要的指标分类是否都处于指定状态
      let allMatch = true
      const matchedMetrics: string[] = []

      for (const cat of mapping.metricCategories) {
        const analysis = concerningMap.get(cat)
        if (!analysis) {
          allMatch = false
          break
        }

        // 检查条件
        if (mapping.condition === 'degrading_high' && analysis.trend === 'degrading') {
          matchedMetrics.push(analysis.metric)
        } else if (mapping.condition === 'degrading_low' && analysis.trend === 'degrading') {
          matchedMetrics.push(analysis.metric)
        } else if (mapping.condition === 'degrading_high' && analysis.isConcerning) {
          matchedMetrics.push(analysis.metric)
        } else if (mapping.condition === 'degrading_low' && analysis.isConcerning) {
          matchedMetrics.push(analysis.metric)
        } else {
          allMatch = false
          break
        }
      }

      if (!allMatch) continue

      // 获取当前参数
      const param = parameterRegistry.get(mapping.targetParam)
      if (!param) continue

      const proposedValue = Math.max(param.min, Math.min(param.max, param.currentValue + mapping.adjustment))

      // 如果调整幅度为 0（已到边界），跳过
      if (proposedValue === param.currentValue) continue

      proposals.push({
        parameterKey: mapping.targetParam,
        proposedValue,
        currentValue: param.currentValue,
        reason: mapping.reason,
        confidence: 0.4, // 规则基准置信度固定为 0.4
        expectedImpact: `预期改善指标: ${matchedMetrics.join(', ')}`,
        withinSafeBounds: proposedValue >= param.min && proposedValue <= param.max,
        category: param.category,
        relatedMetrics: matchedMetrics,
      })
    }

    return proposals
  }

  // ═══════════════════════════════════════════════════
  //  报告构建
  // ═══════════════════════════════════════════════════

  private buildReport(
    analyses: FeedbackMetricAnalysis[],
    proposals: ParameterAdjustmentProposal[],
  ): ParameterSelfEvolutionReport {
    const now = Date.now()
    const windowEnd = now
    const windowStart = now - 48 * 3_600_000 // 48 小时窗口

    const metricsSummary = analyses
      .map((a) => `${a.metric}: ${(a.currentValue * 100).toFixed(1)}% (${a.trend})${a.isConcerning ? ' ⚠️' : ''}`)
      .join('\n')

    const proposalLines = proposals
      .map((p) => `- ${p.parameterKey}: ${p.currentValue} → ${p.proposedValue} (置信度: ${(p.confidence * 100).toFixed(0)}%)`)
      .join('\n')

    const summary = [
      `## 参数自进化分析报告`,
      ``,
      `### 分析时间`,
      new Date(now).toLocaleString('zh-CN'),
      ``,
      `### 指标摘要`,
      metricsSummary,
      ``,
      `### 调整提案`,
      proposalLines || '（无调整建议）',
      ``,
      `### 总览`,
      `共分析 ${analyses.length} 个指标，${proposals.length} 个调整提案`,
    ].join('\n')

    return {
      id: `param_evo_${now}`,
      createdAt: now,
      feedbackWindowStart: windowStart,
      feedbackWindowEnd: windowEnd,
      metricAnalyses: analyses,
      metricsSummary,
      proposals,
      summary,
      hasActionableFindings: proposals.length > 0,
    }
  }

  // ═══════════════════════════════════════════════════
  //  Report → Problem 转换
  // ═══════════════════════════════════════════════════

  private reportToProblems(report: ParameterSelfEvolutionReport): Problem[] {
    if (!report.hasActionableFindings) return []

    const proposalsJson = JSON.stringify(
      report.proposals.map((p) => ({
        parameterKey: p.parameterKey,
        proposedValue: p.proposedValue,
        currentValue: p.currentValue,
        reason: p.reason,
        confidence: p.confidence,
        expectedImpact: p.expectedImpact,
        category: p.category,
      })),
    )

    const concerningCount = report.metricAnalyses.filter((a) => a.isConcerning).length

    const metricsDetail = report.metricAnalyses
      .filter((a) => a.isConcerning)
      .map(
        (a) =>
          `- ${a.metric}: ${(a.currentValue * 100).toFixed(1)}% → ${(a.previousValue * 100).toFixed(1)}% (${a.trend}${a.suggestion ? ': ' + a.suggestion : ''})`,
      )
      .join('\n')

    const status = concerningCount >= 2 ? 'error' : 'warning'

    return [
      {
        id: report.id,
        source: 'parameter',
        severity: status,
        title: `参数自进化: ${report.proposals.length} 个调整提案 (${concerningCount} 个需关注指标)`,
        description: [
          `## 记忆驱动的参数自进化分析`,
          ``,
          `### 需关注的指标`,
          metricsDetail || '（无严重异常）',
          ``,
          `### 调整提案`,
          report.proposals
            .map(
              (p) =>
                `- ${p.parameterKey}: ${p.currentValue} → ${p.proposedValue}` +
                `\n  理由: ${p.reason}` +
                `\n  置信度: ${(p.confidence * 100).toFixed(0)}%` +
                `\n  预期影响: ${p.expectedImpact}`,
            )
            .join('\n\n'),
          ``,
          report.summary,
        ].join('\n'),
        estimatedCostChars: 500,
        lastSeen: report.createdAt,
        occurrenceCount: 1,
        context: {
          raw: report.summary,
          snippet: `feedback metrics: ${report.metricAnalyses.length}, proposals: ${report.proposals.length}`,
          metadata: {
            reportId: report.id,
            analysesCount: String(report.metricAnalyses.length),
            proposalsCount: String(report.proposals.length),
            concerningCount: String(concerningCount),
            proposalsJson,
            metricsSummary: report.metricsSummary,
            usedLLM: String(this.llmService !== null),
          },
        },
      },
    ]
  }
}

/** 全局单例 */
export const parameterSelfEvolutionAnalyzer = new ParameterSelfEvolutionAnalyzer()
