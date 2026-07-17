/**
 * pipeline/stages/ASRProcessingStage — ASR 音频/文本处理 Stage
 *
 * 将 ASR（Automatic Speech Recognition）处理封装为流水线中一环：
 * - transcribe 模式：接收上游 MCP 工具输出的音频文件路径 → 通过 AsrService 转写为文本
 * - process-text 模式：接收上游文本 → 通过语音意图匹配等环节处理
 *
 * 这使得 ASR 能力可以被流水线编排（依赖、缓存、重放），
 * 上游 MCP 工具的音频输出可直接流向此 Stage 进行语音识别。
 *
 * 使用方式（pipeline JSON）：
 * {
 *   "id": "asr-process",
 *   "stageType": "asr-processing",
 *   "dependsOn": ["mcp-exec"],
 *   "config": {
 *     "mode": "transcribe",
 *     "audioField": "audioFile",
 *     "sourceStage": "mcp-exec"
 *   }
 * }
 *
 * 或纯文本处理模式：
 * {
 *   "config": {
 *     "mode": "process-text",
 *     "textField": "outputText",
 *     "sourceStage": "mcp-exec"
 *   }
 * }
 */

import { promises as fsp } from 'fs'
import { log } from '../../logger/Logger'
import { getAsrService } from '../../tool/deps'
import type { StageExecutor, StageOutput, StageExecutionContext } from '../types'

export class ASRProcessingStage implements StageExecutor {
  readonly stageType = 'asr-processing'

  async execute(
    config: Record<string, unknown>,
    ctx: StageExecutionContext,
  ): Promise<StageOutput> {
    const t0 = Date.now()
    const mode = (config.mode as string) ?? 'process-text'
    const sourceStage = (config.sourceStage as string) ?? ''
    const textField = (config.textField as string) ?? 'outputText'
    const audioField = (config.audioField as string) ?? 'audioFile'

    // 从上游 stage 或 pipelineInput 获取源数据
    const sourceData = sourceStage
      ? ctx.inputs.get(sourceStage)?.data ?? {}
      : ctx.pipelineInput

    if (mode === 'transcribe') {
      return this.handleTranscribe(sourceData, audioField, config, ctx, t0)
    }

    return this.handleProcessText(sourceData, textField, config, ctx, t0)
  }

  // ── 模式一：音频转写 ──

  private async handleTranscribe(
    sourceData: Record<string, unknown>,
    audioField: string,
    _config: Record<string, unknown>,
    ctx: StageExecutionContext,
    t0: number,
  ): Promise<StageOutput> {
    const audioPath = sourceData[audioField] as string | undefined

    if (!audioPath) {
      log('WARN', 'pipeline_asr_no_audio_path', {
        availableFields: Object.keys(sourceData).join(', '),
        traceId: ctx.traceId,
      })
      return {
        stageId: 'asr-processing',
        data: {
          success: false,
          mode: 'transcribe',
          error: `No audio field "${audioField}" found in source stage output`,
          text: '',
        },
        durationMs: Date.now() - t0,
        fromCache: false,
        timestamp: Date.now(),
      }
    }

    // 获取 ASR 服务
    const asrService = getAsrService()
    if (!asrService) {
      log('WARN', 'pipeline_asr_no_service', { traceId: ctx.traceId })
      return {
        stageId: 'asr-processing',
        data: {
          success: false,
          mode: 'transcribe',
          error: 'AsrService not available. Call setAsrService() first.',
          text: '',
          audioPath,
        },
        durationMs: Date.now() - t0,
        fromCache: false,
        timestamp: Date.now(),
      }
    }

    try {
      // 读取音频文件
      const audioBuffer = await fsp.readFile(audioPath)
      const arrayBuffer = audioBuffer.buffer.slice(
        audioBuffer.byteOffset,
        audioBuffer.byteOffset + audioBuffer.byteLength,
      )

      log('INFO', 'pipeline_asr_transcribe_start', {
        audioPath: audioPath.slice(-60),
        sizeBytes: audioBuffer.length,
        traceId: ctx.traceId,
      })

      // 执行 ASR 转写
      const result = await asrService.transcribe(arrayBuffer, ctx.traceId)

      const elapsed = Date.now() - t0
      const success = !result.error && result.text.length > 0

      log('INFO', 'pipeline_asr_transcribe_done', {
        success,
        textLen: result.text.length,
        text: result.text.slice(0, 100),
        durationMs: elapsed,
        traceId: ctx.traceId,
        hasVoiceEmotion: !!result.voiceEmotion,
      })

      return {
        stageId: 'asr-processing',
        data: {
          success,
          mode: 'transcribe',
          text: result.text,
          sourceAudio: audioPath,
          requestId: result.request_id,
          error: result.error ?? null,
          voiceEmotion: result.voiceEmotion ?? null,
          audioSizeBytes: audioBuffer.length,
          durationMs: elapsed,
        },
        durationMs: elapsed,
        fromCache: false,
        timestamp: Date.now(),
      }
    } catch (err) {
      const elapsed = Date.now() - t0
      const errMsg = err instanceof Error ? err.message : String(err)

      log('ERROR', 'pipeline_asr_transcribe_failed', {
        error: errMsg,
        audioPath: audioPath.slice(-60),
        durationMs: elapsed,
        traceId: ctx.traceId,
      })

      return {
        stageId: 'asr-processing',
        data: {
          success: false,
          mode: 'transcribe',
          error: errMsg,
          text: '',
          audioPath,
        },
        durationMs: elapsed,
        fromCache: false,
        timestamp: Date.now(),
      }
    }
  }

