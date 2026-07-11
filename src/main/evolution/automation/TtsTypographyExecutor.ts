/**
 * TtsTypographyExecutor — TTS ↔ 排版强化回路 执行器
 *
 * 消费 TtsTypographyCollector 生成的 Problem（source='tts'），
 * 根据推荐类型（typography_adjustment）：
 *   1. 读取 TtsTypographyFeedbackLoop 的当前诊断状态
 *   2. 将调整建议记录到日志供人工监控（manual 模式）
 *   3. 或触发自动调整（auto 模式，通过 ttsTypographyFeedbackLoop 完成）
 *   4. 记录执行结果
 *
 * ── 安全性 ──
 * - 只在 sampleCount >= 5 时执行
 * - EMA 阻尼机制防止一次事件导致剧烈变化
 * - 收敛检测确保只在稳定状态下调整
 * - 保留人工监控期（manual 模式）
 */

import { log } from '../../logger/Logger'
import type { FixExecutor, FixResult, AssignedProblem } from './types'
import { ttsTypographyFeedbackLoop } from '../../tts/TtsTypographyFeedbackLoop'

export class TtsTypographyExecutor implements FixExecutor {
  readonly name = 'tts-typography-executor'
  readonly timeoutMs = 15_000
  readonly supportedSources = ['tts'] as const

  isAvailable(): boolean {
    return true
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    const startTime = Date.now()

    try {
      const recommendationType = problem.context.metadata?.recommendationType || 'unknown'

      log('INFO', 'tts_typography_exec_start', {
        problemId: problem.id,
        type: recommendationType,
      })

      if (recommendationType !== 'typography_adjustment') {
        return {
          problemId: problem.id,
          success: false,
          summary: `未知的推荐类型: ${recommendationType}`,
          durationMs: Date.now() - startTime,
          error: 'unknown_recommendation_type',
        }
      }

      return this.executeTypographyAdjustment(problem, startTime)
    } catch (err: any) {
      log('ERROR', 'tts_typography_exec_error', { problemId: problem.id, error: err.message })

      return {
        problemId: problem.id,
        success: false,
        summary: `TTS↔排版强化回路执行失败: ${err.message}`,
        durationMs: Date.now() - startTime,
        error: err.message,
      }
    }
  }

  private executeTypographyAdjustment(problem: AssignedProblem, startTime: number): FixResult {
    const diagnostics = ttsTypographyFeedbackLoop.getDiagnostics()
    const report = ttsTypographyFeedbackLoop.generateReport()

    // 安全检查
    if (diagnostics.totalSamples < 5) {
      return {
        problemId: problem.id,
        success: false,
        summary: `样本量不足: ${diagnostics.totalSamples} < 5，跳过调整`,
        durationMs: Date.now() - startTime,
        error: 'insufficient_samples',
      }
    }

    if (report.convergenceStatus === 'oscillating') {
      return {
        problemId: problem.id,
        success: false,
        summary: 'TTS↔排版回路正在振荡，调整 alpha 降低灵敏度后跳过本次调整',
        durationMs: Date.now() - startTime,
        error: 'oscillating',
      }
    }

    // 检查是 manual 还是 auto 模式
    if (diagnostics.mode === 'manual') {
      // manual 模式：生成调整建议供人工参考
      const paramDetails = report.paramDetails
        .filter((d) => d.sampleCount >= 5 && d.recommendedDirection !== 0)

      if (paramDetails.length === 0) {
        return {
          problemId: problem.id,
          success: true,
          summary: '✅ 无需调整：所有排版参数的反馈评分达到阈值',
          durationMs: Date.now() - startTime,
          output: `EMA正向率: ${Math.round(report.emaPositiveRate * 100)}%, 样本数: ${report.totalSamples}`,
        }
      }

      const paramSummary = paramDetails
        .map((d) => `${d.paramName} 正向率${Math.round(d.positiveRate * 100)}% (${d.sampleCount}样本)`)
        .join(', ')

      const msg = `📋 [manual] TTS↔排版强化回路建议
故事: ${report.storyId} @ ${report.platformTag}
EMA正向率: ${Math.round(report.emaPositiveRate * 100)}%
收敛状态: ${report.convergenceStatus}
样本数: ${report.totalSamples}

需要关注的参数:
${paramDetails.map((d) => `  - ${d.paramName}(${Math.round(d.positiveRate * 100)}%): 建议向${d.recommendedDirection > 0 ? '升' : '降'}档调整`).join('\n')}

请审阅以上建议，确认是否执行调整。
要切换到自动模式，调用 ttsTypographyFeedbackLoop.setMode('auto')。`

      log('INFO', 'tts_typography_manual_advice', {
        storyId: report.storyId,
        platformTag: report.platformTag,
        emaRate: Math.round(report.emaPositiveRate * 100),
        paramSummary,
      })

      return {
        problemId: problem.id,
        success: true,
        summary: msg,
        durationMs: Date.now() - startTime,
        output: `TTS↔排版手动建议已生成`,
      }
    }

    // auto 模式：通过 TtsTypographyFeedbackLoop 自行处理
    // 反馈回路已在 recordFeedback 中处理自动评估和调整
    // 这里的任务只是确认状态

    const currentConfig = ttsTypographyFeedbackLoop.getConfig()

    return {
      problemId: problem.id,
      success: true,
      summary: `✅ TTS↔排版强化回路已处于自动模式，反馈闭环正常运行。
EMA正向率: ${Math.round(report.emaPositiveRate * 100)}%
样本数: ${report.totalSamples}
收敛状态: ${report.convergenceStatus}
Alpha: ${currentConfig.alpha}
上次调整数: ${report.recentAdjustments}`,
      durationMs: Date.now() - startTime,
      output: `TTS↔排版回路 auto 模式正常运行`,
    }
  }
}
