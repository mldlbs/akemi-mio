/**
 * pipeline/stages/EmotionAnalysisStage — 情感分析 Stage
 *
 * 复用 MemoryEmotionBridge 对记忆上下文进行情感分析，
 * 输出主导情感标签、语速/音调调整值等，供 TtsParameterStage 消费。
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { MemoryService } from '@akemi-mio/intelligence-memory/MemoryService'
import { memoryEmotionBridge, type AggregatedEmotionContext } from '@akemi-mio/audio/MemoryEmotionBridge'
import type { StageExecutor, StageOutput, StageExecutionContext } from '@akemi-mio/intelligence/pipeline/types'

/** 默认情感上下文（无数据时使用） */
function createDefaultEmotionContext(): AggregatedEmotionContext {
  return {
    stats: {
      dominantLabel: 'neutral',
      dominantPolarity: 'neutral',
      labelCounts: { neutral: 1 },
      polarityCounts: { neutral: 1 },
      totalEntries: 0,
      trend: 'stable',
    },
    adjustment: {
      rateDelta: 0,
      pitchDelta: 0,
      reason: '无历史情感数据',
    },
    recentEmotions: [],
  }
}

export class EmotionAnalysisStage implements StageExecutor {
  readonly stageType = 'emotion-analysis'

  private memoryService: MemoryService | null = null

  setMemoryService(ms: MemoryService): void {
    this.memoryService = ms
  }

  async execute(config: Record<string, unknown>, ctx: StageExecutionContext): Promise<StageOutput> {
    const t0 = Date.now()
    const emotionWindow = (config.emotionWindow as number) ?? 10

    const ms = this.memoryService
    if (!ms) {
      return {
        stageId: 'emotion-analysis',
        data: this.buildFallbackOutput(),
        durationMs: Date.now() - t0,
        fromCache: false,
        timestamp: Date.now(),
      }
    }

    try {
      // 复用 MemoryEmotionBridge 的情感分析能力
      const emotionContext = memoryEmotionBridge.getRecentEmotionContext(ms)

      const output: Record<string, unknown> = {
        dominantLabel: emotionContext.stats.dominantLabel,
        dominantPolarity: emotionContext.stats.dominantPolarity,
        rateDelta: emotionContext.adjustment.rateDelta,
        pitchDelta: emotionContext.adjustment.pitchDelta,
        adjustmentReason: emotionContext.adjustment.reason,
        trend: emotionContext.stats.trend,
        labelCounts: emotionContext.stats.labelCounts,
        totalEntries: emotionContext.stats.totalEntries,
        emotionWindow,
      }

      log('INFO', 'pipeline_emotion_analysis_done', {
        dominant: emotionContext.stats.dominantLabel,
        polarity: emotionContext.stats.dominantPolarity,
        rateDelta: emotionContext.adjustment.rateDelta,
        pitchDelta: emotionContext.adjustment.pitchDelta,
        trend: emotionContext.stats.trend,
        durationMs: Date.now() - t0,
      })

      return {
        stageId: 'emotion-analysis',
        data: output,
        durationMs: Date.now() - t0,
        fromCache: false,
        timestamp: Date.now(),
      }
    } catch (err) {
      log('ERROR', 'pipeline_emotion_analysis_failed', { error: String(err) })
      return {
        stageId: 'emotion-analysis',
        data: this.buildFallbackOutput(),
        durationMs: Date.now() - t0,
        fromCache: false,
        timestamp: Date.now(),
      }
    }
  }

  private buildFallbackOutput(): Record<string, unknown> {
    const fallback = createDefaultEmotionContext()
    return {
      dominantLabel: fallback.stats.dominantLabel,
      dominantPolarity: fallback.stats.dominantPolarity,
      rateDelta: fallback.adjustment.rateDelta,
      pitchDelta: fallback.adjustment.pitchDelta,
      adjustmentReason: fallback.adjustment.reason,
      trend: fallback.stats.trend,
      labelCounts: fallback.stats.labelCounts,
      totalEntries: 0,
      emotionWindow: 10,
      fallback: true,
    }
  }
}
