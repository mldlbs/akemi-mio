/**
 * pipeline/stages/ASRCrossValidationStage — ASR × PiperTTS 交叉验证 Stage
 *
 * 将 ASR（自动语音识别）嵌入 PiperTTS 流水线的验证环节：
 * 1. 接收上游 PiperSynthesisStage 合成的音频文件路径
 * 2. 接收上游 TextProcessingStage 的原始文本
 * 3. 通过 AsrService 对 TTS 输出音频进行转写
 * 4. 计算原始文本与 ASR 转写文本的相似度（CER / 重叠率）
 * 5. 触发仲裁：根据相似度阈值决定 pass / warning / retry
 *
 * 设计目的：
 * - 闭合反馈：TTS 输出 → ASR 验证 → 质量评分，形成闭环
 * - 降低系统性偏差：单一 TTS 引擎的发音/语调偏差可被 ASR 检出
 * - 仲裁机制：不一致时标记质量降级或触发重新合成
 *
 * 使用方式（pipeline JSON）：
 * {
 *   "id": "asr-cross-validation",
 *   "stageType": "asr-cross-validation",
 *   "dependsOn": ["piper-synthesis", "text-processing"],
 *   "config": {
 *     "validationMode": "normal",
 *     "similarityThreshold": 0.70,
 *     "strictThreshold": 0.90,
 *     "enableAutoRetry": true
 *   }
 * }
 *
 * 输出字段：
 * - validated: boolean        是否通过验证
 * - originalText: string      原始文本
 * - asrText: string           ASR 转写文本
 * - similarity: number        归一化相似度 (0-1)
 * - cer: number               字符错误率 (0-1)
 * - arbitrationResult: string 仲裁结论: 'pass' | 'warning' | 'retry' | 'error'
 * - retryAttempted: boolean   是否尝试过重新合成
 * - retrySuccess: boolean     重新合成是否成功
 * - voiceEmotion: object|null ASR 检测到的语音情感
 */
import { promises as fsp } from 'fs'
import { log } from '@akemi-mio/core/logger/Logger'
import { getAsrService } from '@akemi-mio/capabilities/tool/deps'
import { piperOrchestrator } from '@akemi-mio/audio/PiperOrchestrator'
import { ttsPiperBridge } from '@akemi-mio/audio/TtsPiperBridge'
import type { StageExecutor, StageOutput, StageExecutionContext } from '@akemi-mio/intelligence/pipeline/types'

// ═══════════════════════════════════════════════
//  常量
// ═══════════════════════════════════════════════

/** 默认相似度阈值（低于此值视为警告） */
const DEFAULT_THRESHOLD = 0.7

/** 严格模式阈值（低于此值视为需要重试） */
const DEFAULT_STRICT_THRESHOLD = 0.5

/** 音频文件最小有效大小（字节），小于此值视为文件损坏 */
const MIN_AUDIO_SIZE = 256

/** 用于比较时忽略的标点符号集合 */
const PUNCTUATION_PATTERN = /[，。！？、；：""''（）【】《》\s.,!?;:'"()[\]{}「」『』…—～·]/g

// ═══════════════════════════════════════════════
//  工具函数
// ═══════════════════════════════════════════════

/**
 * 计算编辑距离（Levenshtein Distance）。
 * 用于后续计算 CER（字符错误率）。
 */
function levenshteinDistance(a: string, b: string): number {
  const an = a.length
  const bn = b.length
  if (an === 0) return bn
  if (bn === 0) return an

  // 使用滚动数组优化空间 O(min(a,b))
  const [shorter, longer] = an < bn ? [a, b] : [b, a]
  const [sn, ln] = [shorter.length, longer.length]

  let prevRow = new Array<number>(sn + 1)
  let currRow = new Array<number>(sn + 1)

  for (let j = 0; j <= sn; j++) prevRow[j] = j

  for (let i = 1; i <= ln; i++) {
    currRow[0] = i
    for (let j = 1; j <= sn; j++) {
      const cost = shorter[j - 1] === longer[i - 1] ? 0 : 1
      currRow[j] = Math.min(
        prevRow[j] + 1, // 删除
        currRow[j - 1] + 1, // 插入
        prevRow[j - 1] + cost, // 替换
      )
    }
    ;[prevRow, currRow] = [currRow, prevRow]
  }

  return prevRow[sn]
}

/**
 * 计算 CER（Character Error Rate）。
 * CER = 编辑距离 / 原始文本长度
 * 返回 0-1 的值，0=完全匹配，1=完全不相关。
 */
function computeCER(original: string, transcribed: string): number {
  const maxLen = Math.max(original.length, transcribed.length)
  if (maxLen === 0) return 0
  return levenshteinDistance(original, transcribed) / maxLen
}

/**
 * 标准化文本用于比较：去除标点符号、转小写、合并空白。
 */
function normalizeForCompare(text: string): string {
  return text.replace(PUNCTUATION_PATTERN, '').replace(/\s+/g, ' ').toLowerCase().trim()
}

/**
 * 计算文本重叠相似度。
 * 使用 n-gram 重叠比率（bigram），对中文较短文本友好。
 * 返回 0-1 的值，1=完全重叠。
 */
function computeOverlapSimilarity(original: string, transcribed: string): number {
  const a = normalizeForCompare(original)
  const b = normalizeForCompare(transcribed)

  if (a.length === 0 && b.length === 0) return 1.0
  if (a.length === 0 || b.length === 0) return 0.0

  // 提取 bigram 集合
  const bigramsA = new Set<string>()
  const bigramsB = new Set<string>()

  for (let i = 0; i < a.length - 1; i++) {
    bigramsA.add(a.slice(i, i + 2))
  }
  for (let i = 0; i < b.length - 1; i++) {
    bigramsB.add(b.slice(i, i + 2))
  }

  // Jaccard 相似度
  const intersection = new Set<string>()
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection.add(bg)
  }

  const union = new Set([...bigramsA, ...bigramsB])
  if (union.size === 0) return 1.0

  return intersection.size / union.size
}

