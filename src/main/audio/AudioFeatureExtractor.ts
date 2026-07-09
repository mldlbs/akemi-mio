/**
 * AudioFeatureExtractor — 从 PCM 原始音频提取韵律特征
 *
 * 使用纯数学方法（无外部依赖）提取：
 * - Energy: 基于 RMS 逐帧能量
 * - Pitch: 基于自相关法 (ACF) 的基频估计
 * - Tempo/SpeechRate: 基于 VAD 的语速估算
 * - Zero-Crossing Rate: 过零率
 *
 * 所有方法均基于时域分析，无需 FFT 或外部 DSP 库。
 */

import type { AudioFeatures } from './types'

// ══════════════════════════════════════════
//  常量
// ══════════════════════════════════════════

/** 分析帧大小（采样点），16kHz 下约 32ms */
const FRAME_SIZE = 512
/** 帧移（采样点），16kHz 下约 16ms */
const FRAME_HOP = 256
/** 采样率 */
const SAMPLE_RATE = 16000
/** 最小基频 (Hz) — 对应约 73 Hz */
const MIN_PITCH_HZ = 60
/** 最大基频 (Hz) — 对应约 500 Hz */
const MAX_PITCH_HZ = 500
/** 语音活动检测 (VAD) 能量阈值 */
const VAD_THRESHOLD = 0.015
/** 最小语音段长度（帧数），过滤突发噪声 */
const MIN_VOICE_SEGMENT_FRAMES = 3

// ══════════════════════════════════════════
//  帧分析结果
// ══════════════════════════════════════════

interface FrameResult {
  rms: number
  zcr: number
  pitch: number
  isVoice: boolean
}

// ══════════════════════════════════════════
//  特征提取器
// ══════════════════════════════════════════

export class AudioFeatureExtractor {
  /**
   * 从 16kHz Int16 PCM 数组提取音频特征。
   *
   * @param pcmInt16  Int16 PCM 数据（16kHz 单声道）
   * @returns AudioFeatures
   */
  extract(pcmInt16: Int16Array): AudioFeatures {
    // 转为 Float32 [-1, 1]
    const float32 = new Float32Array(pcmInt16.length)
    for (let i = 0; i < pcmInt16.length; i++) {
      float32[i] = pcmInt16[i] / 32768
    }

    return this.extractFromFloat32(float32)
  }

  /**
   * 从 Float32 PCM 数组（归一化 [-1, 1]）提取音频特征。
   * 用于直接接收 AudioContext 的 Float32 数据。
   */
  extractFromFloat32(samples: Float32Array): AudioFeatures {
    const durationSec = samples.length / SAMPLE_RATE
    if (samples.length < FRAME_SIZE) {
      return this.emptyResult(durationSec)
    }

    // 1. 逐帧分析
    const frames = this.analyzeFrames(samples)

    // 2. 从帧结果计算整体特征
    return this.computeAggregateFeatures(frames, durationSec)
  }

  // ── 私有方法 ──

  /** 将音频切帧并逐帧分析 */
  private analyzeFrames(samples: Float32Array): FrameResult[] {
    const frames: FrameResult[] = []

    for (let offset = 0; offset + FRAME_SIZE <= samples.length; offset += FRAME_HOP) {
      const frame = samples.slice(offset, offset + FRAME_SIZE)
      frames.push(this.analyzeFrame(frame))
    }

    return frames
  }

  /** 分析单帧 */
  private analyzeFrame(frame: Float32Array): FrameResult {
    const rms = this.computeRms(frame)
    const zcr = this.computeZcr(frame)
    const pitch = this.estimatePitch(frame)
    const isVoice = rms > VAD_THRESHOLD

    return { rms, zcr, pitch, isVoice }
  }

  /** 计算 RMS 能量 */
  private computeRms(frame: Float32Array): number {
    let sumSq = 0
    for (let i = 0; i < frame.length; i++) {
      sumSq += frame[i] * frame[i]
    }
    return Math.sqrt(sumSq / frame.length)
  }

