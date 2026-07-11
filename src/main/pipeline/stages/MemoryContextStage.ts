/**
 * pipeline/stages/MemoryContextStage — 记忆上下文获取 Stage
 *
 * 从 MemoryService 中获取格式化上下文、用户画像、兴趣话题等，
 * 作为流水线的第一个数据源供下游 Stage 消费。
 */

import { log } from '../../logger/Logger'
import type { MemoryService } from '../../memory/MemoryService'
import type { StageExecutor, StageOutput, StageExecutionContext } from '../types'

export class MemoryContextStage implements StageExecutor {
  readonly stageType = 'memory-context'

  private memoryService: MemoryService | null = null

  /** 由 PipelineEngine 或外部注入 */
  setMemoryService(ms: MemoryService): void {
    this.memoryService = ms
  }

  async execute(
    config: Record<string, unknown>,
    ctx: StageExecutionContext,
  ): Promise<StageOutput> {
    const t0 = Date.now()
    const maxEntries = (config.maxEntries as number) ?? 5
    const includeEmotion = (config.includeEmotion as boolean) ?? true
    const maxTextLength = (config.maxTextLength as number) ?? 2000

    const ms = this.memoryService
    if (!ms) {
      log('WARN', 'pipeline_memory_context_no_service')
      return {
        stageId: 'memory-context',
        data: { error: 'MemoryService not available' },
        durationMs: Date.now() - t0,
        fromCache: false,
        timestamp: Date.now(),
      }
    }

    try {
      // 1. 格式化记忆上下文
      const rawContext = ms.getFormattedContext()
      const contextText = rawContext.length > maxTextLength
        ? rawContext.slice(0, maxTextLength) + '…'
        : rawContext

      // 2. 获取行为加权记忆条目
      const weightedEntries = ms.getBehaviorWeightedEntries(undefined, maxEntries)

      // 3. 提取兴趣话题
      const profile = ms.getCurrentInterestProfile()
      const interestTopics = Object.entries(profile)
        .filter(([, v]) => typeof v === 'number' && v > 0.3)
        .map(([k]) => k)

      // 4. 用户画像摘要
      const userProfileContext = ms.getUserProfileContext()

      // 5. 当前最后一条用户消息
      const lastUserText = ms.getLastUserText()

      const output: Record<string, unknown> = {
        contextText,
        rawEntries: weightedEntries.map(e => ({
          id: e.id,
          content: e.content.slice(0, 200),
          confidence: e.confidence,
          tier: e.tier,
          topics: e.topics || [],
        })),
        interestTopics,
        userProfileContext,
        lastUserText,
        includeEmotion,
        entryCount: weightedEntries.length,
      }

      log('INFO', 'pipeline_memory_context_done', {
        contextLen: contextText.length,
        entries: weightedEntries.length,
        topics: interestTopics.length,
        durationMs: Date.now() - t0,
      })

      return {
        stageId: 'memory-context',
        data: output,
        durationMs: Date.now() - t0,
        fromCache: false,
        timestamp: Date.now(),
      }
    } catch (err) {
      log('ERROR', 'pipeline_memory_context_failed', { error: String(err) })
      return {
        stageId: 'memory-context',
        data: { error: String(err) },
        durationMs: Date.now() - t0,
        fromCache: false,
        timestamp: Date.now(),
      }
    }
  }
}
