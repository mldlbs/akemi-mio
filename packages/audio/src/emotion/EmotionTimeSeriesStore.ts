/**
 * EmotionTimeSeriesStore — 情感时间序列存储器
 *
 * 从 MemoryService 中提取情感时间序列数据，构建用户情绪演变路径。
 * 支持：
 *   1. 从 MemoryEntry 的 structuredData 中提取情感向量（valence/arousal）
 *   2. 按时间排序构造情感时间序列
 *   3. 分析情感趋势（上升/下降/波动）
 *   4. 为叙事引擎提供情感上下文
 *
 * 与 MemoryEmotionBridge 的关系：
 *   - MemoryEmotionBridge: 负责写入（每条用户消息分析 → 记录标签）
 *   - EmotionTimeSeriesStore: 负责读取（从标签 → 时间序列 → 叙事曲线）
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { MemoryService } from '@akemi-mio/intelligence-memory/MemoryService'
import type { MemoryEntry, MemoryEmotionTag } from '@akemi-mio/intelligence-memory/types'
import type { EmotionVector, EmotionTimeSeriesPoint } from '../types'

// ══════════════════════════════════════════
//  配置常量
// ══════════════════════════════════════════

/** 情感时间序列分析窗口：最近 N 条交互记录 */
const TIME_SERIES_WINDOW = 50

/** 情感向量默认值（无数据时的回退） */
const DEFAULT_VECTOR: EmotionVector = { valence: 0, arousal: 0 }

// ══════════════════════════════════════════
//  EmotionTimeSeriesStore
// ══════════════════════════════════════════

export class EmotionTimeSeriesStore {
  /**
   * 从 MemoryService 构建情感时间序列。
   *
   * 遍历最近的 MemoryEntry，提取 emotion 标签并转换为时间序列点，
   * 按时间升序排列（最早的在前）。
   *
   * @param memoryService MemoryService 实例
   * @param windowSize 最多提取的条目数（默认 50）
   * @returns 时间序列点数组（按时间升序）
   */
  buildTimeSeries(memoryService: MemoryService, windowSize = TIME_SERIES_WINDOW): EmotionTimeSeriesPoint[] {
    try {
      const entries = memoryService.getEntries()
      const points: EmotionTimeSeriesPoint[] = []

      // 遍历最近 windowSize 条记录
      const recent = entries.slice(-windowSize)
      for (const entry of recent) {
        const tag = this.extractEmotionTag(entry)
        if (!tag) continue

        const vector = this.toEmotionVector(tag)
        points.push({
          timestamp: tag.timestamp || entry.createdAt,
          emotionVector: vector,
          label: tag.label || 'neutral',
          snippet: entry.content.slice(0, 60),
        })
      }

      // 按时间升序排列
      points.sort((a, b) => a.timestamp - b.timestamp)

      return points
    } catch (err) {
      log('WARN', 'emotion_timeseries_build_error', { error: String(err) })
      return []
    }
  }

  /**
   * 获取最近的情感向量（最新的一个）。
   * 用于判断当前用户情绪状态。
   */
  getLatestEmotionVector(memoryService: MemoryService): EmotionVector {
    const series = this.buildTimeSeries(memoryService, 10)
    if (series.length === 0) return { ...DEFAULT_VECTOR }
    return { ...series[series.length - 1].emotionVector }
  }

  /**
   * 获取情感时间序列的趋势摘要。
   *
   * @returns 趋势描述文本
   */
  getTrendSummary(memoryService: MemoryService): string {
    const series = this.buildTimeSeries(memoryService)
    if (series.length < 2) return '数据不足'

    // 计算整体趋势
    const first = series[0].emotionVector
    const last = series[series.length - 1].emotionVector

    const valenceDelta = last.valence - first.valence
    const arousalDelta = last.arousal - first.arousal

    const parts: string[] = []

    // 效价趋势
    if (valenceDelta > 0.3) parts.push('情绪明显好转')
    else if (valenceDelta > 0.1) parts.push('情绪好转')
    else if (valenceDelta < -0.3) parts.push('情绪明显低落')
    else if (valenceDelta < -0.1) parts.push('情绪轻微低落')
    else parts.push('情绪平稳')

    // 唤醒度趋势
    if (arousalDelta > 0.3) parts.push('活跃度上升')
    else if (arousalDelta < -0.3) parts.push('趋近平静')

    // 波动幅度
    const valences = series.map((p) => p.emotionVector.valence)
    const volatility = Math.max(...valences) - Math.min(...valences)
    if (volatility > 0.6) parts.push('波动较大')
    else if (volatility > 0.3) parts.push('轻微波动')

    return parts.join('，')
  }

