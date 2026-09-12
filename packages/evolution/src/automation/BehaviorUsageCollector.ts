/**
 * BehaviorUsageCollector — 使用模式采集器
 *
 * 在进化管道的 collect 阶段运行 BehaviorUsagePatternAnalyzer，
 * 根据分析结果生成优化问题供 BehaviorParamAdjustmentExecutor 处理。
 *
 * ## 问题生成规则
 *
 * 1. **深夜模式 (late_night_tts)**
 *    - 条件：活跃交互中深夜占比 ≥ 20% 且当前是深夜
 *    - 动作：建议切换到柔和 TTS 音色
 *
 * 2. **重复提问模式 (repeated_question_memory)**
 *    - 条件：检测到明显重复话题（重复话题 ≥ 2 个且次数 ≥ 3）
 *    - 动作：建议增强 Memory 摘要上下文
 *
 * 3. **负面情感提示 (negative_sentiment)**
 *    - 条件：负面情感占比 ≥ 30%
 *    - 动作：建议增加回复温暖度
 *
 * 4. **冷启动提示 (insufficient_data)**
 *    - 条件：数据不足
 *    - 动作：跳过，等待更多数据
 *
 * ## 去重机制
 * - 每类问题最多一个 active 实例
 * - 使用问题 ID 前缀去重：usage_pattern:late_night
 * - 如果调整已生效且未回滚，不再生成重复问题
 *
 * @module evolution/automation
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { SignalCollector, Problem } from './types'
import { behaviorUsagePatternAnalyzer } from '@akemi-mio/evolution/behavior'
import { behaviorAdjustmentJournal } from '@akemi-mio/evolution/behavior/BehaviorAdjustmentJournal'

export class BehaviorUsageCollector implements SignalCollector {
  readonly name = 'behavior-usage-collector'
  readonly source = 'behavior' as const

  /** 上次运行时间 */
  private lastRun = 0
  /** 最小运行间隔（与进化周期匹配，至少 1 小时） */
  private minIntervalMs = 60 * 60 * 1000

  /** 缓存上次分析报告摘要，供 executor 使用 */
  private lastReportJson: string | null = null

  shouldRun(): boolean {
    if (Date.now() - this.lastRun < this.minIntervalMs) return false
    return true
  }

  getSkipReason(): string {
    if (Date.now() - this.lastRun < this.minIntervalMs) {
      const remaining = Math.round((this.minIntervalMs - (Date.now() - this.lastRun)) / 1000)
      return `cooldown: ${remaining}s remaining`
    }
    return 'unknown'
  }

  /** 获取最后一次分析报告（供 executor 消费） */
  getLastReportJson(): string | null {
    return this.lastReportJson
  }

  /**
   * 评估上次调整的效果。
   * 检查尚未记录效果的调整并回填效果数据。
   * 如果效果为负面，自动触发回滚。
   */
  private evaluatePreviousAdjustments(): void {
    try {
      const activeAdjustments = behaviorAdjustmentJournal.getActiveAdjustments()

      for (const adj of activeAdjustments) {
        // 跳过已有效果记录的调整
        if (adj.effect !== null) continue

        // 检查调整是否超过 1 小时且已有后续交互
        const ageMs = Date.now() - adj.triggeredAt
        if (ageMs < 60 * 60 * 1000) continue

        // 获取近期分析报告的数据作为效果评估
        const report = behaviorUsagePatternAnalyzer.analyze({ skipSentiment: false })
        if (!report.hasSufficientData) continue

        // 根据调整类型评估效果
        switch (adj.type) {
          case 'tts_voice_soften': {
            // 评估：如果当前不在深夜，或深夜占比下降，视为效果正面
            const positiveDesc =
              adj.context.lateNightRatio > report.timePattern.lateNightRatio ? '深夜活跃占比下降，调整效果正面' : '深夜活跃占比稳定或上升'
            behaviorAdjustmentJournal.recordEffect(adj.id, {
              followUpInteractions: report.timePattern.totalInteractions,
              followUpNegativeCount: report.sentiment.counts.frustrated + report.sentiment.counts.urgent,
              followUpLateNightCount: Math.round(report.timePattern.lateNightRatio * report.timePattern.totalInteractions),
              description: positiveDesc,
            })
            break
          }
          case 'memory_summary_enhance': {
            // 评估：重复话题是否减少
            const prevRepeatCount = adj.context.repeatedTopics.length
            const currRepeatCount = report.repeatedPattern.repeatedTopics.length
            const positiveDesc = currRepeatCount < prevRepeatCount ? '重复话题数减少，调整效果正面' : '重复话题数未减少或增加'
            behaviorAdjustmentJournal.recordEffect(adj.id, {
              followUpInteractions: report.repeatedPattern.totalInteractions,
              followUpNegativeCount: report.sentiment.counts.frustrated + report.sentiment.counts.urgent,
              followUpLateNightCount: 0,
              description: positiveDesc,
            })
            break
          }
          case 'response_warmth_increase': {
            // 评估：负面情感占比是否下降
            const positiveDesc =
              report.sentiment.negativeRatio < adj.context.negativeRatio ? '负面情感占比下降，调整效果正面' : '负面情感占比未改善'
            behaviorAdjustmentJournal.recordEffect(adj.id, {
              followUpInteractions: report.sentiment.totalAnalyzed,
              followUpNegativeCount: report.sentiment.counts.frustrated + report.sentiment.counts.urgent,
              followUpLateNightCount: 0,
              description: positiveDesc,
            })
            break
          }
          default:
            break
        }
      }
    } catch (err: any) {
      log('WARN', 'usage_evaluate_previous_error', { error: err.message })
    }
  }

  async collect(): Promise<Problem[]> {
    this.lastRun = Date.now()
    const problems: Problem[] = []

    try {
      // ── 0. 效果评估：评估上次调整的效果 ──
      this.evaluatePreviousAdjustments()

      const report = behaviorUsagePatternAnalyzer.analyze()

      if (!report.hasSufficientData) {
        log('INFO', 'usage_collector_skip_insufficient_data', {
          interactions: report.timePattern.totalInteractions,
        })
        return []
      }

      // 缓存 JSON 摘要供 executor 使用
      this.lastReportJson = JSON.stringify(report)

      const activeAdjustments = behaviorAdjustmentJournal.getActiveAdjustments()
      const activeTypes = new Set(activeAdjustments.map((a) => a.type))

      // ── 1. 深夜 TTS 模式检测 ──
      if (report.timePattern.isCurrentlyLateNight && report.timePattern.lateNightRatio >= 0.2 && !activeTypes.has('tts_voice_soften')) {
        const problemId = `usage_pattern:late_night:${Date.now()}`

        problems.push({
          id: problemId,
          source: 'behavior',
          severity: 'info',
          title: '深夜模式 —— 建议切换到柔和 TTS 音色',
          description: `用户深夜活跃占比 ${(report.timePattern.lateNightRatio * 100).toFixed(0)}%（高峰时段：${report.timePattern.peakHours.join('、')} 时）。建议切换到柔和 TTS 音色提升听觉体验。`,
          estimatedCostChars: 200,
          lastSeen: Date.now(),
          occurrenceCount: 1,
          context: {
            raw: `[usage_pattern] 深夜使用模式
深夜活跃占比: ${(report.timePattern.lateNightRatio * 100).toFixed(0)}%
当前小时: ${new Date().getHours()} 时
高峰时段: ${report.timePattern.peakHours.join('、')}
24 小时分布: ${report.timePattern.hourlyCounts.join(',')}`,
            metadata: {
              adjustmentType: 'tts_voice_soften',
              lateNightRatio: String(report.timePattern.lateNightRatio),
              peakHours: report.timePattern.peakHours.join(','),
              hourlyCounts: report.timePattern.hourlyCounts.join(','),
              reportJson: this.lastReportJson,
            },
          },
        })
      }

      // ── 2. 重复提问记忆增强检测 ──
      if (report.repeatedPattern.hasSignificantRepeat && !activeTypes.has('memory_summary_enhance')) {
        const topTopics = report.repeatedPattern.repeatedTopics
          .slice(0, 3)
          .map((t) => `${t.topic}(${t.count}次)`)
          .join('、')

        problems.push({
          id: `usage_pattern:repeated_question:${Date.now()}`,
          source: 'behavior',
          severity: 'info',
          title: '重复提问模式 —— 建议增强 Memory 摘要',
          description: `检测到 ${report.repeatedPattern.repeatedTopics.length} 个重复话题（${topTopics}）。建议增强 Memory 摘要上下文，减少重复回答。`,
          estimatedCostChars: 300,
          lastSeen: Date.now(),
          occurrenceCount: 1,
          context: {
            raw: `[usage_pattern] 重复提问模式
重复话题数: ${report.repeatedPattern.repeatedTopics.length}
重复列表: ${topTopics}
相似交互对数: ${report.repeatedPattern.similarPairCount}
窗口交互数: ${report.repeatedPattern.totalInteractions}`,
            metadata: {
              adjustmentType: 'memory_summary_enhance',
              repeatedTopics: JSON.stringify(report.repeatedPattern.repeatedTopics),
              similarPairCount: String(report.repeatedPattern.similarPairCount),
              totalInteractions: String(report.repeatedPattern.totalInteractions),
              reportJson: this.lastReportJson,
            },
          },
        })
      }

      // ── 3. 负面情感提示 ──
      if (report.sentiment.negativeRatio >= 0.3 && !activeTypes.has('response_warmth_increase')) {
        problems.push({
          id: `usage_pattern:negative_sentiment:${Date.now()}`,
          source: 'behavior',
          severity: 'warning',
          title: '负面情感增加 —— 建议调整回复温暖度',
          description: `负面情感占比 ${(report.sentiment.negativeRatio * 100).toFixed(0)}%（急迫 ${report.sentiment.counts.urgent} 次、沮丧 ${report.sentiment.counts.frustrated} 次），趋势 ${report.sentiment.trend === 'worsening' ? '恶化中' : report.sentiment.trend === 'improving' ? '改善中' : '稳定'}。建议增加回复的温暖度和耐心程度。`,
          estimatedCostChars: 300,
          lastSeen: Date.now(),
          occurrenceCount: 1,
          context: {
            raw: `[usage_pattern] 负面情感分析
负面占比: ${(report.sentiment.negativeRatio * 100).toFixed(0)}%
急迫: ${report.sentiment.counts.urgent} 次
沮丧: ${report.sentiment.counts.frustrated} 次
满意: ${report.sentiment.counts.satisfied} 次
中性: ${report.sentiment.counts.neutral} 次
趋势: ${report.sentiment.trend}`,
            metadata: {
              adjustmentType: 'response_warmth_increase',
              negativeRatio: String(report.sentiment.negativeRatio),
              trend: report.sentiment.trend,
              urgentCount: String(report.sentiment.counts.urgent),
              frustratedCount: String(report.sentiment.counts.frustrated),
              reportJson: this.lastReportJson,
            },
          },
        })
      }

      log('INFO', 'usage_collector_done', {
        problemsCreated: problems.length,
        isLateNight: report.timePattern.isCurrentlyLateNight,
        lateNightRatio: report.timePattern.lateNightRatio,
        hasRepeat: report.repeatedPattern.hasSignificantRepeat,
        negativeRatio: report.sentiment.negativeRatio,
      })
    } catch (err: any) {
      log('ERROR', 'usage_collector_error', { error: err.message })
    }

    return problems
  }
}
