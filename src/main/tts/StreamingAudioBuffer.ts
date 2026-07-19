/**
 * StreamingAudioBuffer — 流式音频分块合成与播放缓冲
 *
 * 功能：
 * 1. 按句拆分文本（句号、叹号、问号、换行）
 * 2. 逐句合成语音（支持 Piper / Edge TTS 引擎切换）
 * 3. 每句合成完成后通过 IPC 立即发送到渲染进程播放
 * 4. 自动清理临时文件
 *
 * 设计原则：
 * - 顺序合成：确保播放顺序与文本顺序一致
 * - 立即推送：每句合成完毕即刻发送，实现边合成边播放效果
 * - 无阻塞：合成流程不等待播放完成，仅保证发送顺序
 * - 容错：单句合成失败不影响后续句子
 */

import { BrowserWindow } from 'electron'
import { unlinkSync } from 'fs'
import { log } from '../logger/Logger'
import { cleanTTS } from './TtsService'
import { ttsRouter } from './TtsRouter'
import { piperOrchestrator } from './PiperOrchestrator'
import { voiceStyleMap } from './VoiceStyleMap'
import { execFile } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import { promises as fsp } from 'fs'
import type { EmotionTtsParams, VoiceStyle } from './types'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 流式合成配置 */
export interface StreamingConfig {
  /** 引擎选择：auto=自动路由, cloud=云端, local=本地 */
  engine: 'auto' | 'cloud' | 'local'
  /** 是否启用流式模式 */
  enabled: boolean
  /** edge-tts 语音参数 */
  voice?: string
  /** edge-tts 语速，如 '+10%' */
  rate?: string
  /** edge-tts 音调，如 '+8Hz' */
  pitch?: string
  /** Piper 合成参数 */
  piperSpeed?: number
  piperPitch?: number
  piperModel?: string
  /** 情感标签（用于自动映射参数） */
  emotion?: VoiceStyle | string
}

/** 单句合成结果 */
export interface SentenceSynthesisResult {
  /** 句子文本 */
  sentence: string
  /** 是否成功 */
  success: boolean
  /** 音频文件路径（成功时） */
  audioFile?: string
  /** 错误信息（失败时） */
  error?: string
  /** 合成耗时（毫秒） */
  durationMs: number
  /** 使用的引擎 */
  engine: string
}

/** 流式合成整体结果 */
export interface StreamingResult {
  /** 总句子数 */
  totalSentences: number
  /** 成功句数 */
  successCount: number
  /** 失败句数 */
  failCount: number
  /** 每句的合成结果 */
  sentences: SentenceSynthesisResult[]
  /** 总耗时（毫秒） */
  totalDurationMs: number
}

// ══════════════════════════════════════════
//  句子拆分 / 文本处理
// ══════════════════════════════════════════

/** 中文/通用句子结束标点 */
const SENTENCE_BREAKERS = /([。！？\n\r!?]+)/

/**
 * 将文本按句拆分。
 * 保留分隔符在前一句末尾。
 */
function splitSentences(text: string): string[] {
  const parts = text.split(SENTENCE_BREAKERS)
  const sentences: string[] = []
  let buffer = ''

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    // 分隔符匹配到了
    if (i > 0 && SENTENCE_BREAKERS.test(part)) {
      buffer += part
      const trimmed = buffer.trim()
      if (trimmed) {
        sentences.push(trimmed)
      }
      buffer = ''
    } else {
      buffer += part
    }
  }

  // 处理最后一段（无句号结尾的残余文本）
  const remaining = buffer.trim()
  if (remaining) {
    sentences.push(remaining)
  }

  // 过滤太短的句子（纯标点或语气词）
  return sentences.filter((s) => s.length >= 2)
}

// ══════════════════════════════════════════
//  引擎合成
// ══════════════════════════════════════════

/** 获取临时文件路径 */
function getTempFile(ext = '.wav'): string {
  return join(tmpdir(), `akemi-tts-chunk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`)
}

