/**
 * MemoryEmotionBridge — 记忆情感桥接器
 *
 * 连接 Memory（对话历史情感存储）与 TTS（语音合成情感参数）：
 *   1. 用户消息情感分析 → 写入 Memory（emotion tag）
 *   2. TTS 合成前 → 查询近期 Memory 情感上下文
 *   3. 情感上下文 → 映射为 TTS 语速/音调调整参数
 *
 * 与现有情感系统的协作关系：
 *   - SentimentAnalyzer: 轻量文本情感分析（关键词匹配）
 *   - EmotionToneMap: 情感极性 → TTS 参数映射（本服务扩展其用法）
 *   - VoiceStyleMap: 语义风格检测（回复类别 → 语音风格）
 *   - ContextualTtsAdvisor: 交互节奏 + 时段感知（与记忆情感互补）
 *
 * 设计原则：
 *   - 无额外外部依赖：复用 SentimentAnalyzer 的情感分析能力
 *   - 轻量级：无阻塞网络调用，纯内存计算
 *   - 隐私友好：情感标签仅存储在本地 SQLite，不发送到外部 API
 */

import { log } from '../logger/Logger'
import type { MemoryService } from '../memory/MemoryService'
import type { MemoryEntry, MemoryEmotionTag } from '../memory/types'
import type { EmotionTtsParams } from './types'
import { sentimentAnalyzer } from './SentimentAnalyzer'

// ══════════════════════════════════════════
//  配置常量
// ══════════════════════════════════════════

/** 情感上下文分析窗口：最近 N 条交互记录 */
const EMOTION_CONTEXT_WINDOW = 10

/** 情感标签 → 语速调整映射（在基础语速上叠加） */
const EMOTION_LABEL_RATE_MAP: Record<string, number> = {
  happy: +5,    // 开心 → 语速稍快
  sad: -5,      // 悲伤 → 语速放缓
  angry: -3,    // 生气 → 语速放缓（以柔克刚）
  calm: 0,      // 平静 → 无调整
  anxious: -8,  // 焦虑 → 语速放慢（安抚）
  neutral: 0,   // 中性 → 无调整
}

/** 情感标签 → 音调调整映射（在基础音调上叠加） */
const EMOTION_LABEL_PITCH_MAP: Record<string, number> = {
  happy: +4,    // 开心 → 音调偏高
  sad: -4,      // 悲伤 → 音调偏低
  angry: -3,    // 生气 → 音调降低（安抚）
  calm: 0,      // 平静 → 无调整
  anxious: -5,  // 焦虑 → 音调降低（安抚）
  neutral: 0,   // 中性 → 无调整
}

/** 情感标签的显示名称（中文） */
const EMOTION_LABEL_CN: Record<string, string> = {
  happy: '开心',
  sad: '悲伤',
  angry: '生气',
  calm: '平静',
  anxious: '焦虑',
  neutral: '中性',
}

// ══════════════════════════════════════════
//  类型定义
// ══════════════════════════════════════════

/** 聚合后的情感上下文 */
export interface AggregatedEmotionContext {
  /** 窗口内的情感统计 */
  stats: {
    /** 当前主导情感标签 */
    dominantLabel: string
    /** 当前主导极性 */
    dominantPolarity: 'positive' | 'negative' | 'neutral'
    /** 各情感标签计数 */
    labelCounts: Record<string, number>
    /** 各极性计数 */
    polarityCounts: Record<string, number>
    /** 窗口内总条目数 */
    totalEntries: number
    /** 情感变化的趋势（上升/下降/平稳） */
    trend: 'rising' | 'falling' | 'stable'
  }
  /** 推荐的 TTS 参数调整值 */
  adjustment: {
    /** 语速调整值（百分比） */
    rateDelta: number
    /** 音调调整值（Hz） */
    pitchDelta: number
    /** 调整原因描述 */
    reason: string
  }
  /** 所有原始情感标签（按时间倒序） */
  recentEmotions: MemoryEmotionTag[]
}

// ══════════════════════════════════════════
//  MemoryEmotionBridge
// ══════════════════════════════════════════

