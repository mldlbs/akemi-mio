/**
 * EvidenceCollector — 证据采集器（Phase 1）
 *
 * 职责边界：
 *   RegressionReport → Problem[] 的纯转换层。
 *
 * 不做：
 *   - 不分析根因
 *   - 不生成 Proposal
 *   - 不调用 SelfEvolutionService
 *   - 不 emit 事件
 *   - 不访问文件系统（输入由调用方传入）
 *
 * 约束：
 *   - Collect() 是幂等的，相同 report 产生相同 Problem[]
 *   - 不维护内部状态（运行时缓存仅用于跨 tick 去重）
 *   - 不修改输入 report
 */
import { log } from '../../logger/Logger'
import type { SignalCollector, Problem, Severity, ProblemSource, EvidenceProblemType } from './types'
import type { RegressionReport } from '../../reasoning/golden/types'

// =============================================================================
// 阈值常量
// =============================================================================

const THRESHOLDS = {
  /** passRate 低于此值视为严重退化 */
  CRITICAL_PASS_RATE: 0.5,
  /** passRate 低于此值视为警告退化 */
  WARNING_PASS_RATE: 0.8,
  /** 最小置信度阈值，低于此值的退化不产生 Problem */
  MIN_CONFIDENCE: 0.3,
} as const

// =============================================================================
// EvidenceCollector
// =============================================================================

export class EvidenceCollector implements SignalCollector {
  readonly name = 'evidence-collector'
  readonly source = 'evidence' as ProblemSource

  /** 上次已处理的 report ID，用于跨 tick 去重 */
  private lastSeenReportId: string | null = null

  constructor() {
    log('INFO', 'evidence_collector_initialized')
  }

  /**
   * EvidenceCollector 不应被 scheduler tick 主动轮询。
   * 它应仅由 EvidenceBridge 在收到 report 后调用。
   * 故 shouldRun() 返回 false，避免无 report 时的空跑。
   */
  shouldRun(): boolean {
    return false
  }

  getSkipReason(): string {
    return 'passive_collector: triggered only by EvidenceBridge, never polled'
  }

  /**
   * 将 RegressionReport 转换为 Problem[]。
   * 纯函数语义：相同输入产生相同输出（幂等性由调用方保证）。
   *
   * 调用前需设置 lastSeenReportId，collect() 会检查：
   *   如果 report 的 evidenceRef 与上次相同，返回空数组（跨 tick 去重）。
   */
  async collect(): Promise<Problem[]> {
    log('WARN', 'evidence_collector_no_report', {
      hint: 'EvidenceCollector 需要由 EvidenceBridge 注入 report 后调用，不应独立运行',
    })
    return []
  }

