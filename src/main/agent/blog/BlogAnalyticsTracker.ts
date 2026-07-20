/**
 * BlogAnalyticsTracker — 博客发布后追踪与选题策略调整
 *
 * 职责：
 * 1. 记录文章发布后的表现数据（阅读量、互动等）
 * 2. 按类别/平台/时段汇总分析
 * 3. 基于表现数据自动调整选题策略
 * 4. 生成洞察报告供工作流消费
 *
 * 数据流：
 *   发布文章 → 登记 PostPerformance → 按类别/平台/时段聚合 →
 *   生成 AnalyticsReport → 调整选题策略 → 输出 StrategyOutput
 *
 * 与 BehaviorBlogBridge 的关系：
 *   - BehaviorBlogBridge 分析用户交互行为（写作前）
 *   - BlogAnalyticsTracker 分析文章表现数据（发布后）
 *   - 两者互补形成完整的行为→效果闭环
 */

import { log } from '../../logger/Logger'
import type {
  PostPerformance,
  AnalyticsReport,
  CategoryPerformanceSummary,
  PlatformPerformance,
  StrategyOutput,
  StrategyAdjustment,
  TimeSlotPerformance,
} from './types'

// =============================================================================
// 常量
// =============================================================================

/** 数据充足所需的最小文章数 */
const MIN_POSTS_FOR_ANALYSIS = 3

/** 数据充足所需的最小平台数 */
const MIN_PLATFORMS_FOR_COMPARISON = 2

/** 效果评分权重 */
const ENGAGEMENT_WEIGHT = 0.5
const VIEWS_WEIGHT = 0.3
const RECENCY_WEIGHT = 0.2

/** 记忆键前缀 */
const MEMORY_KEY_PREFIX = 'blog_analytics_'

// =============================================================================
// BlogAnalyticsTracker
// =============================================================================

export class BlogAnalyticsTracker {
  /** 已发布文章效果记录（内存缓存） */
  private posts: PostPerformance[] = []

  constructor() {
    this.loadFromMemory()
    log('INFO', 'blog_analytics_tracker_init', { loadedPosts: this.posts.length })
  }

  // ===========================================================================
  // 效果记录
  // ===========================================================================

  /**
   * 登记一篇已发布文章的效果数据
   */
  recordPostPerformance(data: Omit<PostPerformance, 'engagementRate'>): void {
    const engagementRate = data.views > 0
      ? (data.likes + data.comments + data.shares) / data.views
      : 0

    const existingIdx = this.posts.findIndex(
      (p) => p.postId === data.postId && p.platform === data.platform,
    )

    const record: PostPerformance = {
      ...data,
      engagementRate: Math.round(engagementRate * 10000) / 10000,
    }

    if (existingIdx >= 0) {
      // 更新已有记录
      this.posts[existingIdx] = record
    } else {
      this.posts.push(record)
    }

    // 限制内存缓存大小（保留最近 200 条）
    if (this.posts.length > 200) {
      this.posts = this.posts.sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 200)
    }

