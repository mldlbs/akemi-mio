/**
 * BlogOptimizationCollector — 博客工作流优化采集器
 *
 * 作为自动化管道中的 Collector，采集博客发布效果数据。
 * 每次运行从 BlogAnalyticsTracker 获取已登记的效果数据，
 * 分析平台表现、发布时段、内容风格的效果差异，
 * 生成优化 Problem 供 BlogOptimizationExecutor 消费。
 *
 * 工作流：
 *   1. 读取 BlogAnalyticsTracker 的已登记效果数据
 *   2. 分析是否存在优化空间（数据量是否足够、趋势是否下降）
 *   3. 如果系统检测到可优化机会，生成对应的 Problem
 *   4. Problem 被 Pipeline 捕获 → BlogOptimizationExecutor 执行参数优化
 *
 * 安全机制：
 * - 最小运行间隔：30 分钟
 * - 数据量低于 3 条时不生成优化问题
 * - 生成的问题需要后续效果验证
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { SignalCollector, Problem } from '@akemi-mio/evolution/automation/types'
import { blogAnalyticsTracker } from '@akemi-mio/intelligence/agent/blog/BlogAnalyticsTracker'
import type { AnalyticsReport } from '@akemi-mio/intelligence/agent/blog/types'
import { blogWorkflowConfig } from './BlogWorkflowConfig'

/** 最小运行间隔：30 分钟 */
const MIN_INTERVAL_MS = 30 * 60 * 1000

/** 触发优化所需的最小文章数 */
const MIN_POSTS_FOR_OPTIMIZATION = 3

/** 表现下降触发优化的阈值 */
const DECLINE_THRESHOLD = 0.15

export class BlogOptimizationCollector implements SignalCollector {
  readonly name = 'blog-optimization-collector'
  readonly source = 'blog' as const

  private lastRun = 0

  shouldRun(): boolean {
    if (Date.now() - this.lastRun < MIN_INTERVAL_MS) return false
    return true
  }

