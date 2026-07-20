/**
 * WorkflowRuntimeCheckpointableComponent — WorkflowSchedulerV2 的 checkpoint 适配
 *
 * 职责：
 *   1. snapshot(): 记录当前调度器正在管理的活跃 workflow run ID 列表
 *   2. restore():  分析 checkpoint 中的 run，生成 WorkflowRecoveryPlan[]
 *                  Phase 1：纯分析，不启动 scheduler，无副作用
 *   3. getRecoveryPlans(): Phase 2 激活前由 RecoveryActivator 读取 plan
 *
 * 设计原则：
 *   - restore() 不调用 scheduler，只生成 plan
 *   - scheduler 的 resumeRun() 在 restore 成功后的 activation 阶段触发
 *   - WorkflowStoreV2 (SQLite) 是事实来源，checkpoint 不复制 execution state
 *
 * 见 docs/workflow-runtime-state-mapping.md
 */

import type { CheckpointableComponent, VersionedState, WorkflowRecoveryPlan } from '../runtime/CheckpointTypes'
import type { WorkflowSchedulerV2 } from '../workflow/WorkflowScheduler'
import type { WorkflowStoreV2 } from '../workflow/WorkflowStoreV2'
import type { WorkflowRunStatus } from '../workflow/types'
import { workflowStore } from '../workflow/WorkflowStoreV2'
import { log } from '../logger/Logger'

// ════════════════════════════════════════
//  Snapshot data type
// ════════════════════════════════════════

export interface WorkflowRuntimeSnapshot {
  /** 当前调度器正在管理的活跃 run，含 DB 级状态 */
  activeRuns: Array<{
    runId: string
    status: WorkflowRunStatus
  }>
}

// ════════════════════════════════════════
//  Component
// ════════════════════════════════════════

export class WorkflowRuntimeCheckpointableComponent implements CheckpointableComponent {
  readonly id = 'workflow-runtime'

  private scheduler: WorkflowSchedulerV2
  private store: WorkflowStoreV2
  /** Phase 1 restore 生成的 recovery plans，由 Phase 2 RecoveryActivator 消费 */
  private recoveryPlans: WorkflowRecoveryPlan[] | null = null

  constructor(scheduler: WorkflowSchedulerV2, store: WorkflowStoreV2 = workflowStore) {
    this.scheduler = scheduler
    this.store = store
  }

  // ════════════════════════════════════════
  //  snapshot
  // ════════════════════════════════════════

  async snapshot(): Promise<VersionedState> {
    const runIds = this.scheduler.getActiveRunIds()
    const activeRuns: WorkflowRuntimeSnapshot['activeRuns'] = []

    for (const runId of runIds) {
      const run = this.store.getRun(runId)
      if (run) {
        activeRuns.push({ runId, status: run.status })
      } else {
        log('WARN', 'wf_ckpt_run_not_in_store', { runId })
      }
    }

    const data: WorkflowRuntimeSnapshot = { activeRuns }

    return {
      component: 'workflow-runtime',
      version: '1.0',
      data,
      createdAt: Date.now(),
    }
  }

  // ════════════════════════════════════════
  //  restore — Phase 1: plan generation only
  // ════════════════════════════════════════

  async restore(state: VersionedState): Promise<void> {
    const snapshot = state.data as WorkflowRuntimeSnapshot | undefined
    if (!snapshot?.activeRuns?.length) {
      log('INFO', 'wf_ckpt_restore_noop', { msg: 'no active runs to restore' })
      this.recoveryPlans = []
      return
    }

    if (state.version !== '1.0') {
      log('WARN', 'wf_ckpt_restore_version_mismatch', { version: state.version, expected: '1.0' })
    }

    const plans: WorkflowRecoveryPlan[] = []

    for (const entry of snapshot.activeRuns) {
      const plan = this.analyzeRun(entry.runId, entry.status)
      plans.push(plan)
    }

    this.recoveryPlans = plans

    const resume = plans.filter((p) => p.action === 'resume').length
    const register = plans.filter((p) => p.action === 'register-only').length
    const skip = plans.filter((p) => p.action === 'skip').length
    log('INFO', 'wf_ckpt_restore_complete', { total: plans.length, resume, register, skip })
  }

  /** 返回 Phase 1 生成的 recovery plans */
  getRecoveryPlans(): WorkflowRecoveryPlan[] {
    return this.recoveryPlans ?? []
  }

  // ════════════════════════════════════════
  //  Internal: analyze single run → plan
  // ════════════════════════════════════════

  private analyzeRun(runId: string, _snapshotStatus: WorkflowRunStatus): WorkflowRecoveryPlan {
    const run = this.store.getRun(runId)
    if (!run) {
      return { runId, action: 'skip', reason: 'run not found in store' }
    }

    if (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') {
      return { runId, action: 'skip', reason: `status=${run.status}` }
    }

    const def = this.store.getDefinition(run.workflowDefId)
    if (!def) {
      return { runId, action: 'skip', reason: 'workflow definition not found' }
    }

    if (run.status === 'paused') {
      return { runId, action: 'register-only', reason: run.pendingGate ? 'pending gate' : 'paused' }
    }

    if (run.status === 'running' && run.pendingGate) {
      return { runId, action: 'register-only', reason: 'pending gate' }
    }

    if (run.status === 'running') {
      return { runId, action: 'resume' }
    }

    return { runId, action: 'skip', reason: `unhandled status=${run.status}` }
  }
}
