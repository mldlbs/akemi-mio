/**
 * MergeEngineCollector — 自进化合并引擎采集器
 *
 * 作为 SignalCollector 接入进化自动化管道：
 * 1. 按进化周期（2h）触发合并分析
 * 2. 调用 MergeAnalyzer 扫描代码
 * 3. 调用 MergePlanGenerator 生成计划
 * 4. 将合并缺口作为 Problem 推送到 ProblemQueue
 * 5. 由 MergeEngine（作为 FixExecutor）消费
 *
 * 遵循现有 Collector 契约模式。
 */

import { log } from '../../logger/Logger'
import { MergeAnalyzer } from './MergeAnalyzer'
import { MergePlanGenerator } from './MergePlanGenerator'
import type { SignalCollector, Problem, ProblemSource } from '../automation/types'

// ═══════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════

/** 最小采集间隔（与进化周期对齐） */
const COLLECT_INTERVAL_MS = 2 * 60 * 60 * 1000

/** 单次最大问题数 */
const MAX_PROBLEMS_PER_RUN = 5

/** 来源类型 */
const SOURCE: ProblemSource = 'tool' as ProblemSource

// ═══════════════════════════════════════════
// MergeEngineCollector
// ═══════════════════════════════════════════

export class MergeEngineCollector implements SignalCollector {
  readonly name = 'merge-engine-collector'
  readonly source = SOURCE

  private lastCollectAt = 0
  private analyzer: MergeAnalyzer
  private planGenerator: MergePlanGenerator

  constructor() {
    this.analyzer = new MergeAnalyzer()
    this.planGenerator = new MergePlanGenerator()
  }

  /** 获取分析器实例 */
  getAnalyzer(): MergeAnalyzer {
    return this.analyzer
  }

  /** 获取计划生成器实例 */
  getPlanGenerator(): MergePlanGenerator {
    return this.planGenerator
  }

  /**
   * 判断是否需要运行。
   * 每 2 小时运行一次（与进化周期对齐）。
   */
  shouldRun(): boolean {
    return Date.now() - this.lastCollectAt >= COLLECT_INTERVAL_MS
  }

  /**
   * 执行一次合并分析采集。
   * 1. 扫描代码识别合并缺口
   * 2. 生成合并计划
   * 3. 将缺口转为 Problem 返回
   */
  async collect(): Promise<Problem[]> {
    this.lastCollectAt = Date.now()
    const startedAt = Date.now()

    log('INFO', 'merge_collect_start')

    try {
      // 1. 执行代码扫描
      const scanResult = await this.analyzer.scan()

      if (scanResult.gaps.length === 0) {
        log('INFO', 'merge_collect_no_gaps', {
          integrationScore: scanResult.integrationScore,
        })
        return []
      }

      // 2. 生成合并计划
      const plan = this.planGenerator.generatePlan(scanResult)

      if (plan.status === 'no_gaps') {
        log('INFO', 'merge_collect_no_new_gaps')
        return []
      }

      // 3. 将计划中的缺口转为 Problem
      const problems: Problem[] = []
      for (const gap of plan.gaps) {
        const gapTypeLabel: Record<string, string> = {
          route_missing: '路由缺失',
          event_handler_missing: '事件处理缺失',
          periodic_task_missing: '定时任务缺失',
          function_integration: '函数集成',
          type_alignment: '类型对齐',
          safety_check_missing: '安全检查缺失',
          dependency_missing: '依赖缺失',
        }

        const typeLabel = gapTypeLabel[gap.type] || gap.type
        const severity = gap.priority >= 4 ? 'error' : gap.priority >= 3 ? 'warning' : 'info'

        problems.push({
          id: `merge_${gap.id}`,
          source: SOURCE,
          severity: severity as any,
          title: `[合并] ${typeLabel}: ${gap.description.slice(0, 80)}`,
          description: gap.description,
          file: gap.targetFile,
          estimatedCostChars: gap.estimatedChanges.length * 60,
          lastSeen: Date.now(),
          occurrenceCount: 1,
          context: {
            raw: gap.context,
            metadata: {
              gap_id: gap.id,
              gap_type: gap.type,
              source_module: gap.sourceModule,
              priority: String(gap.priority),
              plan_id: plan.id,
            },
          },
        })
      }

      log('INFO', 'merge_collect_done', {
        gaps: problems.length,
        totalScanGaps: scanResult.gaps.length,
        integrationScore: scanResult.integrationScore,
        durationMs: Date.now() - startedAt,
      })

      return problems.slice(0, MAX_PROBLEMS_PER_RUN)
    } catch (err: any) {
      log('ERROR', 'merge_collect_error', { error: err.message })
      return []
    }
  }
}
