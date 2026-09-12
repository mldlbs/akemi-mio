/**
 * TtsTypographyCollector — TTS ↔ 排版强化回路 采集器
 *
 * 采集 TtsTypographyFeedbackLoop 的运行时数据，
 * 将排版质量指标和调整建议转化为优化问题，
 * 由 TtsTypographyExecutor 执行排版参数调整。
 *
 * ── 采集来源 ──
 * - TtsTypographyFeedbackLoop 的 EMA 质量报告
 * - 收敛状态和参数调整方向
 * - 调整历史记录
 *
 * ── 输出条件 ──
 * - 样本数超过最小阈值（5 条以上）
 * - EMA 正向率低于负向阈值（< 0.4）
 * - 非振荡状态（稳定或收敛中）
 * - 有明确的参数调整方向建议
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { SignalCollector, Problem } from './types'
import { ttsTypographyFeedbackLoop } from '@akemi-mio/audio/TtsTypographyFeedbackLoop'

export class TtsTypographyCollector implements SignalCollector {
  readonly name = 'tts-typography-collector'
  readonly source = 'tts' as const

  /** 上次运行时间 */
  private lastRun = 0
  /** 最小运行间隔（30 分钟） */
  private minIntervalMs = 30 * 60 * 1000

  shouldRun(): boolean {
    if (Date.now() - this.lastRun < this.minIntervalMs) return false
    return true
  }

  async collect(): Promise<Problem[]> {
    this.lastRun = Date.now()
    const problems: Problem[] = []

    try {
      const report = ttsTypographyFeedbackLoop.generateReport()

      log('INFO', 'tts_typography_collector_data', {
        storyId: report.storyId,
        platformTag: report.platformTag,
        totalSamples: report.totalSamples,
        emaPositiveRate: report.emaPositiveRate,
        convergenceStatus: report.convergenceStatus,
        recommendedAction: report.recommendedAction,
        paramDetails: report.paramDetails
          .filter((d) => d.sampleCount >= 1)
          .map((d) => `${d.paramName}=${Math.round(d.positiveRate * 100)}%(${d.sampleCount}s)`),
      })

      // 条件：足够样本 + 需要调整
      if (report.totalSamples >= 5 && report.recommendedAction === 'adjust_typography' && report.convergenceStatus !== 'oscillating') {
        // 构建参数调整摘要
        const paramAdjustments = report.paramDetails
          .filter((d) => d.recommendedDirection !== 0 && d.sampleCount >= 5)
          .map((d) => `${d.paramName}→方向${d.recommendedDirection > 0 ? '升' : '降'}（正向率${Math.round(d.positiveRate * 100)}%）`)
          .join('; ')

        const problemsId = `tts:typography_adjust:${report.storyId}_${report.platformTag}_${Date.now()}`

        problems.push({
          id: problemsId,
          source: 'tts',
          severity: report.emaPositiveRate < 0.3 ? 'warning' : 'info',
          title: `TTS↔排版强化回路：建议调整《${report.storyId}》公众号排版参数`,
          description: `TTS EMA 正向率 ${Math.round(report.emaPositiveRate * 100)}%，样本数 ${report.totalSamples}，收敛状态 ${report.convergenceStatus}`,
          estimatedCostChars: 500,
          lastSeen: Date.now(),
          occurrenceCount: 1,
          context: {
            raw: `[tts_typography] TTS↔排版反馈回路建议
故事: ${report.storyId}
平台: ${report.platformTag}
总样本: ${report.totalSamples}
EMA正向率: ${report.emaPositiveRate}
收敛状态: ${report.convergenceStatus}
参数调整: ${paramAdjustments || '无明确调整方向'}
详情: ${JSON.stringify(report.paramDetails)}`,
            metadata: {
              recommendationType: 'typography_adjustment',
              storyId: report.storyId,
              platformTag: report.platformTag,
              totalSamples: String(report.totalSamples),
              emaPositiveRate: String(report.emaPositiveRate),
              convergenceStatus: report.convergenceStatus,
            },
          },
        })
      }

      log('INFO', 'tts_typography_collector_done', {
        problemsCreated: problems.length,
      })
    } catch (err: any) {
      log('ERROR', 'tts_typography_collector_error', { error: err.message })
    }

    return problems
  }
}