  async collect(): Promise<Problem[]> {
    this.lastRun = Date.now()
    const problems: Problem[] = []

    try {
      const posts = blogAnalyticsTracker.getAllPosts()

      if (posts.length === 0) {
        log('INFO', 'blog_collector_no_data')
        return []
      }

      log('INFO', 'blog_collector_data_available', {
        postCount: posts.length,
        platforms: [...new Set(posts.map((p) => p.platform))],
      })

      // 生成分析报告
      const report = blogAnalyticsTracker.generateReport()

      // 获取当前参数配置
      const paramContext = blogWorkflowConfig.formatForPrompt()

      // 记录评分到参数空间
      this.recordPerformanceScore(report)

      // 检查数据量是否足够
      if (!report.hasSufficientData) {
        log('INFO', 'blog_collector_insufficient_data', {
          posts: posts.length,
          minRequired: MIN_POSTS_FOR_OPTIMIZATION,
        })
        return []
      }

      // ── 生成优化问题 ──

      // 1. 平台表现差异问题：如果平台间表现差异大，建议调整平台优先级
      if (report.platformPerformance.length >= 2) {
        const best = report.platformPerformance[0]
        const worst = report.platformPerformance[report.platformPerformance.length - 1]
        const gap = best.avgEngagementRate - worst.avgEngagementRate

        if (gap > 0.03 && worst.postCount >= 1) {
          problems.push({
            id: `blog:platform:gap:${Date.now()}`,
            source: 'blog',
            severity: 'info',
            title: `平台效果差异：${best.platform} 互动率 ${(best.avgEngagementRate * 100).toFixed(1)}% vs ${worst.platform} ${(worst.avgEngagementRate * 100).toFixed(1)}%`,
            description: [
              `平台间效果存在明显差异，建议优化平台优先级策略。`,
              ``,
              `表现最好的平台：${best.platform}`,
              `  平均阅读: ${best.avgViews} | 互动率: ${(best.avgEngagementRate * 100).toFixed(1)}% (${best.postCount}篇)`,
              `表现最差的平台：${worst.platform}`,
              `  平均阅读: ${worst.avgViews} | 互动率: ${(worst.avgEngagementRate * 100).toFixed(1)}% (${worst.postCount}篇)`,
              `差距: ${(gap * 100).toFixed(1)}% 互动率`,
              ``,
              `建议调整 platform_priority 参数以优先发布到 ${best.platform}`,
              ``,
              `当前参数:\n${paramContext}`,
            ].join('\n'),
            estimatedCostChars: 1500,
            lastSeen: Date.now(),
            occurrenceCount: 1,
            context: {
              raw: `blog_platform_gap:${best.platform}_vs_${worst.platform}`,
              metadata: {
                bestPlatform: best.platform,
                bestEngagementRate: best.avgEngagementRate.toFixed(4),
                worstPlatform: worst.platform,
                gapPercent: (gap * 100).toFixed(1),
                totalPosts: String(posts.length),
              },
            },
          })
        }
      }

      // 2. 发布时段优化问题：如果有最佳时段建议，优化 publish_hour 参数
      if (report.bestTimeSlots.length >= 2) {
        const bestSlot = report.bestTimeSlots[0]
        const worstSlot = report.bestTimeSlots[report.bestTimeSlots.length - 1]
        const hourGap = bestSlot.avgEngagementRate - worstSlot.avgEngagementRate

        if (hourGap > 0.02 && bestSlot.postCount >= 1) {
          problems.push({
            id: `blog:timeslot:gap:${Date.now()}`,
            source: 'blog',
            severity: 'info',
            title: `最佳发布时段：${bestSlot.hour}:00 互动率 ${(bestSlot.avgEngagementRate * 100).toFixed(1)}%`,
            description: [
              `不同发布时段的效果差异明显，建议调整发布时段参数。`,
              ``,
              `最佳时段: ${bestSlot.hour}:00`,
              `  平均阅读: ${bestSlot.avgViews} | 互动率: ${(bestSlot.avgEngagementRate * 100).toFixed(1)}% (${bestSlot.postCount}篇样本)`,
              `当前配置发布时段: ${blogWorkflowConfig.getParameter('publish_hour')?.currentValue}:00`,
              ``,
              `建议调整 publish_hour 参数至 ${bestSlot.hour}:00 附近`,
              ``,
              `当前参数:\n${paramContext}`,
            ].join('\n'),
            estimatedCostChars: 1200,
            lastSeen: Date.now(),
            occurrenceCount: 1,
            context: {
              raw: `blog_timeslot_optimal:${bestSlot.hour}`,
              metadata: {
                bestHour: String(bestSlot.hour),
                bestEngagementRate: bestSlot.avgEngagementRate.toFixed(4),
                currentHour: String(blogWorkflowConfig.getParameter('publish_hour')?.currentValue ?? ''),
                totalPosts: String(posts.length),
              },
            },
          })
        }
      }

      // 3. 内容风格优化问题：如果某类别表现突出，调整内容风格参数
      if (report.categorySummary.length >= 2) {
        const topCat = report.categorySummary[0]
        const bottomCat = report.categorySummary[report.categorySummary.length - 1]
        const catGap = topCat.performanceScore - bottomCat.performanceScore

        if (catGap > 0.2 && topCat.postCount >= 1) {
          // 将类别映射到内容风格
          const categoryToStyle: Record<string, string> = {
            技术教程: 'tutorial',
            架构设计: 'tutorial',
            源码分析: 'tutorial',
            性能优化: 'tutorial',
            工具推荐: 'review',
            经验分享: 'opinion',
            产品介绍: 'news',
          }
          const suggestedStyle = categoryToStyle[topCat.category] || 'mixed'

          problems.push({
            id: `blog:category:top:${Date.now()}`,
            source: 'blog',
            severity: 'info',
            title: `最佳内容类别：「${topCat.category}」表现评分 ${(topCat.performanceScore * 100).toFixed(0)}/100`,
            description: [
              `内容类别效果差异明显，建议调整内容风格偏好。`,
              ``,
              `最佳类别: ${topCat.category}`,
              `  评分: ${(topCat.performanceScore * 100).toFixed(0)}/100 | 平均阅读: ${topCat.avgViews} | 互动率: ${(topCat.avgEngagementRate * 100).toFixed(1)}%`,
              `建议内容风格: ${suggestedStyle}`,
              `当前内容风格: ${blogWorkflowConfig.getParameter('content_style')?.currentValue ?? 'mixed'}`,
              ``,
              `当前参数:\n${paramContext}`,
            ].join('\n'),
            estimatedCostChars: 1200,
            lastSeen: Date.now(),
            occurrenceCount: 1,
            context: {
              raw: `blog_category_top:${topCat.category}`,
              metadata: {
                topCategory: topCat.category,
                topScore: String((topCat.performanceScore * 100).toFixed(0)),
                suggestedStyle,
                currentStyle: String(blogWorkflowConfig.getParameter('content_style')?.currentValue ?? ''),
                totalPosts: String(posts.length),
              },
            },
          })
        }
      }

      // 4. 综合优化问题：当有足够数据但尚未调参时，生成综合优化问题
      if (problems.length === 0 && posts.length >= MIN_POSTS_FOR_OPTIMIZATION) {
        const bestPlatform = report.bestPlatform !== '未知' ? report.bestPlatform : undefined
        const bestSlot = report.bestTimeSlots.length > 0 ? report.bestTimeSlots[0] : undefined

        problems.push({
          id: `blog:optimization:general:${Date.now()}`,
          source: 'blog',
          severity: 'info',
          title: `博客工作流参数调优机会（${posts.length} 篇文章数据）`,
          description: [
            `已有 ${posts.length} 篇文章的效果数据，可以进行工作流参数调优。`,
            ``,
            `当前效果概览:`,
            `  平均阅读: ${Math.round(report.overallAvgViews)}`,
            `  平均互动率: ${(report.overallAvgEngagementRate * 100).toFixed(1)}%`,
            bestPlatform ? `  最佳平台: ${bestPlatform}` : '',
            bestSlot ? `  最佳时段: ${bestSlot.hour}:00` : '',
            ``,
            `建议启动参数探索以优化发布策略。`,
            ``,
            `当前参数:\n${paramContext}`,
          ]
            .filter(Boolean)
            .join('\n'),
          estimatedCostChars: 1000,
          lastSeen: Date.now(),
          occurrenceCount: 1,
          context: {
            raw: `blog_optimization_ready:${posts.length}_posts`,
            metadata: {
              totalPosts: String(posts.length),
              avgViews: String(Math.round(report.overallAvgViews)),
              avgEngagementRate: report.overallAvgEngagementRate.toFixed(4),
              bestPlatform: bestPlatform || 'unknown',
              bestHour: bestSlot ? String(bestSlot.hour) : 'unknown',
            },
          },
        })
      }

      log('INFO', 'blog_collector_problems', {
        problemsGenerated: problems.length,
        metrics: {
          posts: posts.length,
          platforms: report.platforms.length,
          avgViews: Math.round(report.overallAvgViews),
          avgEngagement: (report.overallAvgEngagementRate * 100).toFixed(1),
        },
      })
    } catch (err: any) {
      log('ERROR', 'blog_collector_error', { error: String(err) })
    }

    return problems
  }

  /**
   * 将当前效果数据记录到参数空间的评分历史
   */
  private recordPerformanceScore(report: AnalyticsReport): void {
    blogWorkflowConfig.recordScore({
      snapshot: blogWorkflowConfig.getCurrentSnapshot(),
      score: report.hasSufficientData ? report.overallAvgEngagementRate * 100 + Math.min(report.totalPosts / 10, 10) : 0,
      dimensions: {
        engagementRate: report.overallAvgEngagementRate,
        avgViews: report.overallAvgViews,
        postCount: report.totalPosts,
      },
      sampleSize: report.totalPosts,
      timestamp: Date.now(),
    })
  }
}
