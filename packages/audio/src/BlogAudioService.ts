/**
 * BlogAudioService — 博客音频播客生成服务
 *
 * 将博客 Markdown 内容合成为音频播客（MP3 格式）。
 *
 * 流程：
 * 1. 将 Markdown 拆分为语义段落（MarkdownSegmenter）
 * 2. 为每段匹配合适的语音模型（ContentVoiceMapper）
 * 3. 通过 PiperOrchestrator 逐段合成语音（WAV）
 * 4. 拼接音频 + 添加淡入淡出（AudioConcatenator）
 * 5. 输出 MP3 文件
 *
 * 设计：
 * - 复用 PiperOrchestrator 的串行队列，避免并发 Piper 进程争抢
 * - 所有临时文件自动清理
 * - 支持指定输出路径、语速覆盖、语言
 */

import { promises as fsp } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { log } from '@akemi-mio/core/logger/Logger'
import { piperOrchestrator } from './PiperOrchestrator'
import { markdownSegmenter, type TtsSegment } from './MarkdownSegmenter'
import { contentVoiceMapper, type VoiceAssignment } from './ContentVoiceMapper'
import { audioConcatenator, type AudioClip } from './AudioConcatenator'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 播客生成选项 */
export interface PodcastOptions {
  /** 输出文件路径（默认为临时目录） */
  outputPath?: string
  /** 全局语速覆盖（0.5-2.0），不指定则使用模型推荐值 */
  speedOverride?: number
  /** 全局音调覆盖（0.5-2.0） */
  pitchOverride?: number
  /** 淡入时长（秒），默认 1.5 */
  fadeInSec?: number
  /** 淡出时长（秒），默认 2.0 */
  fadeOutSec?: number
  /** 比特率（kbps），默认 128 */
  bitrateKbps?: number
}

/** 播客段落实时状态 */
interface SegmentResult {
  segment: TtsSegment
  voice: VoiceAssignment
  audioFile?: string
  success: boolean
  error?: string
}

/** 播客生成结果 */
export interface PodcastResult {
  success: boolean
  /** 输出文件路径（成功时） */
  outputPath?: string
  /** 总时长（秒，成功时） */
  totalDurationSec?: number
  /** 文件大小（字节，成功时） */
  fileSizeBytes?: number
  /** 总段落数 */
  totalSegments: number
  /** 成功合成数 */
  successSegments: number
  /** 失败段落数 */
  failedSegments: number
  /** 错误信息（失败时） */
  error?: string
  /** 文章标题 */
  title: string
  /** 各段落的处理结果明细 */
  segmentDetails?: Array<{
    index: number
    model: string
    textSnippet: string
    success: boolean
    error?: string
  }>
  /** 耗时毫秒 */
  durationMs: number
}

// ══════════════════════════════════════════
//  BlogAudioService
// ══════════════════════════════════════════