    this.saveToMemory()
    log('INFO', 'blog_analytics_recorded', {
      postId: data.postId,
      platform: data.platform,
      views: data.views,
      engagementRate: record.engagementRate,
    })
  }

  /**
   * 批量登记效果数据
   */
  recordBatch(data: Array<Omit<PostPerformance, 'engagementRate'>>): void {
    for (const d of data) {
      this.recordPostPerformance(d)
    }
  }

  /**
   * 获取所有已发布的文章表现数据
   */
  getAllPosts(): PostPerformance[] {
    return [...this.posts]
  }

  // ===========================================================================
  // 分析报告生成
  // ===========================================================================

  /**
   * 生成效果分析报告
   */
  generateReport(): AnalyticsReport {
    const posts = this.posts
    const hasSufficientData = posts.length >= MIN_POSTS_FOR_ANALYSIS

    if (!hasSufficientData) {
      return {
        generatedAt: Date.now(),
        totalPosts: posts.length,
        platforms: [...new Set(posts.map((p) => p.platform))],
        overallAvgViews: this.average(posts.map((p) => p.views)),
        overallAvgEngagementRate: this.average(posts.map((p) => p.engagementRate)),
        categorySummary: [],
        platformPerformance: [],
        bestTimeSlots: [],
        bestPlatform: '未知',
        topCategory: '未知',
        insights: ['数据不足，至少需要 3 篇文章才能生成有效分析'],
        hasSufficientData: false,
      }
    }

    // 按类别汇总
    const categorySummary = this.buildCategorySummary(posts)

    // 按平台表现
    const platformPerformance = this.buildPlatformPerformance(posts)

    // 最佳发布时段
    const bestTimeSlots = this.buildTimeSlotAnalysis(posts)

    // 最佳平台
    const bestPlatform = platformPerformance.length > 0
      ? platformPerformance.reduce((a, b) =>
          a.avgEngagementRate > b.avgEngagementRate ? a : b,
        ).platform
      : '未知'

    // 表现最好的类别
    const topCategory = categorySummary.length > 0
      ? categorySummary.reduce((a, b) =>
          a.performanceScore > b.performanceScore ? a : b,
        ).category
      : '未知'

    // 生成洞察
    const insights = this.generateInsights(
      posts,
      categorySummary,
      platformPerformance,
      bestTimeSlots,
    )

    return {
      generatedAt: Date.now(),
      totalPosts: posts.length,
      platforms: [...new Set(posts.map((p) => p.platform))],
      overallAvgViews: this.average(posts.map((p) => p.views)),
      overallAvgEngagementRate: this.average(posts.map((p) => p.engagementRate)),
      categorySummary,
      platformPerformance,
      bestTimeSlots,
      bestPlatform,
      topCategory,
      insights,
      hasSufficientData: true,
    }
  }

  // ===========================================================================
  // 选题策略调整
  // ===========================================================================

  /**
   * 基于效果数据自动调整选题策略
   *
   * @param plannedTopics 当前规划中的选题列表（可选）
   * @returns 策略调整建议
   */
  adjustStrategy(plannedTopics?: string[]): StrategyOutput {
    const report = this.generateReport()
    const adjustments: StrategyAdjustment[] = []
    const recommendedTopics: string[] = []
    const avoidTopics: string[] = []

    if (!report.hasSufficientData) {
      return {
        timestamp: Date.now(),
        dataDriven: false,
        recommendedTopics: plannedTopics?.slice(0, 3) ?? [
          '技术教程与指南',
          '项目经验分享',
          '工具推荐与评测',
        ],
        adjustments: [],
        avoidTopics: [],
        summary: '数据不足以进行数据驱动的策略调整。建议先发布 3 篇以上文章积累数据。默认推荐通用技术博客方向',
      }
    }

    // 基于类别表现调整
    for (const cat of report.categorySummary) {
      if (cat.performanceScore >= 0.65) {
        // 表现好的类别 → 增加投入
        adjustments.push({
          topic: cat.category,
          direction: 'double_down',
          reason: `该类别的综合表现评分为 ${(cat.performanceScore * 100).toFixed(0)}/100，平均互动率 ${(cat.avgEngagementRate * 100).toFixed(1)}%`,
          magnitude: Math.min(0.5, cat.performanceScore * 0.4),
          expectedOutcome: '预期通过增加相关选题维持或提升读者参与度',
        })
        recommendedTopics.push(cat.category)
      } else if (cat.performanceScore <= 0.35) {
        // 表现差的类别 → 减少投入/避免
        adjustments.push({
          topic: cat.category,
          direction: 'reduce',
          reason: `该类别的综合表现评分为 ${(cat.performanceScore * 100).toFixed(0)}/100，平均互动率仅 ${(cat.avgEngagementRate * 100).toFixed(1)}%`,
          magnitude: 0.3,
          expectedOutcome: '减少低互动内容的发布比例，将精力转向更高回报的选题',
        })
        avoidTopics.push(cat.category)
      }
    }

    // 基于平台表现调整
    const bestPlatform = report.platformPerformance[0]
    const worstPlatform = report.platformPerformance[report.platformPerformance.length - 1]

    if (bestPlatform && bestPlatform.avgEngagementRate > 0.05) {
      adjustments.push({
        topic: `优化 ${bestPlatform.platform} 内容格式`,
        direction: 'explore',
        reason: `${bestPlatform.platform} 的平均互动率 ${(bestPlatform.avgEngagementRate * 100).toFixed(1)}% 高于其他平台`,
        magnitude: 0.2,
        expectedOutcome: `针对性优化 ${bestPlatform.platform} 的内容格式以进一步提高互动`,
      })
    }

    // 基于最佳发布时段调整
    if (report.bestTimeSlots.length > 0) {
      const bestSlot = report.bestTimeSlots[0]
      adjustments.push({
        topic: `调整发布时段`,
        direction: 'shift',
        reason: `${bestSlot.hour}:00 时段的平均互动率 ${(bestSlot.avgEngagementRate * 100).toFixed(1)}% 表现最佳（${bestSlot.postCount} 篇样本）`,
        magnitude: 0.15,
        expectedOutcome: '集中在该时段发布以提高初始曝光和互动',
      })
    }

    // 如果没有足够的类别数据，补充通用推荐
    if (recommendedTopics.length === 0) {
      recommendedTopics.push('技术深度解析', '实战经验总结', '开发工具与效率')
    }

    // 如果 plannedTopics 中有未在推荐列表中的，保留高潜力的
    if (plannedTopics) {
      for (const topic of plannedTopics) {
        if (!recommendedTopics.includes(topic) && !avoidTopics.includes(topic)) {
          const matchingCat = report.categorySummary.find(
            (c) => topic.toLowerCase().includes(c.category.toLowerCase()),
          )
          if (matchingCat && matchingCat.performanceScore >= 0.5) {
            recommendedTopics.push(topic)
          }
        }
      }
      // 保持最多 5 个推荐
      while (recommendedTopics.length > 5) recommendedTopics.pop()
    }

    return {
      timestamp: Date.now(),
      dataDriven: true,
      recommendedTopics,
      adjustments,
      avoidTopics,
      summary: this.buildStrategySummary(
        recommendedTopics,
        avoidTopics,
        adjustments,
        report,
      ),
    }
  }

  // ===========================================================================
  // 私有方法 — 数据聚合
  // ===========================================================================

  /**
   * 按类别汇总表现
   */
  private buildCategorySummary(posts: PostPerformance[]): CategoryPerformanceSummary[] {
    const categoryMap = new Map<string, PostPerformance[]>()

    for (const post of posts) {
      const category = this.extractCategory(post.title)
      const existing = categoryMap.get(category) ?? []
      existing.push(post)
      categoryMap.set(category, existing)
    }

    const summaries: CategoryPerformanceSummary[] = []

    for (const [category, categoryPosts] of categoryMap) {
      if (categoryPosts.length < 1) continue

      const totalEngagements = categoryPosts.reduce(
        (sum, p) => sum + p.likes + p.comments + p.shares,
        0,
      )
      const avgViews = this.average(categoryPosts.map((p) => p.views))
      const avgEngagementRate = this.average(categoryPosts.map((p) => p.engagementRate))

      // 综合表现评分
      const normalizedViews = Math.min(1, avgViews / 1000)
      const performanceScore =
        normalizedViews * VIEWS_WEIGHT +
        avgEngagementRate * ENGAGEMENT_WEIGHT +
        Math.min(1, categoryPosts.length / 10) * RECENCY_WEIGHT

      summaries.push({
        category,
        postCount: categoryPosts.length,
        avgViews: Math.round(avgViews),
        avgEngagementRate: Math.round(avgEngagementRate * 10000) / 10000,
        totalEngagements,
        performanceScore: Math.round(performanceScore * 100) / 100,
      })
    }

    // 按表现评分降序
    return summaries.sort((a, b) => b.performanceScore - a.performanceScore)
  }

  /**
   * 按平台汇总表现
   */
  private buildPlatformPerformance(posts: PostPerformance[]): PlatformPerformance[] {
    const platformMap = new Map<string, PostPerformance[]>()

    for (const post of posts) {
      const existing = platformMap.get(post.platform) ?? []
      existing.push(post)
      platformMap.set(post.platform, existing)
    }

    const performances: PlatformPerformance[] = []

    for (const [platform, platformPosts] of platformMap) {
      if (platformPosts.length < 1) continue

      const totalViews = platformPosts.reduce((sum, p) => sum + p.views, 0)
      const avgViews = this.average(platformPosts.map((p) => p.views))
      const avgEngagementRate = this.average(platformPosts.map((p) => p.engagementRate))

      performances.push({
        platform,
        postCount: platformPosts.length,
        avgViews: Math.round(avgViews),
        avgEngagementRate: Math.round(avgEngagementRate * 10000) / 10000,
        totalViews,
      })
    }

    // 按平均互动率降序
    return performances.sort((a, b) => b.avgEngagementRate - a.avgEngagementRate)
  }

  /**
   * 按发布时段分析效果
   */
  private buildTimeSlotAnalysis(posts: PostPerformance[]): TimeSlotPerformance[] {
    const hourMap = new Map<number, PostPerformance[]>()

    for (const post of posts) {
      const existing = hourMap.get(post.publishHour) ?? []
      existing.push(post)
      hourMap.set(post.publishHour, existing)
    }

    const slots: TimeSlotPerformance[] = []

    for (const [hour, hourPosts] of hourMap) {
      if (hourPosts.length < 1) continue

      const avgViews = this.average(hourPosts.map((p) => p.views))
      const avgEngagementRate = this.average(hourPosts.map((p) => p.engagementRate))

      // 综合评分
      const normalizedViews = Math.min(1, avgViews / 1000)
      const score =
        normalizedViews * VIEWS_WEIGHT +
        avgEngagementRate * ENGAGEMENT_WEIGHT +
        Math.min(1, hourPosts.length / 10) * RECENCY_WEIGHT

      slots.push({
        hour,
        avgViews: Math.round(avgViews),
        avgEngagementRate: Math.round(avgEngagementRate * 10000) / 10000,
        postCount: hourPosts.length,
        score: Math.round(score * 100) / 100,
      })
    }

    return slots.sort((a, b) => b.score - a.score).slice(0, 5)
  }

  // ===========================================================================
  // 私有方法 — 洞察生成
  // ===========================================================================

  private generateInsights(
    posts: PostPerformance[],
    categorySummary: CategoryPerformanceSummary[],
    platformPerformance: PlatformPerformance[],
    bestTimeSlots: TimeSlotPerformance[],
  ): string[] {
    const insights: string[] = []

    // 1. 总体表现
    const totalViews = posts.reduce((s, p) => s + p.views, 0)
    const totalEngagements = posts.reduce((s, p) => s + p.likes + p.comments + p.shares, 0)
    const overallEngagement = posts.length > 0
      ? totalEngagements / posts.length
      : 0

    insights.push(
      `累计发布 ${posts.length} 篇文章，总阅读 ${totalViews}，平均每篇文章互动 ${overallEngagement.toFixed(1)} 次`,
    )

    // 2. 最佳类别和平台
    if (categorySummary.length > 0) {
      const top = categorySummary[0]
      insights.push(
        `表现最好的主题类别是「${top.category}」（${top.postCount} 篇，平均阅读 ${top.avgViews}）`,
      )
    }

    if (platformPerformance.length >= MIN_PLATFORMS_FOR_COMPARISON) {
      const best = platformPerformance[0]
      insights.push(
        `${best.platform} 的互动率最高（${(best.avgEngagementRate * 100).toFixed(1)}%），建议作为内容分发重点`,
      )
    }

    // 3. 时段建议
    if (bestTimeSlots.length > 0) {
      const best = bestTimeSlots[0]
      insights.push(
        `最佳发布时段为 ${best.hour}:00（平均互动率 ${(best.avgEngagementRate * 100).toFixed(1)}%），建议优先选择该时段发布`,
      )
    }

    // 4. 改进建议
    const lowEngagementPosts = posts.filter((p) => p.engagementRate < 0.01)
    if (lowEngagementPosts.length > posts.length * 0.3) {
      insights.push(
        `${lowEngagementPosts.length} 篇文章互动率偏低（<1%），建议优化标题吸引力和内容开头段落`,
      )
    }

    return insights
  }

  /**
   * 从文章标题中提取类别关键词
   */
  private extractCategory(title: string): string {
    const patterns: Array<{ category: string; patterns: RegExp[] }> = [
      {
        category: '技术教程',
        patterns: [/教程|指南|入门|上手|快速开始|how.to|tutorial|guide|getting.started/i],
      },
      {
        category: '架构设计',
        patterns: [/架构|设计模式|系统设计|微服务|分布式|架构设计/i],
      },
      {
        category: '源码分析',
        patterns: [/源码|源代码|原理|实现|under.the.hood|internals|deep.dive/i],
      },
      {
        category: '性能优化',
        patterns: [/性能|优化|调优|Benchmark|高并发|高可用|性能测试/i],
      },
      {
        category: '工具推荐',
        patterns: [/工具|推荐|评测|对比|vs|alternative|好用|利器|效率/i],
      },
      {
        category: '经验分享',
        patterns: [/经验|心得|踩坑|避坑|总结|回顾|反思|教训|实践/i],
      },
      {
        category: '产品介绍',
        patterns: [/发布|更新|新功能|特性|版本|release|changelog|roadmap/i],
      },
    ]

    for (const { category, patterns } of patterns) {
      for (const p of patterns) {
        if (p.test(title)) return category
      }
    }

    return '其他'
  }

  /**
   * 构建策略摘要文本
   */
  private buildStrategySummary(
    recommendedTopics: string[],
    avoidTopics: string[],
    adjustments: StrategyAdjustment[],
    report: AnalyticsReport,
  ): string {
    const lines: string[] = [
      '📊 选题策略调整报告',
      `基于 ${report.totalPosts} 篇文章的效果数据`,
      '',
    ]

    if (recommendedTopics.length > 0) {
      lines.push('✅ 建议加大投入的选题：')
      for (const t of recommendedTopics) {
        const adj = adjustments.find((a) => a.topic === t)
        if (adj) {
          lines.push(`  - ${t}（${adj.reason}）`)
        } else {
          lines.push(`  - ${t}`)
        }
      }
      lines.push('')
    }

    if (avoidTopics.length > 0) {
      lines.push('❌ 建议减少/避免的选题：')
      for (const t of avoidTopics) {
        const adj = adjustments.find((a) => a.topic === t)
        lines.push(`  - ${t}${adj ? `（${adj.reason}）` : ''}`)
      }
      lines.push('')
    }

    if (report.bestTimeSlots.length > 0) {
      const best = report.bestTimeSlots[0]
      lines.push(`⏰ 最佳发布时段：${best.hour}:00（互动率 ${(best.avgEngagementRate * 100).toFixed(1)}%）`)
    }

    return lines.join('\n')
  }

  // ===========================================================================
  // 工具方法
  // ===========================================================================

  private average(values: number[]): number {
    if (values.length === 0) return 0
    return values.reduce((a, b) => a + b, 0) / values.length
  }

  // ===========================================================================
  // 持久化
  // ===========================================================================

  /**
   * 从持久化存储加载（当前为 localStorage 模拟，后续可对接正式存储）
   */
  private loadFromMemory(): void {
    try {
      // 使用全局存储（后续对接 MemoryService）
      const stored = (globalThis as any).__blogAnalyticsCache
      if (Array.isArray(stored)) {
        this.posts = stored
      }
    } catch {
      this.posts = []
    }
  }

  /**
   * 保存到持久化存储
   */
  private saveToMemory(): void {
    try {
      (globalThis as any).__blogAnalyticsCache = this.posts
    } catch {
      // 非关键路径
    }
  }
}

// =============================================================================
// 全局单例
// =============================================================================

export const blogAnalyticsTracker = new BlogAnalyticsTracker()