  /** 计算过零率 (Zero-Crossing Rate) */
  private computeZcr(frame: Float32Array): number {
    let crossings = 0
    for (let i = 1; i < frame.length; i++) {
      if ((frame[i - 1] >= 0 && frame[i] < 0) || (frame[i - 1] < 0 && frame[i] >= 0)) {
        crossings++
      }
    }
    return crossings / frame.length
  }

  /**
   * 基于自相关法 (Auto-Correlation Function) 估计基频。
   * ACF 通过滑动窗口自相关计算，取峰值对应延迟作为周期。
   */
  private estimatePitch(frame: Float32Array): number {
    const rms = this.computeRms(frame)
    if (rms < VAD_THRESHOLD) return 0 // 无声帧不估计音高

    const minLag = Math.ceil(SAMPLE_RATE / MAX_PITCH_HZ)
    const maxLag = Math.floor(SAMPLE_RATE / MIN_PITCH_HZ)

    if (minLag >= maxLag || minLag >= frame.length) return 0

    const maxValidLag = Math.min(maxLag, frame.length - 1)
    if (minLag >= maxValidLag) return 0

    // 计算 ACF
    let bestLag = minLag
    let bestCorr = 0

    for (let lag = minLag; lag <= maxValidLag; lag++) {
      let corr = 0
      let normA = 0
      let normB = 0

      for (let i = 0; i < frame.length - lag; i++) {
        corr += frame[i] * frame[i + lag]
        normA += frame[i] * frame[i]
        normB += frame[i + lag] * frame[i + lag]
      }

      const denominator = Math.sqrt(normA * normB)
      if (denominator > 1e-10) {
        corr /= denominator
      }

      if (corr > bestCorr) {
        bestCorr = corr
        bestLag = lag
      }
    }

    // 自相关阈值：低于此值视为无可靠基频
    if (bestCorr < 0.3) return 0

    // 抛物线插值提高精度
    const refinedLag = this.parabolicInterpolation(frame, bestLag)

    return SAMPLE_RATE / refinedLag
  }

  /** 对 ACF 峰值做抛物线插值，提高基频估计精度 */
  private parabolicInterpolation(frame: Float32Array, lag: number): number {
    if (lag <= 0 || lag >= frame.length - 1) return lag

    const y1 = this.acfValue(frame, lag - 1)
    const y2 = this.acfValue(frame, lag)
    const y3 = this.acfValue(frame, lag + 1)

    const denom = y1 - 2 * y2 + y3
    if (Math.abs(denom) < 1e-12) return lag

    const offset = (y1 - y3) / (2 * denom)
    const clampedOffset = Math.max(-0.5, Math.min(0.5, offset))

    return lag + clampedOffset
  }

  /** 计算某延迟下的自相关值 */
  private acfValue(frame: Float32Array, lag: number): number {
    if (lag <= 0 || lag >= frame.length) return 0

    let sum = 0
    for (let i = 0; i < frame.length - lag; i++) {
      sum += frame[i] * frame[i + lag]
    }
    return sum / (frame.length - lag)
  }

