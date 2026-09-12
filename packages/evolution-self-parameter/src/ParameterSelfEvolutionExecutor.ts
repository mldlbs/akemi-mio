/**
 * ParameterSelfEvolutionExecutor — 参数自进化执行器
 *
 * 消费 ParameterSelfEvolutionAnalyzer 生成的 Problem（source='parameter'），
 * 根据建议参数调整提案：
 *   1. 从 Problem context 解析 proposal 列表
 *   2. 通过 ParameterHotReloader 应用变更（自动创建快照）
 *   3. 记录变更摘要到日志
 *   4. 支持退化检测和回滚建议
 *
 * ── 安全性 ──
 * - 参数变更在 ParameterHotReloader 中进行边界校验
 * - 每次变更前自动创建快照，支持回滚
 * - 参数值自动 clamp 到安全范围
 * - 检测到指标恶化时建议回滚
 *
 * ── 集成 ──
 * - 作为 FixExecutor 注册到 PipelineOrchestrator
 * - 消费 source='parameter' 的 Problem
 * - 配合 FeedbackMetadataStore 记录变更后效果
 * - 通过 EventBus 广播变更事件
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { FixExecutor, FixResult, AssignedProblem } from '@akemi-mio/evolution/automation/types'
import { parameterHotReloader } from './ParameterHotReloader'
import { feedbackMetadataStore } from './FeedbackMetadataStore'
import type { ParameterAdjustmentProposal } from './types'

// ═══════════════════════════════════════════════
//  最近执行结果（供退化检测和回滚参考）
// ═══════════════════════════════════════════════

interface ExecResult {
  problemId: string
  timestamp: number
  appliedChanges: number
  proposals: ParameterAdjustmentProposal[]
}

let lastExecResult: ExecResult | null = null

// ═══════════════════════════════════════════════
//  ParameterSelfEvolutionExecutor
// ═══════════════════════════════════════════════

export class ParameterSelfEvolutionExecutor implements FixExecutor {
  readonly name = 'parameter-self-evolution-executor'
  readonly timeoutMs = 15_000
  readonly supportedSources = ['parameter'] as const

  isAvailable(): boolean {
    return true
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    const startTime = Date.now()

    try {
      // ── 从 Problem context 解析提案数据 ──
      const proposalsJson = problem.context.metadata?.proposalsJson
      if (!proposalsJson) {
        // 没有具体提案 → 只报告分析结果，不执行变更
        const suggestsRollback = this.checkRollbackSuggestion()

        return {
          problemId: problem.id,
          success: true,
          summary: `📊 ${problem.title}` + (suggestsRollback ? '\n' + suggestsRollback : ''),
          durationMs: Date.now() - startTime,
          output: problem.context.snippet,
        }
      }

      let proposals: ParameterAdjustmentProposal[]
      try {
        proposals = JSON.parse(proposalsJson)
      } catch {
        return {
          problemId: problem.id,
          success: false,
          summary: '解析提案 JSON 失败',
          durationMs: Date.now() - startTime,
          error: 'invalid_proposals_json',
        }
      }

      if (!Array.isArray(proposals) || proposals.length === 0) {
        log('INFO', 'param_self_evo_exec_no_proposals', {
          problemId: problem.id,
          title: problem.title,
        })
        return {
          problemId: problem.id,
          success: true,
          summary: '📊 分析完成，无参数调整提案',
          durationMs: Date.now() - startTime,
          output: problem.context.snippet,
        }
      }

      // ── 应用提案 ──
      log('INFO', 'param_self_evo_exec_start', {
        problemId: problem.id,
        proposals: proposals.length,
      })

      const appliedChanges = parameterHotReloader.applyProposals(proposals)

      // ── 记录执行结果 ──
      lastExecResult = {
        problemId: problem.id,
        timestamp: Date.now(),
        appliedChanges: appliedChanges.length,
        proposals,
      }

      if (appliedChanges.length === 0) {
        // 所有提案经过安全校验都被过滤了
        log('INFO', 'param_self_evo_exec_no_valid_changes', {
          problemId: problem.id,
          totalProposals: proposals.length,
        })
        return {
          problemId: problem.id,
          success: true,
          summary: 'ℹ️ 参数调整提案均未通过安全校验，未变更任何参数',
          durationMs: Date.now() - startTime,
          output: `已过滤 ${proposals.length} 个提案`,
        }
      }

      // ── 构建变更摘要 ──
      const changesDetail = appliedChanges
        .map((c) => `  - ${c.key}: ${c.oldValue} → ${c.newValue} (置信度: ${(c.confidence * 100).toFixed(0)}%)`)
        .join('\n')

      const summary = `✅ 参数自进化已应用 ${appliedChanges.length} 个调整\n${changesDetail}`

      log('INFO', 'param_self_evo_exec_applied', {
        problemId: problem.id,
        changes: appliedChanges.length,
        details: appliedChanges.map((c) => `${c.key}: ${c.oldValue} → ${c.newValue}`).join(', '),
      })

      // ── 反馈数据中记录此事件 ──
      feedbackMetadataStore.record({
        metric: 'parameter_adjustment_count',
        value: appliedChanges.length,
        category: 'user_satisfaction',
        context: `Auto-adjusted ${appliedChanges.length} parameters: ${appliedChanges.map((c) => c.key).join(', ')}`,
      })

      return {
        problemId: problem.id,
        success: true,
        summary,
        durationMs: Date.now() - startTime,
        output: `已更新 ${appliedChanges.length} 个参数`,
      }
    } catch (err: any) {
      log('ERROR', 'param_self_evo_exec_error', { problemId: problem.id, error: err.message })

      return {
        problemId: problem.id,
        success: false,
        summary: `参数自进化执行失败: ${err.message}`,
        durationMs: Date.now() - startTime,
        error: err.message,
      }
    }
  }

  /**
   * 检查最近一次变更后的指标恶化情况。
   * 返回回滚建议文本（空字符串表示无需回滚）。
   */
  private checkRollbackSuggestion(): string {
    try {
      return parameterHotReloader.checkDegradation()
    } catch {
      return ''
    }
  }

  /**
   * 手动触发回滚最近一次参数变更。
   * @returns 回滚摘要文本
   */
  static rollback(): string {
    const result = parameterHotReloader.rollback()
    if (!result) return '没有可回滚的参数快照。'
    lastExecResult = null
    return result
  }

  /** 获取最近一次执行结果 */
  static getLastExecResult(): ExecResult | null {
    return lastExecResult ? { ...lastExecResult } : null
  }

  /** 获取回滚建议（由上游系统周期性调用） */
  static getRollbackSuggestion(): string {
    try {
      return parameterHotReloader.checkDegradation()
    } catch {
      return ''
    }
  }
}
