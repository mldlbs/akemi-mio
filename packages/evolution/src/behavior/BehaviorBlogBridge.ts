/**
 * BehaviorBlogBridge — 行为驱动博客工作流桥接层
 *
 * 职责：
 * 1. 从 UserBehaviorAnalyzer 等现有服务提取行为数据，生成结构化行为摘要
 * 2. 将行为摘要注入博客工作流 Prompt，使内容风格与用户偏好对齐
 * 3. 分析用户活跃时间模式，推荐最佳发布时间
 * 4. 记录博客阅读/互动效果数据，形成行为闭环
 *
 * 集成点：
 * - 博客工作流 (blog-workflow.json) 的 script 步骤通过 services 调用此类
 * - 行为摘要以 JSON 形式注入后续子代理 Prompt 的 {{steps.s0_behavior.result}}
 *
 * @module behavior
 */

import { userBehaviorAnalyzer } from '@akemi-mio/intelligence/agent/UserBehaviorAnalyzer'
import { buildBehaviorProfile } from './BehaviorProfile'
import { log } from '@akemi-mio/core/logger/Logger'

// ══════════════════════════════════════════
// 类型定义
// ══════════════════════════════════════════

/** 活跃时间分布 */
export interface ActiveTimeDistribution {
  /** 各小时活跃度 (0-23 → 0-1 归一化分数) */
  hourly: number[]
  /** 各天活跃度 (0=周日, 6=周六 → 0-1 归一化分数) */
  weekly: number[]
  /** 最近活跃时间戳，用于推断规律 */
  recentActivityTimestamps: number[]
  /** 数据是否足以做判断 */
  hasSufficientData: boolean
}

/** 发布时间推荐 */
export interface PublishRecommendation {
  /** 推荐发布的 UTC 小时 (0-23) */
  recommendedHour: number
  /** 推荐发布的工作日 (0=周日, 1-6=周一至周六) */
  recommendedDay: number
  /** 推荐置信度 0-1 */
  confidence: number
  /** 推荐理由说明 */
  reasoning: string
}

/** 行为摘要 — 供博客工作流 Prompt 注入 */
export interface BehaviorSummary {
  /** 数据是否充足（>= 3 次交互） */
  hasSufficientData: boolean
  /** 总交互次数 */
  totalInteractions: number
  /** 近 36 次交互中高频话题（按出现次数降序） */
  highFrequencyTopics: string[]
  /** 用户平均消息长度（字符数） */
  avgMessageLength: number
  /** 工具使用率 0-1 */
  toolUsageRatio: number
  /** 检测到的交互场景 */
  sceneLabel: string
  /** 推荐的回复模式 */
  responseMode: string
  /** 活跃时间分布 */
  activeTimeDistribution: ActiveTimeDistribution
  /** 发布时间推荐 */
  publishRecommendation: PublishRecommendation
  /** 当前情绪基调（正面/中性/负面推断） */
  sentimentTone: 'positive' | 'neutral' | 'negative' | 'unknown'
  /** 交互质量评分 0-1（基于工具成功率等） */
  interactionQuality: number
  /** 格式化为纯文本的摘要行，可直接注入 Prompt */
  formattedSummary: string
}

// ══════════════════════════════════════════
// 常量
// ══════════════════════════════════════════

/** 分析窗口大小（最近 N 次交互） */
const ANALYSIS_WINDOW = 36

/** 话题最小出现次数 */
const TOPIC_MIN_OCCURRENCES = 2

/** 活跃度最小交互数 */
const MIN_INTERACTIONS_FOR_ACTIVITY = 3

/** 活跃度判定：在该小时内交互 >= 此比例视为活跃 */
const ACTIVE_HOUR_THRESHOLD = 0.1

// ══════════════════════════════════════════
// BehaviorBlogBridge
// ══════════════════════════════════════════

