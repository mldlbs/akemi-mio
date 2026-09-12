/**
 * TtsPreferenceCollector — TTS 偏好学习采集器
 *
 * 采集 VoicePreferenceModel 和 TtsExperimentHook 的运行时数据，
 * 将隐式反馈学习结果和 A/B 实验发现转换为优化问题，
 * 由 TtsConfigOptimizationExecutor 落地为配置变更。
 *
 * ── 采集来源 ──
 * - VoicePreferenceModel 的最新参数推荐
 * - TtsExperimentHook 的 A/B 比较结果
 * - 实验记录的样本量和置信度
 *
 * ── 输出条件 ──
 * - 隐式反馈样本数超过最小阈值（10 条以上）
 * - 推荐参数的置信度达到 0.3 以上
 * - 与当前 tts.config.json 的参数不同
 * - A/B 实验有显著结果时额外报告
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { SignalCollector, Problem } from './types'
import { voicePreferenceModel } from '@akemi-mio/audio/VoicePreferenceModel'
import { ttsExperimentHook } from '@akemi-mio/audio/TtsExperimentHook'
import { ttsConfigManager } from '@akemi-mio/audio/TtsConfigManager'

export class TtsPreferenceCollector implements SignalCollector {
  readonly name = 'tts-preference-collector'
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
      // ── 1. VoicePreferenceModel 推荐分析 ──
      const recommendation = voicePreferenceModel.getRecommendation()
      const currentConfig = ttsConfigManager.getConfig()

      log('INFO', 'tts_preference_collector_data', {
        totalSamples: recommendation.totalSamples,
        confidence: recommendation.confidence,
        recommendedRate: recommendation.params.rate,
        recommendedPitch: recommendation.params.pitch,
        currentRate: currentConfig.current.rate,
        currentPitch: currentConfig.current.pitch,
        historySize: voicePreferenceModel.getHistorySize(),
      })

      // 条件：足够样本 + 置信度达标 + 参数不同于当前配置
      if (recommendation.totalSamples >= 10 && recommendation.confidence >= 0.3) {
        const paramsChanged =
          recommendation.params.voice !== currentConfig.current.voice ||
          recommendation.params.rate !== currentConfig.current.rate ||
          recommendation.params.pitch !== currentConfig.current.pitch

        if (paramsChanged) {
          const problemId = `tts:preference_update:${recommendation.params.voice}_${recommendation.params.rate}_${recommendation.params.pitch}`

          problems.push({
            id: problemId,
            source: 'tts',
            severity: recommendation.confidence >= 0.5 ? 'warning' : 'info',
            title: 'TTS 参数优化：根据用户隐式偏好调整默认参数',
            description: `VoicePreferenceModel 推荐更新 TTS 默认参数：${recommendation.params.voice} ${recommendation.params.rate}/${recommendation.params.pitch}`,
            estimatedCostChars: 500,
            lastSeen: Date.now(),
            occurrenceCount: 1,
            context: {
              raw: `[tts_preference] VoicePreferenceModel 推荐参数更新
当前配置: ${currentConfig.current.voice} ${currentConfig.current.rate}/${currentConfig.current.pitch}
推荐配置: ${recommendation.params.voice} ${recommendation.params.rate}/${recommendation.params.pitch}
推荐置信度: ${recommendation.confidence}
总样本数: ${recommendation.totalSamples}
推荐理由: ${recommendation.reason}`,
              metadata: {
                recommendationType: 'preference_learning',
                currentVoice: currentConfig.current.voice,
                currentRate: currentConfig.current.rate,
                currentPitch: currentConfig.current.pitch,
                recommendedVoice: recommendation.params.voice,
                recommendedRate: recommendation.params.rate,
                recommendedPitch: recommendation.params.pitch,
                confidence: String(recommendation.confidence),
                totalSamples: String(recommendation.totalSamples),
                reason: recommendation.reason,
              },
            },
          })
        }
      }

      // ── 2. A/B 实验结果分析 ──
      const abResult = ttsExperimentHook.getLastComparisonResult()
      if (abResult && abResult.significant && abResult.experimentalWins !== null) {
        // 如果实验组显著优于基线，生成优化问题
        const directionLabel = abResult.experimentalWins ? '实验组更优' : '基线更优'

        problems.push({
          id: `tts:ab_result:${abResult.experimentGroupId}`,
          source: 'tts',
          severity: abResult.experimentalWins ? 'warning' : 'info',
          title: `TTS 参数 A/B 实验结果: ${directionLabel}`,
          description: `实验组分数 ${abResult.experimental.meanScore.toFixed(2)} vs 基线 ${abResult.baseline.meanScore.toFixed(2)}，差异 ${abResult.scoreDelta.toFixed(2)}`,
          estimatedCostChars: 800,
          lastSeen: Date.now(),
          occurrenceCount: 1,
          context: {
            raw: `[tts_ab_experiment] A/B 比较结果
实验组 ID: ${abResult.experimentGroupId}
基线: N=${abResult.baseline.count} 平均分=${abResult.baseline.meanScore.toFixed(2)}
实验: N=${abResult.experimental.count} 平均分=${abResult.experimental.meanScore.toFixed(2)}
分数差异: ${abResult.scoreDelta.toFixed(2)}
显著: ${abResult.significant}
实验组更优: ${abResult.experimentalWins}`,
            metadata: {
              recommendationType: 'ab_experiment',
              experimentGroupId: abResult.experimentGroupId,
              baselineCount: String(abResult.baseline.count),
              baselineMeanScore: String(abResult.baseline.meanScore.toFixed(2)),
              experimentalCount: String(abResult.experimental.count),
              experimentalMeanScore: String(abResult.experimental.meanScore.toFixed(2)),
              scoreDelta: String(abResult.scoreDelta.toFixed(2)),
              significant: String(abResult.significant),
              experimentalWins: String(abResult.experimentalWins),
            },
          },
        })
      }

      log('INFO', 'tts_preference_collector_done', {
        problemsCreated: problems.length,
        hasPreferenceUpdate: problems.some((p) => p.id.startsWith('tts:preference_update')),
        hasABResult: problems.some((p) => p.id.startsWith('tts:ab_result')),
      })
    } catch (err: any) {
      log('ERROR', 'tts_preference_collector_error', { error: err.message })
    }

    return problems
  }
}
