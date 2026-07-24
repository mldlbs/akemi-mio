/**
 * pipeline/stages/PiperSynthesisStage — Piper TTS 合成 Stage
 *
 * 流水线的最终执行环节：接收 TextProcessingStage 的清理文本 +
 * TtsParameterStage 的语音参数 → 通过 PiperOrchestrator 合成语音。
 *
 * 输出音频文件路径供播放器消费。
 */

import { log } from '../../logger/Logger'
import { ttsPiperBridge } from '../../tts/TtsPiperBridge'
import { piperBehaviorSidecar } from '../../tts/PiperBehaviorSidecar'
import type { StageExecutor, StageOutput, StageExecutionContext } from '../types'

export class PiperSynthesisStage implements StageExecutor {
  readonly stageType = 'piper-synthesis'

  async execute(
    config: Record<string, unknown>,
    ctx: StageExecutionContext,
  ): Promise<StageOutput> {
    const t0 = Date.now()
    const synthesisTimeoutMs = (config.synthesisTimeoutMs as number) ?? 30000

    // 从上游 stage 获取输入
    const textStage = ctx.inputs.get('text-processing')
    const paramsStage = ctx.inputs.get('tts-params')

    const cleanText: string =
      (textStage?.data?.cleanText as string) ??
      (ctx.pipelineInput?.text as string) ??
      ''

    if (!cleanText) {
      log('WARN', 'pipeline_piper_synthesis_no_text')
      return {
        stageId: 'piper-synthesis',
        data: {
          success: false,
          error: 'No text to synthesize',
          audioFile: '',
          durationMs: 0,
          model: '',
        },
        durationMs: Date.now() - t0,
        fromCache: false,
        timestamp: Date.now(),
      }
    }

    try {
      // 从 TTS params stage 提取参数（有默认值兜底）
      const model = (paramsStage?.data?.model as string) ?? 'zh_CN-huayan-medium'
      const speed = (paramsStage?.data?.piperSpeed as number) ?? 1.0
      const pitch = (paramsStage?.data?.piperPitch as number) ?? 1.0
      const emotionLabel = (paramsStage?.data?.label as string) ?? '中性'

      // 通过 TtsPiperBridge 构建请求，享受共享上下文的能力
      const request = ttsPiperBridge.buildPiperRequest(cleanText, {
        model,
        speed,
        pitch,
      })

      log('INFO', 'pipeline_piper_synthesis_start', {
        textLen: cleanText.length,
        model: request.model,
        speed: request.speed,
        pitch: request.pitch,
        timeoutMs: synthesisTimeoutMs,
      })

      // 执行合成（通过边车：享受缓存 + 监控能力）
      const result = await piperBehaviorSidecar.synthesize(request)
      const elapsed = Date.now() - t0

      if (result.success) {
        log('INFO', 'pipeline_piper_synthesis_done', {
          model: result.model,
          durationMs: result.durationMs,
          fallback: result.fallbackUsed,
          audioFile: result.audioFile?.slice(-40),
        })

        return {
          stageId: 'piper-synthesis',
          data: {
            success: true,
            audioFile: result.audioFile ?? '',
            model: result.model,
            synthesisDurationMs: result.durationMs,
            totalDurationMs: elapsed,
            fallbackUsed: result.fallbackUsed,
            charCount: cleanText.length,
            emotionLabel,
          },
          durationMs: elapsed,
          fromCache: false,
          timestamp: Date.now(),
        }
      }

      // 合成失败
      log('WARN', 'pipeline_piper_synthesis_failed', {
        model: result.model,
        error: result.error,
        durationMs: elapsed,
      })

      return {
        stageId: 'piper-synthesis',
        data: {
          success: false,
          error: result.error ?? 'Piper synthesis failed',
          audioFile: '',
          model: result.model,
          synthesisDurationMs: result.durationMs,
          totalDurationMs: elapsed,
          fallbackUsed: result.fallbackUsed,
          charCount: cleanText.length,
        },
        durationMs: elapsed,
        fromCache: false,
        timestamp: Date.now(),
      }
    } catch (err) {
      log('ERROR', 'pipeline_piper_synthesis_error', { error: String(err) })

      return {
        stageId: 'piper-synthesis',
        data: {
          success: false,
          error: String(err),
          audioFile: '',
          model: '',
          synthesisDurationMs: 0,
          totalDurationMs: Date.now() - t0,
          fallbackUsed: false,
          charCount: 0,
        },
        durationMs: Date.now() - t0,
        fromCache: false,
        timestamp: Date.now(),
      }
    }
  }
}
