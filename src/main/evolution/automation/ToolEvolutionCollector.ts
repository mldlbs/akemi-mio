/**
 * ToolEvolutionCollector — 工具进化问题采集器
 *
 * 职责：
 * 1. 读取 ToolStatsTracker 的问题工具列表
 * 2. 使用 FailurePatternAnalyzer 分析具体失败模式
 * 3. 将识别到的模式转化为管道可消费的 Problem，附带具体参数上下文
 *
 * 触发条件：
 * - 某工具错误率超过阈值（默认 25%）
 * - 调用次数超过最小样本数（默认 5 次）
 * - 该工具不在冷却列表中（24h 内未优化过）
 *
 * v2 增强：
 * - 使用 FailurePatternAnalyzer 发现具体参数模式
 * - Problem 上下文中包含具体失败参数值和建议修复模板
 * - 为 ToolEvolutionExecutor 提供更精确的修复指导
 */

import { log } from '../../logger/Logger'
import type { SignalCollector, Problem } from './types'
import { toolStatsTracker } from '../../tool/ToolStatsTracker'
import { failurePatternAnalyzer } from '../../tool/FailurePatternAnalyzer'

export class ToolEvolutionCollector implements SignalCollector {
  readonly name = 'tool-evolution-collector'
  readonly source = 'tool' as const

  private lastRun = 0
  /** 最小运行间隔：一小时一次，避免每周期重复 */
  private minIntervalMs = 60 * 60 * 1000
  /** 上次报告过的工具 ID 集合（用于累计 occurrenceCount） */
  private reportedToolIds = new Set<string>()

  shouldRun(): boolean {
    if (Date.now() - this.lastRun < this.minIntervalMs) return false
    return true
  }

  async collect(): Promise<Problem[]> {
    this.lastRun = Date.now()
    const problems: Problem[] = []

    try {
      // ── 阶段 1：从 ToolStatsTracker 获取问题工具列表 ──
      const problematicTools = toolStatsTracker.getProblematicTools()

      if (problematicTools.length === 0) {
        log('INFO', 'tool_evolution_collector_no_problems')
        return []
      }

      log('INFO', 'tool_evolution_collector_found', {
        count: problematicTools.length,
        tools: problematicTools.map((t) => `${t.toolName}(${(t.errorRate * 100).toFixed(0)}%)`).join(', '),
      })

      for (const pt of problematicTools) {
        const problemId = `tool:${pt.toolName}:error_rate`

        const isSeen = this.reportedToolIds.has(problemId)
        if (!isSeen) {
          this.reportedToolIds.add(problemId)
        }

        // ── 阶段 2：使用 FailurePatternAnalyzer 进行深度模式分析 ──
        const patterns = failurePatternAnalyzer.analyzeTool(pt.toolName)

        // 构建增强的上下文描述
        let patternDetail = ''
        let suggestedFix = pt.suggestion
        let affectedParams = ''

        if (patterns.length > 0) {
          const topPattern = patterns[0]
          patternDetail = `\n失败模式: ${topPattern.description}`
          if (topPattern.argPatterns.length > 0) {
            const argDesc = topPattern.argPatterns
              .map((ap) => `${ap.param}=${ap.valuePattern} (失败率 ${(ap.failureRate * 100).toFixed(0)}%, 样本 ${ap.sampleCount} 次)`)
              .join('; ')
            patternDetail += `\n参数模式: ${argDesc}`
            affectedParams = topPattern.affectedParams.join(',')
          }
          if (topPattern.sampleErrors.length > 0) {
            patternDetail += `\n样本错误: ${topPattern.sampleErrors.slice(0, 2).join(' | ')}`
          }
          suggestedFix = topPattern.suggestedFix
        }

        problems.push({
          id: problemId,
          source: 'tool',
          severity: pt.errorRate >= 0.5 ? 'error' : 'warning',
          title: `工具 "${pt.toolName}" 错误率过高`,
          description: pt.reason,
          estimatedCostChars: pt.totalCalls * 10,
          lastSeen: Date.now(),
          occurrenceCount: isSeen ? 2 : 1,
          context: {
            raw: `工具错误率分析:\n工具名: ${pt.toolName}\n错误率: ${(pt.errorRate * 100).toFixed(1)}%\n总调用: ${pt.totalCalls}\n建议优化类型: ${suggestedFix}${patternDetail}`,
            metadata: {
              toolName: pt.toolName,
              errorRate: String(pt.errorRate),
              totalCalls: String(pt.totalCalls),
              suggestion: suggestedFix,
              affectedParams,
              patternCount: String(patterns.length),
            },
          },
        })
      }
    } catch (err: any) {
      log('ERROR', 'tool_evolution_collector_error', { error: err.message })
    }

    return problems
  }
}