/** 发送音频文件到渲染进程播放 */
function sendAudioToRenderer(filePath: string): void {
  try {
    const wins = BrowserWindow.getAllWindows()
    for (const win of wins) {
      win.webContents.send('tts:play_audio', filePath)
    }
  } catch (err) {
    log('WARN', 'streaming_send_audio_failed', { error: String(err) })
  }
}

/** 延迟清理临时文件 */
function scheduleCleanup(filePath: string, delayMs = 10000): void {
  setTimeout(() => {
    try {
      unlinkSync(filePath)
    } catch {
      // 文件可能已被清理
    }
  }, delayMs)
}

// ══════════════════════════════════════════
//  StreamingAudioBuffer
// ══════════════════════════════════════════

export class StreamingAudioBuffer {
  /**
   * 执行流式合成与播放。
   *
   * 将长文本按句拆分，逐句合成音频并立即发送到渲染进程播放。
   * 支持 Piper 本地引擎和 Edge TTS 云端引擎的动态路由。
   *
   * @param text 要合成的文本
   * @param config 流式合成配置
   * @returns 流式合成结果统计
   */
  async stream(text: string, config?: Partial<StreamingConfig>): Promise<StreamingResult> {
    const t0 = Date.now()
    const cfg: StreamingConfig = {
      engine: config?.engine ?? 'auto',
      enabled: config?.enabled ?? true,
      voice: config?.voice,
      rate: config?.rate,
      pitch: config?.pitch,
      piperSpeed: config?.piperSpeed,
      piperPitch: config?.piperPitch,
      piperModel: config?.piperModel,
      emotion: config?.emotion,
    }

    // 1. 清理文本
    const clean = cleanTTS(text)
    if (!clean || clean.length < 2) {
      return {
        totalSentences: 0,
        successCount: 0,
        failCount: 0,
        sentences: [],
        totalDurationMs: Date.now() - t0,
      }
    }

    // 2. 拆分句子
    const sentences = splitSentences(clean)
    if (sentences.length === 0) {
      return {
        totalSentences: 0,
        successCount: 0,
        failCount: 0,
        sentences: [],
        totalDurationMs: Date.now() - t0,
      }
    }

    log('INFO', 'streaming_start', {
      total_chars: clean.length,
      sentences: sentences.length,
      engine: cfg.engine,
      streaming: cfg.enabled,
      emotion: cfg.emotion ?? '(none)',
      first_sentence: sentences[0].slice(0, 40),
    })

    // 3. 逐句合成
    const results: SentenceSynthesisResult[] = []

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i]
      const result = await this.synthesizeSentence(sentence, cfg)
      results.push(result)

      // 合成成功 → 发送到渲染进程播放
      if (result.success && result.audioFile) {
        sendAudioToRenderer(result.audioFile)
        scheduleCleanup(result.audioFile)
      }