export class BlogAudioService {
  /**
   * 生成博客音频播客。
   *
   * @param markdown 博客 Markdown 原文
   * @param options  生成选项
   * @returns PodcastResult
   */
  async generatePodcast(markdown: string, options: PodcastOptions = {}): Promise<PodcastResult> {
    const t0 = Date.now()
    log('INFO', 'blog_podcast_start', {
      markdown_len: markdown.length,
      output: options.outputPath || '(tmp)',
    })

    try {
      if (!markdown || markdown.trim().length < 10) {
        return {
          success: false,
          error: 'Markdown 内容太短（至少 10 个字符）',
          totalSegments: 0,
          successSegments: 0,
          failedSegments: 0,
          title: '',
          durationMs: Date.now() - t0,
        }
      }

      // ── 步骤 1: 拆分段落 ──
      const { segments, metadata } = markdownSegmenter.segment(markdown)
      log('INFO', 'blog_podcast_segmented', {
        segments: segments.length,
        title: metadata.title,
        estimated_duration: metadata.estimatedDurationSec,
      })

      if (segments.length === 0) {
        return {
          success: false,
          error: '无法从 Markdown 中提取有效段落',
          totalSegments: 0,
          successSegments: 0,
          failedSegments: 0,
          title: metadata.title,
          durationMs: Date.now() - t0,
        }
      }

      // ── 步骤 2: 分配语音模型 ──
      const voiceAssignments = contentVoiceMapper.assignAll(segments)

      // ── 步骤 3: 逐段合成语音 ──
      const segmentResults = await this.synthesizeSegments(segments, voiceAssignments, options)

      const successResults = segmentResults.filter((r) => r.success && r.audioFile)

      if (successResults.length === 0) {
        return {
          success: false,
          error: '所有段落合成均失败',
          totalSegments: segments.length,
          successSegments: 0,
          failedSegments: segmentResults.length,
          title: metadata.title,
          segmentDetails: segmentResults.map((r) => ({
            index: r.segment.segmentIndex,
            model: r.voice.model,
            textSnippet: r.segment.text.slice(0, 60),
            success: r.success,
            error: r.error,
          })),
          durationMs: Date.now() - t0,
        }
      }

      // ── 步骤 4: 拼接音频 ──
      const outputPath = options.outputPath || join(tmpdir(), `akemi-podcast-${Date.now()}.mp3`)

      // 确保输出目录存在
      await fsp.mkdir(dirname(outputPath), { recursive: true }).catch(() => {})

      const clips: AudioClip[] = successResults.map((r) => ({
        filePath: r.audioFile!,
        model: r.voice.model,
        textSnippet: r.segment.text.slice(0, 60),
        pauseAfterMs: r.voice.pauseAfterMs,
      }))

      const concatResult = await audioConcatenator.concat(clips, {
        outputPath,
        fadeInSec: options.fadeInSec ?? 1.5,
        fadeOutSec: options.fadeOutSec ?? 2.0,
        bitrateKbps: options.bitrateKbps ?? 128,
      })

      if (!concatResult.success) {
        // 清理临时音频文件
        await this.cleanupTempFiles(successResults.map((r) => r.audioFile!))
        return {
          success: false,
          error: `音频拼接失败: ${concatResult.error}`,
          totalSegments: segments.length,
          successSegments: successResults.length,
          failedSegments: segmentResults.length - successResults.length,
          title: metadata.title,
          durationMs: Date.now() - t0,
        }
      }

      // ── 清理临时音频文件 ──
      // 将清理延迟一段时间，确保文件已使用完毕
      setTimeout(() => {
        this.cleanupTempFiles(successResults.map((r) => r.audioFile!))
      }, 5000)

      log('INFO', 'blog_podcast_done', {
        title: metadata.title,
        segments: segments.length,
        success: successResults.length,
        failed: segmentResults.length - successResults.length,
        duration_sec: concatResult.totalDurationSec,
        output: concatResult.outputPath,
        total_time_ms: Date.now() - t0,
      })

      return {
        success: true,
        outputPath: concatResult.outputPath,
        totalDurationSec: concatResult.totalDurationSec,
        fileSizeBytes: concatResult.fileSizeBytes,
        totalSegments: segments.length,
        successSegments: successResults.length,
        failedSegments: segmentResults.length - successResults.length,
        title: metadata.title,
        segmentDetails: segmentResults.map((r) => ({
          index: r.segment.segmentIndex,
          model: r.voice.model,
          textSnippet: r.segment.text.slice(0, 60),
          success: r.success,
          error: r.error,
        })),
        durationMs: Date.now() - t0,
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      log('ERROR', 'blog_podcast_error', { error: errorMsg, duration_ms: Date.now() - t0 })
      return {
        success: false,
        error: errorMsg,
        totalSegments: 0,
        successSegments: 0,
        failedSegments: 0,
        title: '',
        durationMs: Date.now() - t0,
      }
    }
  }

  // ══════════════════════════════════════════
  //  私有方法
  // ══════════════════════════════════════════

  /**
   * 逐段通过 PiperOrchestrator 合成语音。
   * 虽然 PiperOrchestrator 内置串行队列，这里仍然顺序提交以合理分配模型切换。
   */
  private async synthesizeSegments(
    segments: TtsSegment[],
    voiceAssignments: VoiceAssignment[],
    options: PodcastOptions,
  ): Promise<SegmentResult[]> {
    const results: SegmentResult[] = []

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]
      const voice = voiceAssignments[i]

      log('DEBUG', 'blog_podcast_synthesize_segment', {
        index: i,
        total: segments.length,
        model: voice.model,
        chars: segment.text.length,
        snippet: segment.text.slice(0, 40),
        reason: voice.reason,
      })

      // 应用全局语速/音调覆盖
      const speed = options.speedOverride ?? voice.speed
      const pitch = options.pitchOverride ?? voice.pitch

      try {
        const result = await piperOrchestrator.synthesize({
          text: segment.text,
          model: voice.model,
          speed,
          pitch,
        })

        if (result.success && result.audioFile) {
          results.push({
            segment,
            voice,
            audioFile: result.audioFile,
            success: true,
          })
        } else {
          log('WARN', 'blog_podcast_segment_failed', {
            index: i,
            model: voice.model,
            error: result.error,
          })
          results.push({
            segment,
            voice,
            success: false,
            error: result.error || '合成失败',
          })
        }
      } catch (err) {
        log('ERROR', 'blog_podcast_segment_error', {
          index: i,
          error: String(err),
        })
        results.push({
          segment,
          voice,
          success: false,
          error: String(err),
        })
      }
    }

    return results
  }

  /** 清理临时音频文件 */
  private async cleanupTempFiles(files: string[]): Promise<void> {
    for (const file of files) {
      try {
        await fsp.unlink(file)
      } catch {
        // 文件可能已被清理或正在使用
      }
    }
  }
}

/** 全局单例 */
export const blogAudioService = new BlogAudioService()
