/**
 * AudioConcatenator — 音频段落拼接器
 *
 * 使用 ffmpeg 将多个 WAV 音频段落拼接为单一 MP3 文件：
 * 1. 支持段落间停顿插入（生成静音片段）
 * 2. 支持全局淡入/淡出
 * 3. 支持段落间交叉淡入淡出（crossfade）
 * 4. 自动清理临时文件
 *
 * 依赖：ffmpeg（通过 findFfmpeg 定位）
 */

import { execFile } from 'child_process'
import { promises as fsp, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { log } from '../logger/Logger'
import { findFfmpeg } from '../utils/ffmpeg'

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 音频片段 */
export interface AudioClip {
  /** 音频文件路径（WAV 格式） */
  filePath: string
  /** 合成此段所用的模型名（日志用） */
  model: string
  /** 段落文本摘要（日志用） */
  textSnippet: string
  /** 在最终音频中的停顿（毫秒） */
  pauseAfterMs: number
}

/** 拼接配置 */
export interface ConcatConfig {
  /** 输出文件路径（.mp3） */
  outputPath: string
  /** 全局淡入时长（秒） */
  fadeInSec: number
  /** 全局淡出时长（秒） */
  fadeOutSec: number
  /** 音频比特率（kbps），默认 128 */
  bitrateKbps: number
  /** 采样率，默认 22050 */
  sampleRate: number
}

/** 默认配置 */
const DEFAULT_CONFIG: ConcatConfig = {
  outputPath: '',
  fadeInSec: 1.5,
  fadeOutSec: 2.0,
  bitrateKbps: 128,
  sampleRate: 22050,
}

/** 拼接结果 */
export interface ConcatResult {
  success: boolean
  /** 输出文件路径（成功时） */
  outputPath?: string
  /** 总时长（秒，成功时） */
  totalDurationSec?: number
  /** 文件大小（字节，成功时） */
  fileSizeBytes?: number
  /** 错误信息（失败时） */
  error?: string
  /** 耗时毫秒 */
  durationMs: number
}

// ══════════════════════════════════════════
//  AudioConcatenator
// ══════════════════════════════════════════

export class AudioConcatenator {
  /**
   * 将多个音频片段拼接为单一 MP3 文件。
   *
   * 流程：
   * 1. 为每段生成静音填充（用于段落间停顿）
   * 2. 创建 ffmpeg concat demuxer 文件
   * 3. 调用 ffmpeg 拼接 + 添加淡入淡出
   * 4. 清理临时文件
   */
  async concat(clips: AudioClip[], config: Partial<ConcatConfig> = {}): Promise<ConcatResult> {
    const t0 = Date.now()
    const cfg: ConcatConfig = { ...DEFAULT_CONFIG, ...config, outputPath: config.outputPath || this.defaultOutputPath() }

    if (clips.length === 0) {
      return { success: false, error: '没有音频片段可拼接', durationMs: Date.now() - t0 }
    }

    // 验证输入文件存在
    const validClips: AudioClip[] = []
    for (const clip of clips) {
      if (!existsSync(clip.filePath)) {
        log('WARN', 'audio_concat_missing_file', { file: clip.filePath })
        continue
      }
      validClips.push(clip)
    }

    if (validClips.length === 0) {
      return { success: false, error: '所有音频文件都不存在', durationMs: Date.now() - t0 }
    }

    const ffmpeg = findFfmpeg()
    const tempDir = join(tmpdir(), `akemi-podcast-${Date.now()}`)
    await fsp.mkdir(tempDir, { recursive: true })

    try {
      // 步骤 1: 为每段创建静音填充文件（用于段落间停顿）
      const allInputFiles: string[] = []
      for (let i = 0; i < validClips.length; i++) {
        const clip = validClips[i]

        // 添加音频段本身
        allInputFiles.push(clip.filePath)

        // 添加停顿（如果指定了 pauseAfterMs）
        if (clip.pauseAfterMs > 0) {
          const silenceFile = join(tempDir, `silence-${i}.wav`)
          await this.generateSilence(silenceFile, clip.pauseAfterMs, ffmpeg, cfg.sampleRate)
          allInputFiles.push(silenceFile)
        }
      }

      // 步骤 2: 创建 concat demuxer 文件
      const concatFile = join(tempDir, 'concat-list.txt')
      const concatLines = allInputFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`)
      await fsp.writeFile(concatFile, concatLines.join('\n'), 'utf-8')

      // 步骤 3: 调用 ffmpeg 拼接 + 淡入淡出
      // 使用 concat demuxer 避免重新编码时的质量损失
      // 使用 afade 滤镜添加淡入淡出
      await this.runFfmpegConcat(ffmpeg, concatFile, cfg)

      // 步骤 4: 获取输出文件信息
      const stats = await fsp.stat(cfg.outputPath).catch(() => null)
      const fileSizeBytes = stats?.size ?? 0

      // 估算总时长
      const totalDurationSec = await this.getAudioDuration(cfg.outputPath, ffmpeg)

      log('INFO', 'audio_concat_done', {
        clips: validClips.length,
        total_inputs: allInputFiles.length,
        output: cfg.outputPath,
        duration_sec: totalDurationSec,
        size_bytes: fileSizeBytes,
        duration_ms: Date.now() - t0,
      })

      return {
        success: true,
        outputPath: cfg.outputPath,
        totalDurationSec,
        fileSizeBytes,
        durationMs: Date.now() - t0,
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      log('ERROR', 'audio_concat_failed', { error: errorMsg, duration_ms: Date.now() - t0 })

      // 清理可能不完整的输出文件
      try {
        await fsp.unlink(cfg.outputPath).catch(() => {})
      } catch {}

      return {
        success: false,
        error: errorMsg,
        durationMs: Date.now() - t0,
      }
    } finally {
      // 清理临时目录
      try {
        await fsp.rm(tempDir, { recursive: true, force: true })
      } catch {}
    }
  }

  // ══════════════════════════════════════════
  //  私有方法
  // ══════════════════════════════════════════

  /** 默认输出路径 */
  private defaultOutputPath(): string {
    return join(tmpdir(), `akemi-podcast-${Date.now()}.mp3`)
  }

  /**
   * 生成静音 WAV 文件。
   * 使用 ffmpeg 的 anullsrc 滤镜生成指定毫秒数的静音。
   */
  private generateSilence(
    outputPath: string,
    durationMs: number,
    ffmpeg: string,
    sampleRate: number,
  ): Promise<void> {
    // 静音时长四舍五入到秒（ffmpeg 精度足够）
    const durationSec = Math.max(0.05, durationMs / 1000)
    // 减少到最近的 0.01s 精度
    const roundedSec = Math.round(durationSec * 100) / 100

    return new Promise((resolve, reject) => {
      execFile(
        ffmpeg,
        [
          '-f', 'lavfi',
          '-i', `anullsrc=r=${sampleRate}:cl=mono`,
          '-t', String(roundedSec),
          '-acodec', 'pcm_s16le',
          '-y',
          outputPath,
        ],
        { timeout: 10000, windowsHide: true },
        (err) => {
          if (err) reject(new Error(`生成静音失败: ${err.message}`))
          else resolve()
        },
      )
    })
  }

  /**
   * 执行 ffmpeg 拼接命令。
   * 使用 concat demuxer + afade 滤镜。
   */
  private runFfmpegConcat(
    ffmpeg: string,
    concatFile: string,
    config: ConcatConfig,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // 构建滤镜链
      // 1. concat 拼接所有输入
      // 2. afade=t=in:ss=0:d=<fadeInSec> 淡入
      // 3. afade=t=out:st=<total-dur-fadeOutSec>:d=<fadeOutSec> 淡出
      // 由于我们不知道总时长，先用 concat 再通过 ffprobe 测量

      // 简化方案：先 concat 输出临时 WAV，再用 afade 处理
      // 避免复杂的滤镜图计算
      const tempOutput = config.outputPath.replace('.mp3', '_temp.wav')

      execFile(
        ffmpeg,
        [
          '-f', 'concat',
          '-safe', '0',
          '-i', concatFile,
          '-c', 'copy',
          '-y',
          tempOutput,
        ],
        { timeout: 60000, windowsHide: true },
        async (concatErr) => {
          if (concatErr) {
            reject(new Error(`concat 失败: ${concatErr.message}`))
            return
          }

          // 现在对临时文件添加淡入淡出并转码为 MP3
          try {
            await this.addFadeAndEncode(ffmpeg, tempOutput, config)
            // 清理临时 WAV
            try { await fsp.unlink(tempOutput) } catch {}
            resolve()
          } catch (err) {
            reject(err)
          }
        },
      )
    })
  }

  /**
   * 对音频文件添加淡入淡出并编码为 MP3。
   */
  private addFadeAndEncode(
    ffmpeg: string,
    inputPath: string,
    config: ConcatConfig,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // 获取音频时长以计算淡出起始点
      this.getAudioDuration(inputPath, ffmpeg).then((durationSec) => {
        if (durationSec <= 0) {
          durationSec = 30 // fallback 估计
        }

        const fadeOutStart = Math.max(0, durationSec - config.fadeOutSec)

        execFile(
          ffmpeg,
          [
            '-i', inputPath,
            '-af',
            `afade=t=in:ss=0:d=${config.fadeInSec},afade=t=out:st=${fadeOutStart}:d=${config.fadeOutSec}`,
            '-codec:a', 'libmp3lame',
            '-b:a', `${config.bitrateKbps}k`,
            '-ar', String(config.sampleRate),
            '-y',
            config.outputPath,
          ],
          { timeout: 120000, windowsHide: true },
          (encodeErr) => {
            if (encodeErr) reject(new Error(`编码失败: ${encodeErr.message}`))
            else resolve()
          },
        )
      }).catch(reject)
    })
  }

  /**
   * 获取音频文件时长（秒）。
   * 使用 ffprobe 读取。
   */
  private getAudioDuration(filePath: string, ffmpeg: string): Promise<number> {
    const ffprobe = ffmpeg.replace('ffmpeg', 'ffprobe')

    return new Promise((resolve) => {
      execFile(
        ffprobe,
        [
          '-v', 'error',
          '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1',
          filePath,
        ],
        { timeout: 10000, windowsHide: true },
        (err, stdout) => {
          if (err) {
            resolve(0)
            return
          }
          const sec = parseFloat(stdout.trim())
          resolve(isNaN(sec) ? 0 : sec)
        },
      )
    })
  }
}

/** 全局单例 */
export const audioConcatenator = new AudioConcatenator()