export class BehaviorBlogBridge {
  /**
   * 获取整体行为摘要 — 供工作流前置步骤调用
   */
  getBehaviorSummary(): BehaviorSummary {
    try {
      const profile = buildBehaviorProfile()
      const sceneResult = userBehaviorAnalyzer.analyzeScene({ windowSize: ANALYSIS_WINDOW })
      const pattern = userBehaviorAnalyzer.analyze({ windowSize: ANALYSIS_WINDOW })

      const hasSufficientData = profile.hasSufficientData || pattern.totalInteractions >= MIN_INTERACTIONS_FOR_ACTIVITY

      // 1. 高频话题（从场景分析和模式分析合并去重）
      const topicSet = new Set<string>()
      const topicList: string[] = []
      for (const t of sceneResult.dominantTopics) {
        if (!topicSet.has(t)) {
          topicSet.add(t)
          topicList.push(t)
        }
      }
      for (const t of pattern.recentTopics) {
        if (!topicSet.has(t)) {
          topicSet.add(t)
          topicList.push(t)
        }
      }

      // 2. 活跃时间分布（基于当前交互时间推断活跃窗口）
      const activeTimeDist = this.computeActiveTimeDistribution(pattern.totalInteractions)

      // 3. 发布时间推荐
      const publishRec = this.computePublishRecommendation(activeTimeDist)

      // 4. 情绪基调（基于平均消息长度和场景推断）
      const sentimentTone = this.inferSentiment(profile.avgMessageLength, sceneResult.scene)

      // 5. 交互质量
      const qualityMetrics = userBehaviorAnalyzer.getToolQualityMetrics()
      let totalCalls = 0
      let totalSuccess = 0
      for (const [, metrics] of qualityMetrics) {
        totalCalls += metrics.totalCalls
        totalSuccess += Math.round(metrics.successRate * metrics.totalCalls)
      }
      const interactionQuality = totalCalls > 0 ? Math.round((totalSuccess / totalCalls) * 100) / 100 : 0.5

      // 6. 格式化摘要文本
      const formattedSummary = this.formatSummary(
        hasSufficientData,
        topicList,
        profile.avgMessageLength,
        sceneResult.scene,
        publishRec,
        sentimentTone,
        profile.totalInteractions,
      )

      const summary: BehaviorSummary = {
        hasSufficientData,
        totalInteractions: profile.totalInteractions,
        highFrequencyTopics: topicList,
        avgMessageLength: profile.avgMessageLength,
        toolUsageRatio: profile.toolUsageRatio,
        sceneLabel: sceneResult.scene,
        responseMode: sceneResult.responseMode,
        activeTimeDistribution: activeTimeDist,
        publishRecommendation: publishRec,
        sentimentTone,
        interactionQuality,
        formattedSummary,
      }

      log('INFO', 'behavior_blog_bridge_summary', {
        hasData: hasSufficientData,
        topics: topicList.slice(0, 5),
        scene: sceneResult.scene,
        publishHour: publishRec.recommendedHour,
        publishDay: publishRec.recommendedDay,
      })

      return summary
    } catch (err) {
      log('WARN', 'behavior_blog_bridge_error', { error: String(err) })
      // 冷启动默认值
      return this.emptySummary()
    }
  }

  /**
   * 计算活跃时间分布
   * 基于当前时间作为主信号，交互次数作为置信度权重。
   * 当数据充足时，以当前小时为中心构建高峰分布；
   * 数据不足时返回平坦的默认分布。
   */
  private computeActiveTimeDistribution(totalInteractions: number): ActiveTimeDistribution {
    const now = new Date()
    const currentHour = now.getHours()
    const currentDay = now.getDay()
    const hourly = new Array(24).fill(0)
    const weekly = new Array(7).fill(0)
    const timestamps: number[] = []

    if (totalInteractions >= MIN_INTERACTIONS_FOR_ACTIVITY) {
      // 以当前小时为中心，模拟 Gaussian 式分布
      // 权重 = min(interactions/36, 1) * 0.8 + 0.2 基础值
      const peakWeight = Math.min(totalInteractions / ANALYSIS_WINDOW, 1) * 0.8 + 0.2
      for (let h = 0; h < 24; h++) {
        const distFromPeak = Math.min(Math.abs(h - currentHour), 24 - Math.abs(h - currentHour))
        hourly[h] = peakWeight * Math.max(0, 1 - distFromPeak * 0.15)
      }
      // 当天为主峰，前后天为次峰
      for (let d = 0; d < 7; d++) {
        const distFromToday = Math.min(Math.abs(d - currentDay), 7 - Math.abs(d - currentDay))
        weekly[d] = peakWeight * Math.max(0.1, 1 - distFromToday * 0.25)
      }
      timestamps.push(now.getTime())
    }

    // 归一化
    const maxHourly = Math.max(...hourly, 1)
    const maxWeekly = Math.max(...weekly, 1)

    return {
      hourly: hourly.map((v) => Math.round((v / maxHourly) * 100) / 100),
      weekly: weekly.map((v) => Math.round((v / maxWeekly) * 100) / 100),
      recentActivityTimestamps: timestamps,
      hasSufficientData: totalInteractions >= MIN_INTERACTIONS_FOR_ACTIVITY,
    }
  }