/**
 * 综合相似度评分：结合 CER 和重叠相似度。
 * 返回 0-1 的值，1=完全一致。
 */
function computeCombinedSimilarity(original: string, transcribed: string): number {
  if (original === transcribed) return 1.0

  const cer = computeCER(original, transcribed)
  const overlap = computeOverlapSimilarity(original, transcribed)

  // 综合评分：1 - CER 作为基础，用重叠率修正
  const fromCer = 1 - cer
  const combined = fromCer * 0.6 + overlap * 0.4

  return Math.max(0, Math.min(1, combined))
}

// ═══════════════════════════════════════════════
//  Stage 实现
// ═══════════════════════════════════════════════

export class ASRCrossValidationStage implements StageExecutor {
  readonly stageType = 'asr-cross-validation'

  async execute(config: Record<string, unknown>, ctx: StageExecutionContext): Promise<StageOutput> {
    const t0 = Date.now()
    const validationMode = (config.validationMode as string) ?? 'normal'
    const threshold = (config.similarityThreshold as number) ?? DEFAULT_THRESHOLD
    const strictThreshold = (config.strictThreshold as number) ?? DEFAULT_STRICT_THRESHOLD
    const enableAutoRetry = (config.enableAutoRetry as boolean) ?? false

    // 从上游 stage 获取数据
    const piperStage = ctx.inputs.get('piper-synthesis')
    const textStage = ctx.inputs.get('text-processing')

    // 提取音频文件路径
    const audioFile: string = (piperStage?.data?.audioFile as string) ?? ''
    const synthesisSuccess: boolean = (piperStage?.data?.success as boolean) ?? false

    // 提取原始文本（优先 text-processing → pipelineInput）
    const originalText: string = (textStage?.data?.cleanText as string) ?? (ctx.pipelineInput?.text as string) ?? ''

    // 元信息
    const modelUsed: string = (piperStage?.data?.model as string) ?? ''
    const emotionLabel: string = (piperStage?.data?.emotionLabel as string) ?? ''
    const synthesisDurationMs: number = (piperStage?.data?.synthesisDurationMs as number) ?? 0

    // ── 校验：合成是否成功 ──

    if (!synthesisSuccess || !audioFile) {
      log('WARN', 'pipeline_asr_crossval_synth_failed', {
        hasAudio: !!audioFile,
        synthSuccess: synthesisSuccess,
        traceId: ctx.traceId,
      })
      return {
        stageId: 'asr-cross-validation',
        data: {
          validated: false,
          originalText,
          asrText: '',
          similarity: 0,
          cer: 1,
          arbitrationResult: 'error',
          reason: 'Piper synthesis did not produce valid audio',
          modelUsed,
        },
        durationMs: Date.now() - t0,
        fromCache: false,
        timestamp: Date.now(),
      }
    }

    if (!originalText) {
      log('WARN', 'pipeline_asr_crossval_no_text', {
        traceId: ctx.traceId,
      })
      return {
        stageId: 'asr-cross-validation',
        data: {
          validated: false,
          originalText: '',
          asrText: '',
          similarity: 0,
          cer: 1,
          arbitrationResult: 'error',
          reason: 'No original text available for comparison',
          audioFile,
          modelUsed,
        },
        durationMs: Date.now() - t0,
        fromCache: false,
        timestamp: Date.now(),
      }
    }

    try {
      // ── 执行 ASR 转写 ──
      const asrResult = await this.transcribeAudio(audioFile, ctx.traceId)

      if (!asrResult.success) {
        log('WARN', 'pipeline_asr_crossval_asr_failed', {
          error: asrResult.error,
          traceId: ctx.traceId,
        })
        return {
          stageId: 'asr-cross-validation',
          data: {
            validated: false,
            originalText,
            asrText: '',
            similarity: 0,
            cer: 1,
            arbitrationResult: 'error',
            reason: `ASR transcription failed: ${asrResult.error}`,
            audioFile,
            modelUsed,
          },
          durationMs: Date.now() - t0,
          fromCache: false,
          timestamp: Date.now(),
        }
      }

      const asrText = asrResult.text ?? ''
      const voiceEmotion = asrResult.voiceEmotion ?? null

      // ── 计算相似度指标 ──
      const similarity = computeCombinedSimilarity(originalText, asrText)
      const cer = computeCER(originalText, asrText)
      const overlapSimilarity = computeOverlapSimilarity(originalText, asrText)

      // ── 仲裁逻辑 ──
      const arbitrationResult = this.arbitrate(similarity, cer, validationMode, threshold, strictThreshold)

      log('INFO', 'pipeline_asr_crossval_result', {
        similarity: similarity.toFixed(3),
        cer: cer.toFixed(3),
        overlap: overlapSimilarity.toFixed(3),
        arbitrationResult,
        originalLen: originalText.length,
        asrLen: asrText.length,
        mode: validationMode,
        durationMs: Date.now() - t0,
        traceId: ctx.traceId,
      })

      // ── 自动重试（如果启用且仲裁结果为 retry） ──
      let retryAttempted = false
      let retrySuccess = false
      let retrySimilarity = 0
      let retryAsrText = ''
      let retryVoiceEmotion: unknown = null
      let finalArbitrationResult = arbitrationResult

      if (enableAutoRetry && arbitrationResult === 'retry') {
        retryAttempted = true
        log('INFO', 'pipeline_asr_crossval_retry_start', {
          model: modelUsed,
          traceId: ctx.traceId,
        })

        try {
          // 尝试用不同参数重新合成（降低语速，提高清晰度）
          const retryResult = await this.retrySynthesis(originalText, modelUsed, ctx.traceId)

          if (retryResult.success && retryResult.audioFile) {
            // 对重试结果再次 ASR
            const retryAsr = await this.transcribeAudio(retryResult.audioFile, `${ctx.traceId}_retry`)

            if (retryAsr.success) {
              retryAsrText = retryAsr.text ?? ''
              retryVoiceEmotion = retryAsr.voiceEmotion ?? null
              retrySimilarity = computeCombinedSimilarity(originalText, retryAsrText)

              // 如果重试后的相似度更好，使用重试结果
              if (retrySimilarity > similarity) {
                retrySuccess = true
                finalArbitrationResult = retrySimilarity >= threshold ? 'pass' : 'warning'

                log('INFO', 'pipeline_asr_crossval_retry_improved', {
                  before: similarity.toFixed(3),
                  after: retrySimilarity.toFixed(3),
                  result: finalArbitrationResult,
                  traceId: ctx.traceId,
                })
              } else {
                log('INFO', 'pipeline_asr_crossval_retry_no_improvement', {
                  before: similarity.toFixed(3),
                  after: retrySimilarity.toFixed(3),
                  traceId: ctx.traceId,
                })
              }
            }

            // 清理重试产生的临时文件
            if (retryResult.audioFile !== audioFile) {
              fsp.unlink(retryResult.audioFile).catch(() => {})
            }
          }
        } catch (retryErr) {
          log('WARN', 'pipeline_asr_crossval_retry_failed', {
            error: String(retryErr),
            traceId: ctx.traceId,
          })
        }
      }

      // ── 构建输出 ──
      const output: Record<string, unknown> = {
        // 验证结果
        validated: finalArbitrationResult === 'pass' || finalArbitrationResult === 'warning',
        originalText,
        asrText: retrySuccess ? retryAsrText : asrText,

        // 相似度指标
        similarity: retrySuccess ? retrySimilarity : similarity,
        cer,
        overlapSimilarity,

        // 仲裁结果
        arbitrationResult: finalArbitrationResult,
        validationMode,

        // 重试信息
        retryAttempted,
        retrySuccess,

        // 元信息
        audioFile: retrySuccess ? '' : audioFile, // retry 成功的文件已清理
        modelUsed,
        emotionLabel,
        synthesisDurationMs,
        totalDurationMs: Date.now() - t0,

        // ASR 语音情感
        voiceEmotion: retryVoiceEmotion ?? voiceEmotion,
      }

      log('INFO', 'pipeline_asr_crossval_done', {
        validated: output.validated,
        result: finalArbitrationResult,
        similarity: (output.similarity as number).toFixed(3),
        retry: retryAttempted,
        retryOk: retrySuccess,
        durationMs: Date.now() - t0,
        traceId: ctx.traceId,
      })

      return {
        stageId: 'asr-cross-validation',
        data: output,
        durationMs: Date.now() - t0,
        fromCache: false,
        timestamp: Date.now(),
      }
    } catch (err) {
      const elapsed = Date.now() - t0
      const errMsg = err instanceof Error ? err.message : String(err)

      log('ERROR', 'pipeline_asr_crossval_error', {
        error: errMsg,
        durationMs: elapsed,
        traceId: ctx.traceId,
      })

      return {
        stageId: 'asr-cross-validation',
        data: {
          validated: false,
          originalText,
          asrText: '',
          similarity: 0,
          cer: 1,
          arbitrationResult: 'error',
          reason: errMsg,
          audioFile,
          modelUsed,
        },
        durationMs: elapsed,
        fromCache: false,
        timestamp: Date.now(),
      }
    }
  }

