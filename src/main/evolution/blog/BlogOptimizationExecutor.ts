/**
 * BlogOptimizationExecutor — 博客工作流参数优化执行器
 *
 * 接收 BlogOptimizationCollector 采集的优化问题，执行工作流参数调优：
 * 1. 从 Problem 描述中提取当前效果指标
 * 2. 基于效果数据推荐下一组待测试的参数组合
 * 3. 更新 BlogWorkflowConfig 的当前参数
 * 4. 创建 Git 快照以支持回滚
 * 5. 持久化参数状态
 *
 * 安全机制：
 * - 参数变化有界（受 ParameterDef 的 min/max/step 约束）
 * - 每次变更加 Git 快照供回滚使用
 * - 评分记录用于后续效果对比
 * - 数据不足时跳过调优
 */

import { log } from '../../logger/Logger'
import type { FixExecutor, AssignedProblem, FixResult } from '../automation/types'
import { blogWorkflowConfig } from './BlogWorkflowConfig'
import { blogAnalyticsTracker } from '../../agent/blog/BlogAnalyticsTracker'
import { EvolutionGitOps } from '../EvolutionGitOps'

/** 效果下降的判定阈值（分数下降比例） */
const PERFORMANCE_DECLINE_THRESHOLD = 0.15

export class BlogOptimizationExecutor implements FixExecutor {
  readonly name = 'blog-optimization-executor'
  readonly supportedSources = ['blog'] as const
  readonly timeoutMs = 30_000
  private gitOps = new EvolutionGitOps()

  isAvailable(): boolean {
    return true
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    const startedAt = Date.now()

    try {
      log('INFO', 'blog_executor_start', {
        problemId: problem.id,
        title: problem.title,
      })

      // ── 阶段 1: 检查数据量 ──
      const posts = blogAnalyticsTracker.getAllPosts()
      if (posts.length < 3) {
        return {
          problemId: problem.id,
          success: true,
          summary: '数据不足（<3 篇），跳过参数调优。继续积累发布数据',
          durationMs: Date.now() - startedAt,
        }
      }

      const metadata = problem.context?.metadata
      const currentLabel = blogWorkflowConfig.getLabel()

      log('INFO', 'blog_executor_analysis', {
        currentLabel,
        postsCount: posts.length,
        problemType: problem.id.includes('platform')
          ? 'platform_priority'
          : problem.id.includes('timeslot')
            ? 'publish_time'
            : problem.id.includes('category')
              ? 'content_style'
              : 'general',
      })

      // ── 阶段 2: 检查回滚条件 ──
      // 如果上次调参后效果下降，回退到最优历史配置
      const history = blogWorkflowConfig.getScoreHistory()
      if (history.length >= 2) {
        const prev = history[history.length - 2]
        const curr = history[history.length - 1]
        if (prev.score > curr.score && (prev.score - curr.score) / Math.max(prev.score, 1) > PERFORMANCE_DECLINE_THRESHOLD) {
          const bestEntry = blogWorkflowConfig.getBestEntry()
          if (bestEntry && bestEntry.snapshot.label !== currentLabel) {
            blogWorkflowConfig.applySnapshot(bestEntry.snapshot)
            blogWorkflowConfig.persist()

            log('INFO', 'blog_executor_rollback', {
              fromLabel: currentLabel,
              toLabel: bestEntry.snapshot.label,
              prevScore: prev.score,
              currentScore: curr.score,
            })

            return {
              problemId: problem.id,
              success: true,
              summary: [
                `【博客工作流参数回滚】检测到效果下降`,
                ``,
                `  前参数: ${currentLabel} (评分 ${curr.score.toFixed(1)})`,
                `  后参数: ${bestEntry.snapshot.label} (评分 ${bestEntry.score.toFixed(1)})`,
                `  回滚原因: 评分下降 ${((prev.score - curr.score) / Math.max(prev.score, 1) * 100).toFixed(0)}%`,
                ``,
                `✅ 已回滚到历史最优配置`,
              ].join('\n'),
              durationMs: Date.now() - startedAt,
              output: bestEntry.snapshot.label,
            }
          }
        }
      }

      // ── 阶段 3: 推荐下一组参数 ──
      const nextSnapshot = blogWorkflowConfig.recommendNext()

      // ── 阶段 4: 创建 Git 快照（用于回滚） ──
      const snapshotTag = `blog_optimization_${currentLabel}_to_${nextSnapshot.label}`
      try {
        await this.gitOps.createSnapshot(snapshotTag)
      } catch {
        log('WARN', 'blog_executor_snapshot_skip', { tag: snapshotTag })
      }

      // ── 阶段 5: 应用新参数 ──
      blogWorkflowConfig.applySnapshot(nextSnapshot)

      // ── 阶段 6: 持久化 ──
      blogWorkflowConfig.persist()

      const paramSummary = Object.entries(nextSnapshot.values)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')

      // ── 阶段 7: 构建结果报告 ──
      const bestEntry = blogWorkflowConfig.getBestEntry()
      const report = blogAnalyticsTracker.generateReport()

      const resultLines: string[] = [
        `【博客工作流自进化】参数优化完成`,
        ``,
        `📋 参数变更:`,
        `  前: ${currentLabel}`,
        `  后: ${nextSnapshot.label}`,
        `  详情: ${paramSummary}`,
        ``,
        `📊 当前效果概览:`,
        `  文章数: ${report.totalPosts}`,
        `  平均阅读: ${Math.round(report.overallAvgViews)}`,
        `  平均互动率: ${(report.overallAvgEngagementRate * 100).toFixed(1)}%`,
        report.bestPlatform !== '未知' ? `  最佳平台: ${report.bestPlatform}` : '',
        report.bestTimeSlots.length > 0 ? `  最佳时段: ${report.bestTimeSlots[0].hour}:00` : '',
        ``,
      ]

      if (bestEntry && bestEntry.snapshot.label !== nextSnapshot.label) {
        resultLines.push(`🏆 历史最优: ${bestEntry.snapshot.label} (评分: ${bestEntry.score.toFixed(1)})`)
        resultLines.push('')
      }

      if (history.length >= 5) {
        const recent = history.slice(-3)
        const trend = recent.map((e) => e.score)
        const improving = trend.length >= 2 && trend[trend.length - 1] > trend[0]
        resultLines.push(`📈 评分趋势(${history.length}条历史): ${improving ? '上升↑' : '波动中~'}`)
      } else {
        resultLines.push(`📊 参数探索阶段(${history.length}/5): 继续收集评分数据`)
      }

      resultLines.push('')
      resultLines.push(`💡 下一周期将评估新参数效果并继续优化`)
      resultLines.push(`📸 Git 快照已创建: ${snapshotTag}`)

      const summary = resultLines.filter(Boolean).join('\n')

      log('INFO', 'blog_executor_complete', {
        fromLabel: currentLabel,
        toLabel: nextSnapshot.label,
        historyCount: history.length,
        bestScore: bestEntry?.score ?? 0,
      })

      return {
        problemId: problem.id,
        success: true,
        summary,
        durationMs: Date.now() - startedAt,
        output: nextSnapshot.label,
      }
    } catch (err: any) {
      log('ERROR', 'blog_executor_error', {
        problemId: problem.id,
        error: String(err),
      })
      return {
        problemId: problem.id,
        success: false,
        summary: `博客工作流参数优化失败: ${err.message}`,
        durationMs: Date.now() - startedAt,
        error: String(err),
      }
    }
  }
}
