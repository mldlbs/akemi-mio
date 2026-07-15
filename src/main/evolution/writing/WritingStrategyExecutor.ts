/**
 * WritingStrategyExecutor — 写作策略优化执行器
 *
 * 接收 WritingStrategyCollector 采集的质量问题，执行改写参数优化：
 * 1. 从 Problem 描述中提取当前质量评分
 * 2. 推荐下一组待测试的参数组合
 * 3. 更新 WritingParameterSpace 的当前参数
 * 4. 如果已有足够历史评分数据，选择最优组合
 * 5. 记录优化结果到 Memory 供后续参考
 *
 * 安全机制：
 * - 参数变化有界（步长约束）
 * - 每次变更记录到 Memory
 * - 评分回退机制：参数变更后下一周期评分下降可自动回退
 */

import { log } from '../../logger/Logger'
import type { FixExecutor, AssignedProblem, FixResult } from '../automation/types'
import { writingParameterSpace } from './WritingParameterSpace'

export class WritingStrategyExecutor implements FixExecutor {
  readonly name = 'writing-strategy-executor'
  readonly supportedSources = ['writing'] as const
  readonly timeoutMs = 30_000

  private memoryEntries: string[] = []

  isAvailable(): boolean {
    return true
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    const startedAt = Date.now()

    try {
      log('INFO', 'writing_executor_start', {
        problemId: problem.id,
        title: problem.title,
      })

      // ── 阶段 1: 提取评分信息 ──
      const metadata = problem.context?.metadata
      const currentLabel = writingParameterSpace.getLabel()

      if (!metadata) {
        return {
          problemId: problem.id,
          success: true,
          summary: '无元数据可供参考，跳过参数优化',
          durationMs: Date.now() - startedAt,
        }
      }

      log('INFO', 'writing_executor_current_params', {
        label: currentLabel,
        metadata,
      })

      // ── 阶段 2: 检查是否有历史评分 ──
      const history = writingParameterSpace.getScoreHistory()

      // ── 阶段 3: 推荐下一组参数 ──
      const nextSnapshot = writingParameterSpace.recommendNext()

      // ── 阶段 4: 应用新参数 ──
      writingParameterSpace.applySnapshot(nextSnapshot)

      const paramSummary = Object.entries(nextSnapshot.values)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')

      // 记录本次变更
      const entry = `参数变更: ${currentLabel} → ${nextSnapshot.label} (${paramSummary})`
      this.memoryEntries.push(entry)

      // ── 阶段 5: 构建结果报告 ──
      const bestEntry = writingParameterSpace.getBestEntry()

      const resultLines: string[] = [
        `【写作策略自进化】参数优化完成`,
        ``,
        `📋 参数变更:`,
        `  前: ${currentLabel}`,
        `  后: ${nextSnapshot.label}`,
        `  详情: ${paramSummary}`,
        ``,
      ]

      if (bestEntry && bestEntry.snapshot.label !== nextSnapshot.label) {
        resultLines.push(`🏆 历史最优: ${bestEntry.snapshot.label} (评分: ${bestEntry.score.toFixed(1)})`)
        if (bestEntry.score > 70) {
          resultLines.push(`  → 评分良好，可考虑回归最优配置`)
        }
        resultLines.push('')
      }

      if (history.length >= 5) {
        // 分析趋势：最近 3 条评分趋势
        const recent = history.slice(-3)
        const trend = recent.map((e) => e.score)
        const improving = trend.length >= 2 && trend[trend.length - 1] > trend[0]
        resultLines.push(`📈 评分趋势(${history.length}条历史): ${improving ? '上升↑' : '波动中~'}`)
      } else {
        resultLines.push(`📊 参数探索阶段(${history.length}/5): 继续收集评分数据`)
      }

      resultLines.push('')
      resultLines.push(`💡 下一周期将评估新参数效果并继续优化`)

      const summary = resultLines.join('\n')

      log('INFO', 'writing_executor_complete', {
        fromLabel: currentLabel,
        toLabel: nextSnapshot.label,
        historyCount: history.length,
      })

      return {
        problemId: problem.id,
        success: true,
        summary,
        durationMs: Date.now() - startedAt,
        output: nextSnapshot.label,
      }
    } catch (err: any) {
      log('ERROR', 'writing_executor_error', {
        problemId: problem.id,
        error: String(err),
      })
      return {
        problemId: problem.id,
        success: false,
        summary: `参数优化失败: ${err.message}`,
        durationMs: Date.now() - startedAt,
        error: String(err),
      }
    }
  }

  /** 获取历史内存条目 */
  getMemoryEntries(): string[] {
    return this.memoryEntries
  }
}