  // ══════════════════════════════════════════════
  //  内部方法
  // ══════════════════════════════════════════════

  /**
   * 通过 AsrService 对音频文件进行转写。
   * 从 tool/deps 获取 ASR 服务实例。
   */
  private async transcribeAudio(
    audioPath: string,
    traceId: string,
  ): Promise<{
    success: boolean
    text: string
    error?: string
    voiceEmotion?: unknown
  }> {
    // 检查文件是否存在且有效
    try {
      const stat = await fsp.stat(audioPath)
      if (stat.size < MIN_AUDIO_SIZE) {
        return {
          success: false,
          text: '',
          error: `Audio file too small: ${stat.size} bytes`,
        }
      }
    } catch {
      return {
        success: false,
        text: '',
        error: `Audio file not accessible: ${audioPath.slice(-60)}`,
      }
    }

    const asrService = getAsrService()
    if (!asrService) {
      return {
        success: false,
        text: '',
        error: 'AsrService not available',
      }
    }

    // 读取音频文件
    const audioBuffer = await fsp.readFile(audioPath)
    const arrayBuffer = audioBuffer.buffer.slice(audioBuffer.byteOffset, audioBuffer.byteOffset + audioBuffer.byteLength)

    // 执行 ASR 转写
    const result = await asrService.transcribe(arrayBuffer, `crossval_${traceId}`)

    return {
      success: !result.error && result.text.length > 0,
      text: result.text,
      error: result.error,
      voiceEmotion: result.voiceEmotion,
    }
  }

