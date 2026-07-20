/**
 * RuntimeRecoveryActivator — RecoveryActivator 实现。
 *
 * Phase 2 激活器：RuntimeRestoreService restore 成功后触发，
 * 将 WorkflowRecoveryPlan 转换为 scheduler 操作。
 *
 * 不直接依赖 RuntimeRestoreService，只依赖 RecoveryActivator 接口 + WorkflowSchedulerV2。
 */

import type { RecoveryActivator, WorkflowRecoveryPlan, WorkflowResumeResult } from './CheckpointTypes'
import type { WorkflowSchedulerV2 } from '../workflow/WorkflowScheduler'
import { log } from '../logger/Logger'

export class RuntimeRecoveryActivator implements RecoveryActivator {
  constructor(private scheduler: WorkflowSchedulerV2) {}

  async activate(plans: WorkflowRecoveryPlan[]): Promise<void> {
    const results: WorkflowResumeResult[] = []

    for (const plan of plans) {
      switch (plan.action) {
        case 'resume': {
          const result = this.scheduler.resumeRun(plan.runId)
          results.push(result)
          log('INFO', 'recovery_activate_resume', {
            runId: plan.runId,
            state: result.state,
            reason: result.reason,
          })
          break
        }
        case 'register-only': {
          this.scheduler.registerRuntimeState(plan.runId)
          results.push({ runId: plan.runId, state: 'registered', reason: plan.reason })
          log('INFO', 'recovery_activate_register', {
            runId: plan.runId,
            reason: plan.reason,
          })
          break
        }
        case 'skip': {
          log('INFO', 'recovery_activate_skip', {
            runId: plan.runId,
            reason: plan.reason,
          })
          break
        }
      }
    }

    const failed = results.filter((r) => r.state === 'failed')
    if (failed.length > 0) {
      log('WARN', 'recovery_activate_partial_failure', {
        total: plans.length,
        failed: failed.length,
        details: failed.map((f) => `${f.runId}: ${f.reason}`).join('; '),
      })
    }

    const started = results.filter((r) => r.state === 'started').length
    const registered = results.filter((r) => r.state === 'registered').length
    log('INFO', 'recovery_activate_complete', {
      total: plans.length,
      started,
      registered,
      skipped: plans.length - results.length,
      failed: failed.length,
    })
  }
}