      log('INFO', 'streaming_sentence_done', {
        index: i + 1,
        total: sentences.length,
        chars: sentence.length,
        success: result.success,
        engine: result.engine,
        durationMs: result.durationMs,
      })
    }

    // 4. 统计汇总
    const successCount = results.filter((r) => r.success).length
    const failCount = results.filter((r) => !r.success).length

    log('INFO', 'streaming_done', {
      sentences: results.length,
      success: successCount,
      fail: failCount,
      totalDurationMs: Date.now() - t0,
    })

    return {
      totalSentences: results.length,
      successCount,
      failCount,
      sentences: results,
      totalDurationMs: Date.now() - t0,
    }
  }

  // ══════════════════════════════════════════
  //  非流式批量合成（一次性合成全部文本）
  // ══════════════════════════════════════════

  /**
   * 非流式合成：将所有文本一次性合成。
   *
   * 适用于短文本或不需要流式播放的场景。
   * 使用 TtsRouter 动态选择引擎。
   *
   * @param text 要合成的文本
   * @param config 合成配置
   * @returns 合成的音频文件路径（成功时），或空字符串
   */
  async synthesizeAll(text: string, config?: Partial<StreamingConfig>): Promise<string> {
    const clean = cleanTTS(text)
    if (!clean || clean.length < 2) return ''

    const outputFile = getTempFile()
    const cfg: StreamingConfig = {
      engine: config?.engine ?? 'auto',
      enabled: false,
      voice: config?.voice,
      rate: config?.rate,
      pitch: config?.pitch,
      piperSpeed: config?.piperSpeed,
      piperPitch: config?.piperPitch,
      piperModel: config?.piperModel,
      emotion: config?.emotion,
    }

    // 获取情感参数（如果有 emotion 标签）
    const emotionParams = this.resolveEmotion(cfg.emotion)

    // 决定引擎
    const useLocal = await this.decideEngine(cfg.engine, 'balanced')

    try {
      if (useLocal) {
        // Piper 本地合成
        const model = cfg.piperModel ?? 'zh_CN-huayan-medium'
        const speed = cfg.piperSpeed ?? 1.0
        const pitch = cfg.piperPitch ?? 1.0
        const result = await piperOrchestrator.synthesize({
          text: clean,
          model,
          speed,
          pitch,
        })
        if (result.success && result.audioFile) {
          await fsp.copyFile(result.audioFile, outputFile)
          scheduleCleanup(result.audioFile)
          return outputFile
        }
        throw new Error(result.error || 'Piper synthesis failed')
      } else {
        // 云端 Edge TTS
        const voice = cfg.voice ?? emotionParams?.voice ?? 'zh-CN-XiaoxiaoNeural'
        const rate = cfg.rate ?? emotionParams?.rate ?? '+10%'
        const pitchCfg = cfg.pitch ?? emotionParams?.pitch ?? '+8Hz'

        await new Promise<void>((resolve, reject) => {
          const proc = execFile(
            'edge-tts',
            [
              '--voice', voice,
              '--text', clean,
              '--write-media', outputFile,
              '--rate', rate,
              '--pitch', pitchCfg,
            ],
            { timeout: 30000, windowsHide: true },
            (err) => {
              if (err) reject(err)
              else resolve()
            },
          )
        })

        // 验证文件生成
        await fsp.access(outputFile)
        return outputFile
      }
    } catch (err) {
      log('WARN', 'streaming_synthesize_all_failed', {
        text_len: clean.length,
        useLocal,
        error: String(err),
      })
      // 清理失败文件
      try { unlinkSync(outputFile) } catch { /* ignore */ }
      return ''
    }
  }

  // ══════════════════════════════════════════
  //  内部：单句合成
  // ══════════════════════════════════════════

  /**
   * 合成单句音频。
   *
   * 根据配置选择引擎（auto/cloud/local）：
   * - auto: 通过 TtsRouter 动态决策
   * - cloud: 强制 Edge TTS
   * - local: 强制 Piper
   */
  private async synthesizeSentence(
    sentence: string,
    cfg: StreamingConfig,
  ): Promise<SentenceSynthesisResult> {
    const t0 = Date.now()

    // 解析情感参数
    const emotionParams = this.resolveEmotion(cfg.emotion)

    // 决策引擎
    const useLocal = await this.decideEngine(cfg.engine, 'balanced')

    try {
      if (useLocal) {
        return await this.synthesizeWithPiper(sentence, cfg, emotionParams, t0)
      } else {
        return await this.synthesizeWithEdge(sentence, cfg, emotionParams, t0)
      }
    } catch (err) {
      return {
        sentence,
        success: false,
        error: String(err),
        durationMs: Date.now() - t0,
        engine: useLocal ? 'piper' : 'edge-tts',
      }
    }
  }

  /** 使用 Piper 本地引擎合成单句 */
  private async synthesizeWithPiper(
    sentence: string,
    cfg: StreamingConfig,
    emotionParams: EmotionTtsParams | null,
    t0: number,
  ): Promise<SentenceSynthesisResult> {
    const model = cfg.piperModel ?? 'zh_CN-huayan-medium'
    const speed = cfg.piperSpeed ?? 1.0
    const pitch = cfg.piperPitch ?? 1.0

    const result = await piperOrchestrator.synthesize({
      text: sentence,
      model,
      speed,
      pitch,
    })

    if (result.success && result.audioFile) {
      return {
        sentence,
        success: true,
        audioFile: result.audioFile,
        durationMs: Date.now() - t0,
        engine: `piper:${result.model}`,
      }
    }

    // Piper 失败时尝试回退到 Edge TTS
    log('WARN', 'streaming_piper_fallback_to_edge', {
      error: result.error,
      sentence: sentence.slice(0, 40),
    })
    return this.synthesizeWithEdge(sentence, cfg, emotionParams, t0)
  }

  /** 使用 Edge TTS 云端引擎合成单句 */
  private async synthesizeWithEdge(
    sentence: string,
    cfg: StreamingConfig,
    emotionParams: EmotionTtsParams | null,
    t0: number,
  ): Promise<SentenceSynthesisResult> {
    const outputFile = getTempFile('.mp3')
    const voice = cfg.voice ?? emotionParams?.voice ?? 'zh-CN-XiaoxiaoNeural'
    const rate = cfg.rate ?? emotionParams?.rate ?? '+10%'
    const pitch = cfg.pitch ?? emotionParams?.pitch ?? '+8Hz'

    await new Promise<void>((resolve, reject) => {
      const proc = execFile(
        'edge-tts',
        [
          '--voice', voice,
          '--text', sentence,
          '--write-media', outputFile,
          '--rate', rate,
          '--pitch', pitch,
        ],
        { timeout: 30000, windowsHide: true },
        (err) => {
          if (err) reject(err)
          else resolve()
        },
      )
    })

    // 验证文件
    await fsp.access(outputFile)

    return {
      sentence,
      success: true,
      audioFile: outputFile,
      durationMs: Date.now() - t0,
      engine: `edge-tts:${voice}`,
    }
  }

  // ══════════════════════════════════════════
  //  引擎决策 + 情感解析
  // ══════════════════════════════════════════

  /**
   * 决定使用本地还是云端引擎。
   *
   * @param enginePreference 用户指定的引擎偏好
   * @param priority 路由优先级（balanced/quality/latency）
   */
  private async decideEngine(
    enginePreference: 'auto' | 'cloud' | 'local',
    priority: 'balanced' | 'quality' | 'latency' = 'balanced',
  ): Promise<boolean> {
    if (enginePreference === 'local') return true
    if (enginePreference === 'cloud') return false

    // auto 模式：通过 TtsRouter 动态决策
    const qualityWeight = priority === 'quality' ? 0.8 : priority === 'latency' ? 0.3 : 0.6
    const latencyWeight = priority === 'latency' ? 0.7 : priority === 'quality' ? 0.2 : 0.4

    const decision = await ttsRouter.decide({
      qualityWeight,
      latencyWeight,
    })

    return decision.engine === 'local'
  }

  /**
   * 解析情感标签为 TTS 参数。
   *
   * 支持 VoiceStyle 标签（cheerful/serious/gentle/neutral/warm/energetic/calm/playful）
   * 通过 VoiceStyleMap 映射到具体的 voice/rate/pitch 参数。
   */
  private resolveEmotion(emotion?: string): EmotionTtsParams | null {
    if (!emotion) return null

    const validStyles = ['cheerful', 'serious', 'gentle', 'neutral', 'warm', 'energetic', 'calm', 'playful']
    const style = emotion.toLowerCase() as VoiceStyle

    if (validStyles.includes(style)) {
      return voiceStyleMap.getParams(style)
    }

    // 尝试中文标签映射
    const zhMap: Record<string, VoiceStyle> = {
      '欢快': 'cheerful',
      '严肃': 'serious',
      '温柔': 'gentle',
      '中性': 'neutral',
      '温暖': 'warm',
      '活力': 'energetic',
      '沉稳': 'calm',
      '俏皮': 'playful',
      开心: 'cheerful',
      高兴: 'cheerful',
      生气: 'serious',
      难过: 'gentle',
      平静: 'calm',
      热情: 'warm',
      活泼: 'energetic',
    }

    const mappedStyle = zhMap[emotion]
    if (mappedStyle) {
      return voiceStyleMap.getParams(mappedStyle)
    }

    return null
  }
}

// ══════════════════════════════════════════
//  单例
// ══════════════════════════════════════════

/** 全局单例 */
export const streamingAudioBuffer = new StreamingAudioBuffer()