export class MemoryEmotionBridge {
  /**
   * 分析用户消息情感并在 Memory 中存储情感标签。
   *
   * 在 ChatExecutor.run() 中收到用户消息后调用。
   * 情感标签通过 structuredData 字段存储，key="emotion"。
   *
   * @param userText 用户消息文本
   * @param memoryService MemoryService 实例
   */
  recordUserMessageEmotion(userText: string, memoryService: MemoryService): void {
    if (!userText || userText.trim().length === 0) return

    try {
      // 1. 情感分析
      const result = sentimentAnalyzer.analyze(userText)

      // 2. 映射情感标签
      const emotionLabel = this.mapPolarityToLabel(result.polarity, result.contentType, result.matchedWords)

      // 3. 构造情感标签
      const tag: MemoryEmotionTag = {
        polarity: result.polarity,
        score: result.score,
        label: emotionLabel,
        contentType: result.contentType,
        matchedWords: result.matchedWords.slice(0, 5),
        timestamp: Date.now(),
      }

      // 4. 查找最近一条用户输入相关的 Memory 条目并附加情感标签
      //    或创建新的 emotion 类型记忆条目
      const entries = memoryService.getEntries()
      const recentEntry = entries
        .filter((e) => e.type === 'user_fact' || e.type === 'interaction')
        .slice(-1)[0]

      if (recentEntry) {
        // 附加情感标签到最近条目
        this.attachEmotionToEntry(recentEntry, tag)
      } else {
        // 没有现有条目，新建一条情感标签记忆
        const emotionContent = `【用户情绪】${EMOTION_LABEL_CN[emotionLabel] || '中性'} — ${userText.slice(0, 80)}`
        memoryService.addEntry('user_fact', emotionContent, result.score, { tier: 'ephemeral' })

        // 获取刚创建的条目并附加 emotion data
        const addedEntry = memoryService.getEntries().slice(-1)[0]
        if (addedEntry) {
          this.attachEmotionToEntry(addedEntry, tag)
        }
      }

      log('INFO', 'memory_emotion_recorded', {
        polarity: result.polarity,
        label: emotionLabel,
        score: result.score.toFixed(2),
        text_snippet: userText.slice(0, 40),
      })
    } catch (err) {
      log('WARN', 'memory_emotion_record_failed', { error: String(err) })
    }
  }

