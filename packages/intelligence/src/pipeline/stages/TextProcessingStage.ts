/**
 * pipeline/stages/TextProcessingStage — 文本处理 Stage
 *
 * 对上游 MemoryContextStage 输出的文本进行清理：
 * - 复用 TtsService.cleanTTS 的清理规则（去 Markdown、去除颜文字等）
 * - 提取情感词、关键信息等
 * - 处理后的干净文本供 PiperSynthesisStage 使用
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { cleanTTS } from '@akemi-mio/audio/TtsService'
import type { StageExecutor, StageOutput, StageExecutionContext } from '@akemi-mio/intelligence/pipeline/types'

export class TextProcessingStage implements StageExecutor {
  readonly stageType = 'text-processing'

  async execute(config: Record<string, unknown>, ctx: StageExecutionContext): Promise<StageOutput> {
    const t0 = Date.now()
    const minTextLength = (config.minTextLength as number) ?? 15

    // 从上游 memory-context stage 获取文本
    const memoryStage = ctx.inputs.get('memory-context')
    const rawText: string = (memoryStage?.data?.contextText as string) ?? (ctx.pipelineInput?.text as string) ?? ''

    if (!rawText) {
      log('WARN', 'pipeline_text_processing_no_input')
      return {
        stageId: 'text-processing',
        data: {
          error: 'No input text available',
          cleanText: '',
          charCount: 0,
          originalLength: 0,
        },
        durationMs: Date.now() - t0,
        fromCache: false,
        timestamp: Date.now(),
      }
    }

    try {
      // 复用现有的 cleanTTS（去 Markdown 标记、超长代理、颜文字等）
      const cleanText = cleanTTS(rawText)

      // 如果清理后文本太短但原始文本有内容，说明全被过滤了
      const finalText =
        cleanText.length < minTextLength && rawText.length > minTextLength
          ? rawText.slice(0, 200) // 回退：截取前 200 字符
          : cleanText

      const charCount = finalText.length
      const originalLength = rawText.length
      const removedChars = originalLength - charCount

      // 提取关键词（用于下游参数决策）
      const keywords = this.extractKeywords(finalText)

      const output: Record<string, unknown> = {
        cleanText: finalText,
        charCount,
        originalLength,
        removedChars,
        keywords,
        processed: true,
      }

      log('INFO', 'pipeline_text_processing_done', {
        originalLength,
        charCount,
        removed: removedChars,
        keywords: keywords.length,
        durationMs: Date.now() - t0,
      })

      return {
        stageId: 'text-processing',
        data: output,
        durationMs: Date.now() - t0,
        fromCache: false,
        timestamp: Date.now(),
      }
    } catch (err) {
      log('ERROR', 'pipeline_text_processing_failed', { error: String(err) })
      return {
        stageId: 'text-processing',
        data: {
          error: String(err),
          cleanText: '',
          charCount: 0,
          originalLength: rawText.length,
        },
        durationMs: Date.now() - t0,
        fromCache: false,
        timestamp: Date.now(),
      }
    }
  }

  /**
   * 从文本中提取关键词（简单实现：基于长度的词/短语）
   */
  private extractKeywords(text: string): string[] {
    // 匹配中文或英文词汇（3 字以上中文词 / 5 字符以上英文词）
    const zhWords = text.match(/[一-鿿]{3,}/g) || []
    const enWords = text.match(/[a-zA-Z]{5,}/g) || []

    // 去重取前 10
    const all = [...zhWords, ...enWords.map((w) => w.toLowerCase())]
    return [...new Set(all)].slice(0, 10)
  }
}
