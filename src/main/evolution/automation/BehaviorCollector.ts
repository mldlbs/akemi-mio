/**
 * BehaviorCollector — 行为特征采集器
 *
 * 读取 BehaviorFeatureExtractor 的实时行为分析结果，将高频序列、
 * 停顿点和优化建议转换为管道可消费的 Problem（source='behavior'），
 * 由 BehaviorOptimizationExecutor 落地优化代码。
 *
 * ── 采集来源 ──
 * - BehaviorFeatureExtractor（读取 userBehaviorAnalyzer 的运行时数据）
 * - 每周期分析最近 48 条工具调用记录
 *
 * ── 输出 ──
 * - 每个 OptimizationSuggestion 对应一个 Problem
 * - 只有 hasSufficientData=true 且 suggestion.priority >= 40 时才生成
 */

import { log } from '../../logger/Logger'
import type { SignalCollector, Problem } from './types'
import { behaviorFeatureExtractor } from '../../user-behavior/BehaviorFeatureExtractor'

export class BehaviorCollector implements SignalCollector {
  readonly name = 'behavior-collector'
  readonly source = 'behavior' as const

  /** 上次运行时间（防止同一周期重复采集） */
  private lastRun = 0
  /** 最小运行间隔 */
  private minIntervalMs = 60 * 60 * 1000
  /** 上次采集到的 feature ID 集合（用于去重/回填 occurrenceCount） */
  private seenSuggestionIds = new Set<string>()

  shouldRun(): boolean {
    if (Date.now() - this.lastRun < this.minIntervalMs) return false
    return true
  }

  async collect(): Promise<Problem[]> {
    this.lastRun = Date.now()

    try {
      const features = behaviorFeatureExtractor.extract(48)

      if (!features.hasSufficientData) {
        log('INFO', 'behavior_collector_insufficient_data', {
          totalCalls: features.totalToolCalls,
        })
        return []
      }

      log('INFO', 'behavior_collector_features', {
        sequences: features.frequentSequences.length,
        pausePoints: features.pausePoints.length,
        frequentTools: features.frequentTools.length,
        suggestions: features.suggestions.length,
      })

      const problems: Problem[] = []

      for (const suggestion of features.suggestions) {
        // 过滤低优先级建议
        if (suggestion.priority < 40) continue

        const suggestionId = `behavior:${suggestion.type}:${suggestion.target.replace(/[^a-zA-Z0-9_-]/g, '_')}`

        // 为已见过的建议增加 occurrenceCount
        const isSeen = this.seenSuggestionIds.has(suggestionId)
        if (!isSeen) {
          this.seenSuggestionIds.add(suggestionId)
        }

        problems.push({
          id: suggestionId,
          source: 'behavior',
          // 高优先级→error, 中优先级→warning, 低→info
          severity: suggestion.priority >= 80 ? 'error' : suggestion.priority >= 50 ? 'warning' : 'info',
          title: suggestion.title,
          description: suggestion.description,
          estimatedCostChars: suggestion.estimatedCost,
          lastSeen: Date.now(),
          occurrenceCount: isSeen ? 2 : 1,
          context: {
            raw: `[${suggestion.type}] ${suggestion.title}\n${suggestion.description}\n\n预期收益: ${suggestion.expectedBenefit}\n风险: ${suggestion.risk}`,
            metadata: {
              optimizationType: suggestion.type,
              priority: String(suggestion.priority),
              expectedBenefit: suggestion.expectedBenefit,
              risk: suggestion.risk,
              target: suggestion.target,
              totalToolCalls: String(features.totalToolCalls),
              frequentSequences: JSON.stringify(
                features.frequentSequences.slice(0, 5).map((s) => ({
                  tools: s.tools,
                  frequency: s.frequency,
                })),
              ),
              pausePoints: JSON.stringify(features.pausePoints.slice(0, 3)),
            },
          },
        })
      }

      log('INFO', 'behavior_collector_done', {
        totalSuggestions: features.suggestions.length,
        problemsCreated: problems.length,
      })

      return problems
    } catch (err: any) {
      log('ERROR', 'behavior_collector_error', { error: err.message })
      return []
    }
  }
}