  /**
   * 查询近期记忆的情感上下文。
   *
   * 在 TTS 合成前调用，返回最近 N 条交互的聚合情感分析结果。
   *
   * @param memoryService MemoryService 实例
   * @returns 聚合情感上下文（或空上下文）
   */
  getRecentEmotionContext(memoryService: MemoryService): AggregatedEmotionContext {
    const entries = memoryService.getEntries()

    // 1. 从最近条目中提取情感标签
    const emotions: MemoryEmotionTag[] = []
    const recent = entries.slice(-EMOTION_CONTEXT_WINDOW)

    for (const entry of recent) {
      const tag = this.extractEmotionFromEntry(entry)
      if (tag) {
        emotions.push(tag)
      }
    }

    // 2. 如果没有情感数据，返回空上下文
    if (emotions.length === 0) {
      return {
        stats: {
          dominantLabel: 'neutral',
          dominantPolarity: 'neutral',
          labelCounts: { neutral: 1 },
          polarityCounts: { neutral: 1 },
          totalEntries: 0,
          trend: 'stable',
        },
        adjustment: {
          rateDelta: 0,
          pitchDelta: 0,
          reason: '无历史情感数据',
        },
        recentEmotions: [],
      }
    }

    // 3. 统计情感标签和极性分布
    const labelCounts: Record<string, number> = {}
    const polarityCounts: Record<string, number> = {}
    let totalScore = 0

    for (const e of emotions) {
      labelCounts[e.label] = (labelCounts[e.label] || 0) + 1
      polarityCounts[e.polarity] = (polarityCounts[e.polarity] || 0) + 1
      totalScore += e.score
    }

    // 4. 确定主导情感
    const dominantLabel = Object.entries(labelCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'neutral'

    const dominantPolarity = (Object.entries(polarityCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'neutral') as 'positive' | 'negative' | 'neutral'

    // 5. 分析趋势：比较最近半数与前半数
    const halfLen = Math.floor(emotions.length / 2)
    if (halfLen >= 1) {
      const recentHalf = emotions.slice(0, halfLen)
      const earlyHalf = emotions.slice(halfLen)
      const recentPositive = recentHalf.filter((e) => e.polarity === 'positive').length
      const earlyPositive = earlyHalf.filter((e) => e.polarity === 'positive').length

      // trend 判断
      // 实际上按时间倒序，recentHalf 是更新的
    }
    // 简化趋势判断
    const trend = this.detectTrend(emotions)

    // 6. 计算语速/音调调整
    const rateDelta = EMOTION_LABEL_RATE_MAP[dominantLabel] || 0
    const pitchDelta = EMOTION_LABEL_PITCH_MAP[dominantLabel] || 0

    // 如果负面情绪占主导，加强调整幅度
    const negativeRatio = (polarityCounts['negative'] || 0) / emotions.length
    const adjustedRateDelta = negativeRatio > 0.5 ? rateDelta - 3 : rateDelta
    const adjustedPitchDelta = negativeRatio > 0.5 ? pitchDelta - 2 : pitchDelta

    // 7. 构建原因描述
    const reason = this.buildContextReason(dominantLabel, dominantPolarity, labelCounts, emotions.length, trend)

    return {
      stats: {
        dominantLabel,
        dominantPolarity,
        labelCounts,
        polarityCounts,
        totalEntries: emotions.length,
        trend,
      },
      adjustment: {
        rateDelta: adjustedRateDelta,
        pitchDelta: adjustedPitchDelta,
        reason,
      },
      recentEmotions: emotions,
    }
  }

  /**
   * 将情感上下文应用到 TTS 参数上。
   *
   * 接收已有的 EmotionTtsParams 和 AggregatedEmotionContext，
   * 返回叠加了记忆情感调整的新参数。
   *
   * @param baseParams 基础 TTS 参数（来自现有情感分析链）
   * @param context 记忆情感上下文
   * @returns 叠加记忆情感后的 TTS 参数
   */
  blendWithTtsParams(baseParams: EmotionTtsParams, context: AggregatedEmotionContext): EmotionTtsParams {
    // 无有效上下文或数据不足时不调整
    if (context.recentEmotions.length === 0 || context.stats.totalEntries === 0) {
      return { ...baseParams }
    }

    // 将 rateDelta 和 pitchDelta 叠加到当前参数
    const currentRate = parseInt(baseParams.rate.replace(/[^0-9-]/g, '')) || 0
    const currentPitch = parseInt(baseParams.pitch.replace(/[^0-9-]/g, '')) || 0

    // 记忆情感权重（记忆上下文占 30%，以保持与内容情感分析的平衡）
    const MEMORY_EMOTION_WEIGHT = 0.3
    const CONTENT_EMOTION_WEIGHT = 0.7

    const blendedRate = Math.round(
      currentRate * CONTENT_EMOTION_WEIGHT + (currentRate + context.adjustment.rateDelta) * MEMORY_EMOTION_WEIGHT
    )
    const blendedPitch = Math.round(
      currentPitch * CONTENT_EMOTION_WEIGHT + (currentPitch + context.adjustment.pitchDelta) * MEMORY_EMOTION_WEIGHT
    )

    // 夹到有效范围
    const finalRate = Math.max(-50, Math.min(50, blendedRate))
    const finalPitch = Math.max(-20, Math.min(20, blendedPitch))

    const labelEmoji = EMOTION_LABEL_CN[context.stats.dominantLabel] || '中性'

    return {
      voice: baseParams.voice,
      rate: `${finalRate >= 0 ? '+' : ''}${finalRate}%`,
      pitch: `${finalPitch >= 0 ? '+' : ''}${finalPitch}Hz`,
      label: `${baseParams.label}·忆${labelEmoji}`,
    }
  }

  /**
   * 获取情感上下文的调试信息（供 IPC/UI 展示）。
   */
  getEmotionContextDebugInfo(context: AggregatedEmotionContext): Record<string, unknown> {
    return {
      dominantLabel: context.stats.dominantLabel,
      dominantPolarity: context.stats.dominantPolarity,
      trend: context.stats.trend,
      entries: context.stats.totalEntries,
      labelDistribution: context.stats.labelCounts,
      polarityDistribution: context.stats.polarityCounts,
      adjustment: context.adjustment,
    }
  }

  // ══════════════════════════════════════════
  //  私有工具方法
  // ══════════════════════════════════════════

  /**
   * 将 EmotionToneMap 的极性/内容映射为更细粒度的情感标签。
   */
  private mapPolarityToLabel(
    polarity: 'positive' | 'negative' | 'neutral',
    contentType: string,
    matchedWords: string[],
  ): string {
    if (polarity === 'positive') {
      // 检测是否为"开心"级别
      if (matchedWords.some((w) => ['开心', '高兴', '喜悦', '愉快', '棒', '赞', '完美', '精彩', '厉害'].includes(w))) {
        return 'happy'
      }
      return 'happy' // 正面统一为 happy
    }

    if (polarity === 'negative') {
      // 区分生气 vs 悲伤 vs 焦虑
      if (matchedWords.some((w) => ['生气', '愤怒', '恼火', '烦躁'].includes(w))) {
        return 'angry'
      }
      if (matchedWords.some((w) => ['焦虑', '担心', '担忧', '不安', '紧张'].includes(w))) {
        return 'anxious'
      }
      return 'sad' // 其他负面统一为 sad
    }

    return 'neutral'
  }

  /**
   * 从 MemoryEntry 的 structuredData 中提取情感标签。
   * 标签存储格式：structuredData = JSON.stringify({ emotion: MemoryEmotionTag, ...其他数据 })
   */
  private extractEmotionFromEntry(entry: MemoryEntry): MemoryEmotionTag | null {
    if (!entry.structuredData) return null

    try {
      const parsed = JSON.parse(entry.structuredData)
      if (parsed && parsed.emotion) {
        return parsed.emotion as MemoryEmotionTag
      }
    } catch {
      // 解析失败 → 不是 emotion 数据
    }
    return null
  }

  /**
   * 将情感标签附加到 MemoryEntry 的 structuredData。
   * 保留 structuredData 中已有的其他数据。
   */
  private attachEmotionToEntry(entry: MemoryEntry, tag: MemoryEmotionTag): void {
    try {
      let data: Record<string, unknown> = {}
      if (entry.structuredData) {
        try {
          data = JSON.parse(entry.structuredData)
        } catch {
          data = {}
        }
      }
      data.emotion = tag
      entry.structuredData = JSON.stringify(data)
      entry.updatedAt = Date.now()
    } catch (err) {
      log('WARN', 'memory_emotion_attach_failed', { error: String(err) })
    }
  }

  /**
   * 检测情感趋势。
   * 将窗口内的情感标签按时间分为两半，比较后半（更新）与前半的情感极性变化。
   */
  private detectTrend(emotions: MemoryEmotionTag[]): 'rising' | 'falling' | 'stable' {
    if (emotions.length < 4) return 'stable'

    const halfLen = Math.floor(emotions.length / 2)
    // emotions 已按时间倒序（最新的在前）
    const recentHalf = emotions.slice(0, halfLen)
    const earlyHalf = emotions.slice(halfLen)

    const recentPositive = recentHalf.filter((e) => e.polarity === 'positive').length
    const recentNegative = recentHalf.filter((e) => e.polarity === 'negative').length
    const earlyPositive = earlyHalf.filter((e) => e.polarity === 'positive').length
    const earlyNegative = earlyHalf.filter((e) => e.polarity === 'negative').length

    const recentNet = recentPositive - recentNegative
    const earlyNet = earlyPositive - earlyNegative

    if (recentNet > earlyNet + 1) return 'rising'
    if (recentNet < earlyNet - 1) return 'falling'
    return 'stable'
  }

  /**
   * 构建情感上下文描述。
   */
  private buildContextReason(
    dominantLabel: string,
    dominantPolarity: string,
    labelCounts: Record<string, number>,
    totalCount: number,
    trend: string,
  ): string {
    const labelCN = EMOTION_LABEL_CN[dominantLabel] || dominantLabel
    const trendCN: Record<string, string> = {
      rising: '情绪上升',
      falling: '情绪回落',
      stable: '情绪平稳',
    }

    const parts: string[] = [
      `记忆情感：${labelCN}`,
      `${trendCN[trend] || '平稳'}`,
      `基于 ${totalCount} 条历史记录`,
    ]

    return parts.join(' | ')
  }
}

/** 全局单例 */
export const memoryEmotionBridge = new MemoryEmotionBridge()