  /**
   * 核心转换方法：RegressionReport → Problem[]。
   * 不访问文件系统，不依赖外部状态（除了 lastSeenReportId 去重）。
   */
  convert(report: RegressionReport): Problem[] {
    const evidenceRef = this.buildEvidenceRef(report)

    // 跨 tick 去重
    if (evidenceRef === this.lastSeenReportId) {
      return []
    }

    const problems: Problem[] = []
    const { summary, capability } = report

    // ── passRate 规则 ──
    if (summary.passRate < THRESHOLDS.CRITICAL_PASS_RATE) {
      problems.push(this.makeProblem({
        evidenceRef,
        evidenceType: 'critical_regression',
        severity: 'error',
        title: `关键退化：通过率 ${(summary.passRate * 100).toFixed(0)}%`,
        description: `Regression Report ${evidenceRef}：通过率 ${summary.passRate}（${summary.passed}/${summary.total}），低于阈值 ${THRESHOLDS.CRITICAL_PASS_RATE}`,
        confidence: 0.95,
        raw: `passRate: ${summary.passRate}, passed: ${summary.passed}, total: ${summary.total}, failures: ${summary.failed}`,
        metadata: { reportId: evidenceRef, executedAt: report.metadata.executedAt, commitSha: report.metadata.commit.sha },
      }))
    } else if (summary.passRate < THRESHOLDS.WARNING_PASS_RATE) {
      problems.push(this.makeProblem({
        evidenceRef,
        evidenceType: 'critical_regression',
        severity: 'warning',
        title: `通过率下降：${(summary.passRate * 100).toFixed(0)}%`,
        description: `Regression Report ${evidenceRef}：通过率 ${summary.passRate}（${summary.passed}/${summary.total}），低于警告阈值 ${THRESHOLDS.WARNING_PASS_RATE}`,
        confidence: 0.85,
        raw: `passRate: ${summary.passRate}, passed: ${summary.passed}, total: ${summary.total}, failures: ${summary.failed}`,
        metadata: { reportId: evidenceRef, executedAt: report.metadata.executedAt, commitSha: report.metadata.commit.sha },
      }))
    }

    // ── 能力退化规则：每个 regressed pattern 一个问题 ──
    for (const regressed of capability.regressed) {
      const confidence = this.calcConfidence(regressed.failedCount, regressed.totalCount)
      if (confidence < THRESHOLDS.MIN_CONFIDENCE) continue

      problems.push(this.makeProblem({
        evidenceRef,
        evidenceType: 'capability_regression',
        severity: 'warning',
        title: `能力退化：${regressed.capability}`,
        description: `"${regressed.capability}" pattern 在 ${regressed.totalCount} 个 case 中失败 ${regressed.failedCount} 个（通过率 ${(((regressed.totalCount - regressed.failedCount) / regressed.totalCount) * 100).toFixed(0)}%）`,
        confidence,
        affectedCapability: regressed.capability,
        raw: `capability: ${regressed.capability}, failedCount: ${regressed.failedCount}, totalCount: ${regressed.totalCount}, affectedCaseIds: ${regressed.affectedCaseIds.join(',')}`,
        metadata: {
          reportId: evidenceRef,
          executedAt: report.metadata.executedAt,
          commitSha: report.metadata.commit.sha,
          affectedCaseIds: regressed.affectedCaseIds.join(','),
        },
      }))
    }

    // ── 更新去重标记 ──
    if (problems.length > 0) {
      this.lastSeenReportId = evidenceRef
    }

    return problems
  }

  // =============================================================================
  // Private helpers
  // =============================================================================

  private buildEvidenceRef(report: RegressionReport): string {
    return `report_${report.metadata.executedAt}_${report.metadata.commit.sha}`
  }

  /**
   * 根据失败比例计算置信度。
   * 样本过少时降权，避免单次偶发失败触发高置信度 Problem。
   */
  private calcConfidence(failedCount: number, totalCount: number): number {
    if (totalCount === 0) return 0
    const failRate = failedCount / totalCount
    // 样本量权重：样本 >= 10 满权，少于 10 线性衰减
    const sampleWeight = Math.min(totalCount / 10, 1)
    // 置信度 = 失败率 × 样本权重，上限 0.95
    return Math.min(failRate * sampleWeight, 0.95)
  }

  private makeProblem(opts: {
    evidenceRef: string
    evidenceType: EvidenceProblemType
    severity: Severity
    title: string
    description: string
    confidence: number
    affectedCapability?: string
    raw: string
    metadata?: Record<string, string>
  }): Problem {
    return {
      id: `${opts.evidenceRef}:${opts.affectedCapability || opts.evidenceType}`,
      source: 'evidence',
      severity: opts.severity,
      title: opts.title,
      description: opts.description,
      estimatedCostChars: 0,
      lastSeen: Date.now(),
      occurrenceCount: 1,
      context: {
        raw: opts.raw,
        metadata: opts.metadata,
      },
      evidenceRef: opts.evidenceRef,
      evidenceType: opts.evidenceType,
      confidence: opts.confidence,
      affectedCapability: opts.affectedCapability,
    }
  }
}
