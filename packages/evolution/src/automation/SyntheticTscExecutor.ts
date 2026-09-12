/**
 * SyntheticTscExecutor — 合成 TSC 错误执行器（受控故障验证用）
 *
 * 不修改任何真实 TSC 修复逻辑。
 * 只管 emit 执行事件，让 E2E 验证能观测到 Execution → Review 链路。
 *
 * Protocol:
 *   1. 开始执行 → emit 'intervention.started'
 *   2. 模拟执行成功 → emit 'intervention.completed'
 *   3. 记录最小回顾记录
 */
import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import type { FixExecutor, FixResult, AssignedProblem, ProblemSource, InterventionReviewRecord, SyntheticExecutionEvent } from './types'

/** synthetic executor 在 E2E 测试中注册 */
export const SYNTHETIC_EXECUTOR_NAME = 'synthetic-tsc'

export class SyntheticTscExecutor implements FixExecutor {
  readonly name = SYNTHETIC_EXECUTOR_NAME
  readonly supportedSources: ProblemSource[] = ['synthetic', 'tsc']
  readonly timeoutMs = 5_000

  private reviewRecords: InterventionReviewRecord[] = []

  isAvailable(): boolean {
    return true
  }

  async execute(problem: AssignedProblem): Promise<FixResult> {
    const startedAt = Date.now()

    // emit 开始事件
    const startedEvent: SyntheticExecutionEvent = {
      problemId: problem.id,
      executorName: this.name,
      action: 'started',
      timestamp: startedAt,
    }
    eventBus.emit('intervention.started', startedEvent)
    log('INFO', 'synthetic_executor_started', { problemId: problem.id })

    // 模拟执行（不做真实修复）
    const durationMs = Date.now() - startedAt

    // 记录回顾
    const record: InterventionReviewRecord = {
      interventionId: `synth_${problem.id}_${startedAt}`,
      problemId: problem.id,
      source: problem.source,
      success: true,
      summary: `[synthetic] 已模拟执行: ${problem.title.slice(0, 60)}`,
      timestamp: Date.now(),
    }
    this.reviewRecords.push(record)
    if (this.reviewRecords.length > 20) {
      this.reviewRecords = this.reviewRecords.slice(-20)
    }

    // emit 完成事件
    const completedEvent: SyntheticExecutionEvent = {
      problemId: problem.id,
      executorName: this.name,
      action: 'completed',
      timestamp: Date.now(),
    }
    eventBus.emit('intervention.completed', completedEvent)

    log('INFO', 'synthetic_executor_completed', {
      problemId: problem.id,
      durationMs,
      reviewId: record.interventionId,
    })

    return {
      problemId: problem.id,
      success: true,
      summary: record.summary,
      durationMs,
    }
  }

  /** 获取该实例自创建以来的所有回顾记录（测试验证用） */
  getReviewRecords(): InterventionReviewRecord[] {
    return [...this.reviewRecords]
  }
}