  // ── 模式二：文本处理 ──

  private async handleProcessText(
    sourceData: Record<string, unknown>,
    textField: string,
    _config: Record<string, unknown>,
    ctx: StageExecutionContext,
    t0: number,
  ): Promise<StageOutput> {
    // 从上游数据中提取文本
    const rawText = (sourceData[textField] as string) ??
      (sourceData.text as string) ??
      (sourceData.outputText as string) ??
      (ctx.pipelineInput?.text as string) ??
      ''

    const confidence = sourceData.confidence as number | undefined

    if (!rawText) {
      log('WARN', 'pipeline_asr_no_text', {
        field: textField,
        availableFields: Object.keys(sourceData).join(', '),
        traceId: ctx.traceId,
      })
      return {
        stageId: 'asr-processing',
        data: {
          success: false,
          mode: 'process-text',
          error: `No text content found in source stage at field "${textField}"`,
          processedText: '',
          originalText: '',
        },
        durationMs: Date.now() - t0,
        fromCache: false,
        timestamp: Date.now(),
      }
    }

    try {
      // 文本处理分析
      const processedText = rawText.trim()
      const charCount = processedText.length
      const wordCount = this.estimateWordCount(processedText)

      // 基础文本质量指标
      const metrics = {
        charCount,
        wordCount,
        hasChinese: /[一-鿿]/.test(processedText),
        hasEnglish: /[a-zA-Z]/.test(processedText),
        hasPunctuation: /[，。！？、；：""''（）【】《》\.,!?;:'"()\[\]{}]/.test(processedText),
        lineCount: processedText.split('\n').length,
        confidence: confidence ?? null,
      }

      // 语音意图关键词提取（中英文混合）
      const keywords = this.extractKeywords(processedText)

      log('INFO', 'pipeline_asr_process_text_done', {
        charCount,
        wordCount,
        keywordCount: keywords.length,
        durationMs: Date.now() - t0,
        traceId: ctx.traceId,
      })

      return {
        stageId: 'asr-processing',
        data: {
          success: true,
          mode: 'process-text',
          processedText,
          originalText: rawText,
          metrics,
          keywords,
          sourceConfidence: confidence ?? null,
        },
        durationMs: Date.now() - t0,
        fromCache: false,
        timestamp: Date.now(),
      }
    } catch (err) {
      const elapsed = Date.now() - t0
      const errMsg = err instanceof Error ? err.message : String(err)

      log('ERROR', 'pipeline_asr_process_text_failed', {
        error: errMsg,
        durationMs: elapsed,
        traceId: ctx.traceId,
      })

      return {
        stageId: 'asr-processing',
        data: {
          success: false,
          mode: 'process-text',
          error: errMsg,
          processedText: '',
          originalText: rawText,
        },
        durationMs: elapsed,
        fromCache: false,
        timestamp: Date.now(),
      }
    }
  }

  // ── 辅助方法 ──

  /**
   * 估算文本的 "词" 数量。
   * 中文按字符数估算，英文按空格分词。
   */
  private estimateWordCount(text: string): number {
    // 中文：每 2 个字符约 1 词
    const zhChars = (text.match(/[一-鿿]/g) || []).length
    // 英文：按空格分词
    const enWords = text
      .replace(/[一-鿿]/g, ' ')
      .split(/\s+/)
      .filter(Boolean).length
    return Math.round(zhChars / 2) + enWords
  }

  /**
   * 从文本中提取语音相关的关键词。
   * 用于下游 ASR 意图匹配和 TTS 参数决策。
   */
  private extractKeywords(text: string): string[] {
    // 中英文词汇提取
    const zhWords = text.match(/[一-鿿]{2,}/g) || []
    const enWords = text.match(/[a-zA-Z]{4,}/g) || []

    // 去重，按长度排序取前 15
    const all = [...new Set([
      ...zhWords,
      ...enWords.map(w => w.toLowerCase()),
    ])]
    return all.sort((a, b) => b.length - a.length).slice(0, 15)
  }
}