  /**
   * 仲裁逻辑：根据相似度、CER 和验证模式决定结果。
   *
   * - pass:   质量合格（相似度 ≥ threshold）
   * - warning:质量警告（相似度 > strictThreshold 但 < threshold）
   * - retry:  质量不合格（相似度 ≤ strictThreshold）
   * - error:  数据错误（已在外部判断）
   */
  private arbitrate(
    similarity: number,
    cer: number,
    mode: string,
    threshold: number,
    strictThreshold: number,
  ): 'pass' | 'warning' | 'retry' {
    // 不同模式使用不同阈值
    let effectiveTh = threshold
    let effectiveStrict = strictThreshold

    switch (mode) {
      case 'strict':
        effectiveTh = Math.min(1, threshold + 0.15) // 更严格
        effectiveStrict = Math.min(1, strictThreshold + 0.15)
        break
      case 'relaxed':
        effectiveTh = Math.max(0, threshold - 0.15) // 更宽松
        effectiveStrict = Math.max(0, strictThreshold - 0.15)
        break
      case 'normal':
      default:
        // 使用默认阈值
        break
    }

    if (similarity >= effectiveTh) return 'pass'
    if (similarity > effectiveStrict) return 'warning'
    return 'retry'
  }

  /**
   * 重新合成：使用降低语速的参数尝试获得更高质量的音频。
   */
  private async retrySynthesis(
    text: string,
    originalModel: string,
    traceId: string,
  ): Promise<{
    success: boolean
    audioFile?: string
    error?: string
  }> {
    // 使用 TtsPiperBridge 构建带慢速参数的重试请求
    const request = ttsPiperBridge.buildPiperRequest(text, {
      model: originalModel,
      speed: 0.85, // 降低语速以提高清晰度
      pitch: 1.0,
    })

    const result = await piperOrchestrator.synthesize(request)

    if (result.success) {
      log('INFO', 'pipeline_asr_crossval_retry_synth_ok', {
        model: result.model,
        audioFile: result.audioFile?.slice(-40),
        traceId,
      })
    } else {
      log('WARN', 'pipeline_asr_crossval_retry_synth_failed', {
        error: result.error,
        traceId,
      })
    }

    return {
      success: result.success,
      audioFile: result.audioFile,
      error: result.error,
    }
  }
}