  /**
   * 将情感时间序列分为上升和下降两段，检测趋势是否转向。
   * 返回趋势转向点（如果有）。
   */
  detectTurningPoint(memoryService: MemoryService): {
    hasTurningPoint: boolean
    turningIndex: number
    description: string
  } | null {
    const series = this.buildTimeSeries(memoryService, 30)
    if (series.length < 6) return null

    // 将序列分为前后两半
    const halfLen = Math.floor(series.length / 2)
    const firstHalf = series.slice(0, halfLen)
    const secondHalf = series.slice(halfLen)

    const firstAvg = this.averageVector(firstHalf.map((p) => p.emotionVector))
    const secondAvg = this.averageVector(secondHalf.map((p) => p.emotionVector))

    // 检测效价转向
    const firstValenceDir = firstAvg.valence >= 0 ? 'positive' : 'negative'
    const secondValenceDir = secondAvg.valence >= 0 ? 'positive' : 'negative'

    if (firstValenceDir !== secondValenceDir) {
      return {
        hasTurningPoint: true,
        turningIndex: halfLen,
        description: `情绪从${firstValenceDir === 'positive' ? '正面' : '负面'}转向${secondValenceDir === 'positive' ? '正面' : '负面'}`,
      }
    }

    return { hasTurningPoint: false, turningIndex: -1, description: '情绪趋势一致' }
  }

  // ══════════════════════════════════════════
  //  私有工具方法
  // ══════════════════════════════════════════

  /**
   * 从 MemoryEntry 的 structuredData 中提取情感标签。
   */
  private extractEmotionTag(entry: MemoryEntry): MemoryEmotionTag | null {
    if (!entry.structuredData) return null
    try {
      const parsed = JSON.parse(entry.structuredData)
      if (parsed?.emotion) return parsed.emotion as MemoryEmotionTag
    } catch {
      // 解析失败跳过
    }
    return null
  }

  /**
   * 将 MemoryEmotionTag 转换为 EmotionVector。
   * 优先使用已有的 valence/arousal 字段；
   * 如果没有，从极性/标签推断。
   */
  private toEmotionVector(tag: MemoryEmotionTag): EmotionVector {
    // 如果已有维度数据，直接返回
    if (tag.valence !== undefined && tag.arousal !== undefined) {
      return { valence: tag.valence, arousal: tag.arousal }
    }

    // 从标签推断
    return this.inferVectorFromLabel(tag.label, tag.polarity, tag.score)
  }

  /**
   * 从情感标签和极性推断情感向量。
   */
  private inferVectorFromLabel(label: string, polarity: string, score: number): EmotionVector {
    const sf = Math.max(0.2, Math.min(1.0, score)) // scale factor

    switch (label) {
      case 'happy':
        return { valence: 0.7 * sf, arousal: 0.6 * sf }
      case 'sad':
        return { valence: -0.7 * sf, arousal: -0.4 * sf }
      case 'angry':
        return { valence: -0.6 * sf, arousal: 0.7 * sf }
      case 'calm':
        return { valence: 0.3 * sf, arousal: -0.5 * sf }
      case 'anxious':
        return { valence: -0.4 * sf, arousal: 0.6 * sf }
      case 'neutral':
      default:
        if (polarity === 'positive') return { valence: 0.3 * sf, arousal: 0.1 }
        if (polarity === 'negative') return { valence: -0.3 * sf, arousal: 0.1 }
        return { ...DEFAULT_VECTOR }
    }
  }

  /**
   * 计算情感向量的平均值。
   */
  private averageVector(vectors: EmotionVector[]): EmotionVector {
    if (vectors.length === 0) return { ...DEFAULT_VECTOR }
    const sum = vectors.reduce((acc, v) => ({ valence: acc.valence + v.valence, arousal: acc.arousal + v.arousal }), {
      valence: 0,
      arousal: 0,
    })
    return {
      valence: sum.valence / vectors.length,
      arousal: sum.arousal / vectors.length,
    }
  }
}

/** 全局单例 */
export const emotionTimeSeriesStore = new EmotionTimeSeriesStore()