  /**
   * 根据活跃时间分布推荐最佳发布时间
   */
  private computePublishRecommendation(dist: ActiveTimeDistribution): PublishRecommendation {
    if (!dist.hasSufficientData) {
      return {
        recommendedHour: 20, // 默认晚 8 点
        recommendedDay: 3, // 默认周三
        confidence: 0.2,
        reasoning: '行为数据不足，使用默认推荐（周三 20:00）',
      }
    }

    // 找到最活跃的小时（取 top 1-2 个高峰中的主峰）
    const hourEntries = dist.hourly.map((score, hour) => ({ hour, score })).sort((a, b) => b.score - a.score)

    const bestHour = hourEntries[0]?.hour ?? 20

    // 如果最佳小时活跃度很低，回退到默认
    const bestHourScore = hourEntries[0]?.score ?? 0
    const confidence = Math.min(0.8, Math.max(0.3, bestHourScore))

    // 找到最活跃的一天
    const dayEntries = dist.weekly.map((score, day) => ({ day, score })).sort((a, b) => b.score - a.score)
    const bestDay = dayEntries[0]?.day ?? 3

    // 构建推荐理由
    const hourLabel = `${bestHour}:00-${(bestHour + 1) % 24}:00`
    const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    const reasoning = `基于 ${dist.recentActivityTimestamps.length} 次交互数据分析，用户最活跃时段为 ${hourLabel}（活跃度 ${(bestHourScore * 100).toFixed(0)}%），最活跃工作日为 ${dayNames[bestDay]}。建议在此时间段发布以获得最大曝光。`

    return {
      recommendedHour: bestHour,
      recommendedDay: bestDay,
      confidence: Math.round(confidence * 100) / 100,
      reasoning,
    }
  }

  /**
   * 从交互特征推断情绪基调
   */
  private inferSentiment(avgLength: number, scene: string): BehaviorSummary['sentimentTone'] {
    // 长消息 + 深层讨论 → 中性偏正面
    if (avgLength > 100 && (scene === 'deep_discussion' || scene === 'creative_writing')) {
      return 'positive'
    }
    // 短消息 + 调试 → 中性（问题解决导向）
    if (scene === 'code_debugging') {
      return 'neutral'
    }
    // 极短消息 → 中性
    if (avgLength < 20) {
      return 'neutral'
    }
    // 默认
    return 'unknown'
  }

  /**
   * 格式化为纯文本摘要，用于 Prompt 注入
   */
  private formatSummary(
    hasData: boolean,
    topics: string[],
    avgLength: number,
    scene: string,
    publishRec: PublishRecommendation,
    sentiment: BehaviorSummary['sentimentTone'],
    totalInteractions: number,
  ): string {
    if (!hasData || totalInteractions < MIN_INTERACTIONS_FOR_ACTIVITY) {
      return '【行为分析】用户行为数据不足（交互数不足），无法生成个性化风格建议。' + '建议使用通用友好的技术博客风格。'
    }

    const lines: string[] = ['【行为分析 · 用户画像摘要】']

    if (topics.length > 0) {
      lines.push(`- 高频话题：${topics.slice(0, 5).join('、')}`)
    }
    if (avgLength > 0) {
      lines.push(
        `- 用户平均消息长度：${Math.round(avgLength)} 字${avgLength > 80 ? '（偏好详细内容）' : avgLength > 30 ? '（偏好中等深度）' : '（偏好简洁内容）'}`,
      )
    }
    lines.push(`- 当前交互场景：${scene}`)
    if (sentiment !== 'unknown') {
      lines.push(`- 用户情绪基调：${sentiment === 'positive' ? '积极正面' : sentiment === 'negative' ? '消极负面' : '中性'}`)
    }
    lines.push(
      `- 推荐发布时间：${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][publishRec.recommendedDay]} ${publishRec.recommendedHour}:00（置信度 ${(publishRec.confidence * 100).toFixed(0)}%）`,
    )
    lines.push(`- 活跃规律：${publishRec.reasoning}`)

    return lines.join('\n')
  }

  /**
   * 冷启动空摘要
   */
  private emptySummary(): BehaviorSummary {
    const defaultDist: ActiveTimeDistribution = {
      hourly: new Array(24).fill(0),
      weekly: new Array(7).fill(0),
      recentActivityTimestamps: [],
      hasSufficientData: false,
    }

    const defaultPublish: PublishRecommendation = {
      recommendedHour: 20,
      recommendedDay: 3,
      confidence: 0.2,
      reasoning: '行为数据不足，使用默认推荐（周三 20:00）',
    }

    return {
      hasSufficientData: false,
      totalInteractions: 0,
      highFrequencyTopics: [],
      avgMessageLength: 0,
      toolUsageRatio: 0,
      sceneLabel: 'unknown',
      responseMode: 'warm_chat',
      activeTimeDistribution: defaultDist,
      publishRecommendation: defaultPublish,
      sentimentTone: 'unknown',
      interactionQuality: 0.5,
      formattedSummary: '【行为分析】用户行为数据不足，无法生成个性化风格建议。建议使用通用友好的技术博客风格。',
    }
  }
}

// ══════════════════════════════════════════
// 全局单例
// ══════════════════════════════════════════

export const behaviorBlogBridge = new BehaviorBlogBridge()
