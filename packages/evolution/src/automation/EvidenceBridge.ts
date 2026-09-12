/**
 * EvidenceBridge — Phase 2: Evidence Report → Event 桥接器
 *
 * 职责边界：
 *   RegressionReport → EventBus.emit('evidence.report.ready')
 *
 * 不做：
 *   - 不 import SelfEvolutionService
 *   - 不调用 ProblemQueue
 *   - 不创建 Problem
 *   - 不调用 EvidenceCollector
 *   - 不修改 Evolution pipeline
 *
 * 设计约束：
 *   - 无状态：不缓存 report，emit 结束后不做任何操作
 *   - 无消费者安全：EventBus 没有 listener 时 emit 是空操作
 *   - 不修改输入 report
 *   - 调用方决定是否发事件（通过依赖注入）
 */
import { log } from '@akemi-mio/core/logger/Logger'
import type { RegressionReport } from '@akemi-mio/reasoning/golden/types'

// =============================================================================
// 事件类型
// =============================================================================

/** 事件名称 */
export const EVIDENCE_REPORT_READY = 'evidence.report.ready'

/** 『证据就绪』事件负载 */
export interface EvidenceReportReadyPayload {
  /** 报告唯一标识：report_{executedAt}_{sha} */
  reportId: string
  /** 完整 RegressionReport（只读引用，emit 时不拷贝） */
  report: RegressionReport
  /** 桥接时间戳 */
  generatedAt: number
}

/** Bridge 依赖的 Emitter 接口（兼容 EventBus.emit 签名） */
export interface EvidenceEmitter {
  emit(event: string, payload: unknown): void
}

// =============================================================================
// EvidenceBridge
// =============================================================================

export class EvidenceBridge {
  private readonly emitter: EvidenceEmitter

  /**
   * @param emitter 依赖注入：EventBus 实例或兼容的 emit 函数包装。
   *                默认使用全局 eventBus（惰性引用，因为 EventBus 可能尚未初始化）。
   *                调用方可以传入 null/undefined 来禁用事件（调试/测试用）。
   */
  constructor(emitter?: EvidenceEmitter | null) {
    this.emitter = emitter ?? nullEmitter
    log('INFO', 'evidence_bridge_initialized', {
      emitterType: emitter ? 'injected' : 'null',
    })
  }

  /**
   * 桥接一个 RegressionReport 到 EventBus。
   *
   * 设计约束：
   *   1. 不修改 report（传入的是只读引用）
   *   2. 不建立到 report 的长引用（emit 即弃）
   *   3. 不调用 Evolution 层任何代码
   *
   * @param report RegressionReport（纯数据对象，由调用方保证完整性）
   */
  bridge(report: RegressionReport): void {
    const reportId = this.buildReportId(report)
    const payload: EvidenceReportReadyPayload = {
      reportId,
      report,
      generatedAt: Date.now(),
    }

    this.emitter.emit(EVIDENCE_REPORT_READY, payload)

    log('INFO', 'evidence_report_ready_emitted', {
      reportId,
      passRate: report.summary.passRate,
      failed: report.summary.failed,
      total: report.summary.total,
    })
  }

  // ── Private ──

  private buildReportId(report: RegressionReport): string {
    return `report_${report.metadata.executedAt}_${report.metadata.commit.sha}`
  }
}

// =============================================================================
// 空实现（无消费者安全）
// =============================================================================

/** 静默丢弃事件，用于无 EventBus 环境（测试、CLI、未初始化阶段） */
const nullEmitter: EvidenceEmitter = {
  emit(_event: string, _payload: unknown): void {
    // 无操作：没有注册 listener 时，事件安全丢失
  },
}