  /** 从帧结果计算聚合特征 */
  private computeAggregateFeatures(frames: FrameResult[], durationSec: number): AudioFeatures {
    const voiceFrames = frames.filter(f => f.isVoice)
    const voiceFrameCount = voiceFrames.length
    const totalFrames = frames.length

    // ── 能量特征 ──
    const energy = voiceFrameCount > 0
      ? voiceFrames.reduce((s, f) => s + f.rms, 0) / voiceFrameCount
      : 0
    const energyVariance = voiceFrameCount > 0
      ? this.variance(voiceFrames.map(f => f.rms))
      : 0

    // 能量变化趋势：前1/3 vs 后1/3 均值差
    const thirdLen = Math.max(1, Math.floor(frames.length / 3))
    const firstThird = frames.slice(0, thirdLen)
    const lastThird = frames.slice(-thirdLen)
    const firstEnergy = firstThird.reduce((s, f) => s + f.rms, 0) / firstThird.length
    const lastEnergy = lastThird.reduce((s, f) => s + f.rms, 0) / lastThird.length
    const energyTrend = Math.max(-1, Math.min(1, (lastEnergy - firstEnergy) * 5))

    // ── 基频特征 ──
    const pitchValues = voiceFrames.filter(f => f.pitch > 0).map(f => f.pitch)
    const pitchHz = pitchValues.length > 0
      ? pitchValues.reduce((s, v) => s + v, 0) / pitchValues.length
      : 0
    const pitchVariance = pitchValues.length > 1
      ? this.variance(pitchValues)
      : 0
    const pitchRange = pitchValues.length > 1
      ? Math.max(...pitchValues) - Math.min(...pitchValues)
      : 0

    // ── 过零率 ──
    const zcrValues = frames.map(f => f.zcr)
    const avgZeroCrossingRate = zcrValues.length > 0
      ? zcrValues.reduce((s, v) => s + v, 0) / zcrValues.length
      : 0
    const zcrVariance = this.variance(zcrValues)

    // ── 语速与静音特征 ──
    const silenceFrames = totalFrames - voiceFrameCount
    const silenceRatio = totalFrames > 0 ? silenceFrames / totalFrames : 1

    // 语音段检测（连续有声帧组成一个段）
    const segments = this.detectVoiceSegments(frames)
    const voiceSegmentCount = segments.length

    // 语速估计：有效语音帧总数 / 总时长（帧/秒）
    const speechRate = voiceFrameCount / Math.max(1, durationSec)

    return {
      energy: Math.min(1, energy * 8), // 放大到更有区分度的范围
      energyVariance: Math.min(1, energyVariance * 20),
      energyTrend,
      pitchHz: Math.round(pitchHz),
      pitchVariance: Math.round(pitchVariance),
      pitchRange: Math.round(pitchRange),
      avgZeroCrossingRate: Math.min(0.5, avgZeroCrossingRate),
      zcrVariance: Math.min(0.1, zcrVariance),
      speechRate: Math.min(20, speechRate),
      silenceRatio: Math.min(1, silenceRatio),
      voiceSegmentCount,
      durationSec,
    }
  }

  /** 检测连续语音段 */
  private detectVoiceSegments(frames: FrameResult[]): Array<{ start: number; end: number }> {
    const segments: Array<{ start: number; end: number }> = []
    let inSegment = false
    let start = 0
    let silentCount = 0

    for (let i = 0; i < frames.length; i++) {
      if (frames[i].isVoice) {
        if (!inSegment) {
          inSegment = true
          start = i
          silentCount = 0
        }
      } else {
        if (inSegment) {
          silentCount++
          // 连续无声超过阈值，认为段结束
          if (silentCount >= MIN_VOICE_SEGMENT_FRAMES) {
            if (i - start >= MIN_VOICE_SEGMENT_FRAMES) {
              segments.push({ start, end: i - silentCount })
            }
            inSegment = false
            silentCount = 0
          }
        }
      }
    }

    // 处理最后一段
    if (inSegment && frames.length - start >= MIN_VOICE_SEGMENT_FRAMES) {
      segments.push({ start, end: frames.length - 1 })
    }

    return segments
  }

  /** 计算方差 */
  private variance(values: number[]): number {
    if (values.length < 2) return 0
    const mean = values.reduce((s, v) => s + v, 0) / values.length
    return values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length
  }

  /** 返回空结果（音频过短） */
  private emptyResult(durationSec: number): AudioFeatures {
    return {
      energy: 0,
      energyVariance: 0,
      energyTrend: 0,
      pitchHz: 0,
      pitchVariance: 0,
      pitchRange: 0,
      avgZeroCrossingRate: 0,
      zcrVariance: 0,
      speechRate: 0,
      silenceRatio: 1,
      voiceSegmentCount: 0,
      durationSec,
    }
  }
}

/** 全局单例 */
export const audioFeatureExtractor = new AudioFeatureExtractor()
