/**
 * TtsConfigOptimizationExecutor — TTS 配置优化执行器
 *
 * 消费 TtsPreferenceCollector 生成的 Problem（source='tts'），
 * 根据推荐类型（preference_learning / ab_experiment）：
 *   1. 读取 VoicePreferenceModel 的推荐参数
 *   2. 通过 TtsConfigManager 写入 tts.config.json
 *   3. 记录变更历史
 *   4. 重置实验组（为下一轮积累新数据）
 *
 * ── 安全性 ──
 * - 只在推荐置信度 >= 0.3 时执行
 * - 单次变更幅度受 blendWeight 限制（VoicePreferenceModel 内控制）
 * - 保留回滚能力（通过 TtsConfigManager.rollback()）
 * - 不直接修改 TtsService 运行时行为，通过配置文件间接影响
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { FixExecutor, FixResult, AssignedProblem } from './types'
import { voicePreferenceModel } from '@akemi-mio/audio/VoicePreferenceModel'
import { ttsConfigManager } from '@akemi-mio/audio/TtsConfigManager'
import { ttsExperimentHook } from '@akemi-mio/audio/TtsExperimentHook'
import type { ExperimentRecord } from '@akemi-mio/audio/TtsExperimentHook'

export class TtsConfigOptimizationExecutor implements FixExecutor {
  readonly name = 'tts-config-optimization-executor'
  readonly timeoutMs = 15_000
  readonly supportedSources = ['tts'] as const

  isAvailable(): boolean {
    return true
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    const startTime = Date.now()

    try {
      const recommendationType = problem.context.metadata?.recommendationType || 'unknown'

      log('INFO', 'tts_opt_exec_start', {
        problemId: problem.id,
        type: recommendationType,
      })

      // ── 根据推荐类型执行 ──

      switch (recommendationType) {
        case 'preference_learning':
          return this.executePreferenceLearning(problem, startTime)

        case 'ab_experiment':
          return this.executeABExperiment(problem, startTime)

        default:
          return {
            problemId: problem.id,
            success: false,
            summary: `未知的推荐类型: ${recommendationType}`,
            durationMs: Date.now() - startTime,
            error: 'unknown_recommendation_type',
          }
      }
    } catch (err: any) {
      log('ERROR', 'tts_opt_exec_error', { problemId: problem.id, error: err.message })

      return {
        problemId: problem.id,
        success: false,
        summary: `TTS 配置优化失败: ${err.message}`,
        durationMs: Date.now() - startTime,
        error: err.message,
      }
    }
  }

  /**
   * 执行偏好学习推荐：读取 VoicePreferenceModel 的最新推荐，
   * 通过 TtsConfigManager 更新持久化配置。
   */
  private executePreferenceLearning(problem: AssignedProblem, startTime: number): FixResult {
    const recommendation = voicePreferenceModel.getRecommendation()

    // 安全校验：置信度足够
    if (recommendation.confidence < 0.3) {
      return {
        problemId: problem.id,
        success: false,
        summary: `推荐置信度不足: ${(recommendation.confidence * 100).toFixed(0)}% < 30%`,
        durationMs: Date.now() - startTime,
        error: 'low_confidence',
      }
    }

    // 通过 TtsConfigManager 更新配置
    const updated = ttsConfigManager.updateParams(
      recommendation.params,
      recommendation.reason,
      recommendation.totalSamples,
      recommendation.confidence,
    )

    if (!updated) {
      return {
        problemId: problem.id,
        success: true,
        summary: '✅ TTS 参数无需更新（与当前配置相同）',
        durationMs: Date.now() - startTime,
        output: `当前配置与推荐一致: ${recommendation.params.voice} ${recommendation.params.rate}/${recommendation.params.pitch}`,
      }
    }

    // 更新成功后，重置实验钩子的当前组（开始新实验周期）
    ttsExperimentHook.startNewGroup()

    const msg = `✅ TTS 配置已进化更新 (v${ttsConfigManager.getConfig().version})
${recommendation.params.voice} ${recommendation.params.rate}/${recommendation.params.pitch}
置信度: ${(recommendation.confidence * 100).toFixed(0)}% | 样本量: ${recommendation.totalSamples}
理由: ${recommendation.reason}`

    log('INFO', 'tts_opt_exec_preference_done', {
      voice: recommendation.params.voice,
      rate: recommendation.params.rate,
      pitch: recommendation.params.pitch,
      confidence: recommendation.confidence,
      samples: recommendation.totalSamples,
      version: ttsConfigManager.getConfig().version,
    })

    return {
      problemId: problem.id,
      success: true,
      summary: msg,
      durationMs: Date.now() - startTime,
      output: `TTS 配置已更新到 v${ttsConfigManager.getConfig().version}`,
    }
  }

  /**
   * 执行 A/B 实验结果推荐。
   * 如果实验组显著优于基线，提取实验参数并采纳。
   */
  private executeABExperiment(problem: AssignedProblem, startTime: number): FixResult {
    const abResult = ttsExperimentHook.getLastComparisonResult()

    if (!abResult) {
      return {
        problemId: problem.id,
        success: false,
        summary: '无 A/B 比较结果',
        durationMs: Date.now() - startTime,
        error: 'no_ab_result',
      }
    }

    if (!abResult.significant) {
      return {
        problemId: problem.id,
        success: true,
        summary: 'A/B 实验无显著差异，维持当前参数',
        durationMs: Date.now() - startTime,
        output: `基线: ${abResult.baseline.count} 次, 实验: ${abResult.experimental.count} 次, 差异: ${abResult.scoreDelta.toFixed(2)}`,
      }
    }

    if (!abResult.experimentalWins) {
      // 基线更优 → 不更新，但记录结果
      return {
        problemId: problem.id,
        success: true,
        summary: 'A/B 实验显示基线更优，维持当前参数',
        durationMs: Date.now() - startTime,
        output: `基线平均分 ${abResult.baseline.meanScore.toFixed(2)} > 实验 ${abResult.experimental.meanScore.toFixed(2)}`,
      }
    }

    // 实验组更优 → 从实验记录中提取平均参数
    const groupRecords = ttsExperimentHook.getCurrentGroupRecords()
    const expRecords = groupRecords.filter((r) => r.variant === 'experimental')

    if (expRecords.length === 0 || !expRecords[0].baselineParams) {
      return {
        problemId: problem.id,
        success: false,
        summary: 'A/B 实验胜出但无法提取具体参数',
        durationMs: Date.now() - startTime,
        error: 'no_experiment_params',
      }
    }

    // 使用平均参数（或最优记录的参数）
    const bestRecord = this.findBestExperimentalRecord(expRecords)
    if (!bestRecord) {
      return {
        problemId: problem.id,
        success: false,
        summary: 'A/B 实验胜出但无法确定最优参数',
        durationMs: Date.now() - startTime,
        error: 'no_best_record',
      }
    }

    const updated = ttsConfigManager.updateParams(
      bestRecord.params,
      `A/B实验择优: 实验组(平均分${abResult.experimental.meanScore.toFixed(2)}) vs 基线(${abResult.baseline.meanScore.toFixed(2)})`,
      expRecords.length,
      0.5,
    )

    if (updated) {
      // 开始新的实验周期
      ttsExperimentHook.startNewGroup()
    }

    const summary = updated
      ? `✅ A/B 实验择优更新: ${bestRecord.params.voice} ${bestRecord.params.rate}/${bestRecord.params.pitch}`
      : 'A/B 实验最优参数与当前配置相同'

    return {
      problemId: problem.id,
      success: true,
      summary,
      durationMs: Date.now() - startTime,
      output: `基于 ${expRecords.length} 个实验样本的参数择优`,
    }
  }

  /**
   * 从实验记录中找最优的一条（cumulativeScore 最高）。
   */
  private findBestExperimentalRecord(records: ExperimentRecord[]): ExperimentRecord | null {
    if (records.length === 0) return null

    let best = records[0]
    for (const r of records) {
      if (r.cumulativeScore > best.cumulativeScore) {
        best = r
      }
    }

    return best
  }
}
