/**
 * MergePlanGenerator — 合并计划生成器
 *
 * 消费 MergeAnalyzer 的扫描结果，生成结构化的合并计划。
 * 计划的每个缺口对应一个可执行的补丁任务。
 *
 * 输出 MergePlan，供 MergePatchExecutor 消费。
 */

import { log } from '../../logger/Logger'
import type { MergeGap, MergePlan, MergeScanResult, MergePlanStatus } from './types'

// ═══════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════

/** 优先级阈值：超过此值视为高优先级缺口 */
const HIGH_PRIORITY_THRESHOLD = 4

/** 单次计划最大缺口数 */
const MAX_GAPS_PER_PLAN = 5

// ═══════════════════════════════════════════
// MergePlanGenerator
// ═══════════════════════════════════════════

export class MergePlanGenerator {
  readonly name = 'merge-plan-generator'

  private currentPlan: MergePlan | null = null
  private gapCache = new Map<string, boolean>() // gapId → alreadyAttempted

  /** 获取当前计划 */
  getCurrentPlan(): MergePlan | null {
    return this.currentPlan
  }

  /** 标记缺口已尝试（防止重复计划） */
  markGapAttempted(gapId: string): void {
    this.gapCache.set(gapId, true)
  }

  /** 清除缓存 */
  clearCache(): void {
    this.gapCache.clear()
    this.currentPlan = null
  }

  /**
   * 根据扫描结果生成合并计划。
   *
   * 策略：
   * 1. 高优先级缺口优先（safety > route > event > function）
   * 2. 每个计划包含最多 MAX_GAPS_PER_PLAN 个缺口
   * 3. 跳过已尝试过的缺口
   */
  generatePlan(scanResult: MergeScanResult): MergePlan {
    // 过滤已尝试的缺口
    const newGaps = scanResult.gaps.filter(g => !this.gapCache.has(g.id))

    if (newGaps.length === 0) {
      const plan: MergePlan = {
        id: `merge_plan_noop_${Date.now()}`,
        gaps: [],
        createdAt: Date.now(),
        status: 'no_gaps',
        summary: '扫描未发现新的合并缺口，无需操作',
      }
      this.currentPlan = plan
      return plan
    }

    // 优先级排序：安全 > 路由 > 事件 > 函数集成
    const priorityOrder: Record<string, number> = {
      safety_check_missing: 5,
      route_missing: 4,
      event_handler_missing: 4,
      periodic_task_missing: 3,
      function_integration: 2,
      type_alignment: 2,
      dependency_missing: 3,
    }

    const sorted = [...newGaps].sort((a, b) => {
      const pa = priorityOrder[a.type] || 1
      const pb = priorityOrder[b.type] || 1
      if (pa !== pb) return pb - pa
      return b.priority - a.priority
    })

    const planGaps = sorted.slice(0, MAX_GAPS_PER_PLAN)
    const highCount = planGaps.filter(g => g.priority >= HIGH_PRIORITY_THRESHOLD).length

    const summary = planGaps.length === 0
      ? '所有合并缺口已处理'
      : `发现 ${scanResult.gaps.length} 个合并缺口（${highCount} 个高优先级），计划处理前 ${planGaps.length} 个`

    const plan: MergePlan = {
      id: `merge_plan_${Date.now()}`,
      gaps: planGaps,
      createdAt: Date.now(),
      status: 'pending',
      summary,
    }

    this.currentPlan = plan

    log('INFO', 'merge_plan_generated', {
      planId: plan.id,
      gaps: planGaps.length,
      totalGaps: scanResult.gaps.length,
      highPriority: highCount,
      integrationScore: scanResult.integrationScore,
    })

    return plan
  }

  /**
   * 更新计划状态。
   */
  updatePlanStatus(status: MergePlanStatus): void {
    if (this.currentPlan) {
      this.currentPlan.status = status
    }
  }

  /**
   * 基于扫描失败生成降级计划（当全量扫描不可用时）。
   */
  generateFallbackPlan(errorMessage: string): MergePlan {
    log('WARN', 'merge_plan_fallback', { error: errorMessage })

    const plan: MergePlan = {
      id: `merge_plan_fallback_${Date.now()}`,
      gaps: [],
      createdAt: Date.now(),
      status: 'failed',
      summary: `扫描分析失败: ${errorMessage}，跳过本轮合并`,
    }
    this.currentPlan = plan
    return plan
  }
}
