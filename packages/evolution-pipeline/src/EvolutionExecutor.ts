/**
 * EvolutionExecutor — 进化流水线 Stage 3
 *
 * 职责：执行进化计划的下一步，管理 Git 快照/回滚，指数退避重试
 * 生命周期：init() → [executeNextStep()] → destroy()
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import { buildEvolutionSystemPrompt } from '@akemi-mio/evolution-core'
import { PLAN_EXECUTE_PROMPT, pickBestPlan } from '@akemi-mio/evolution-core'
import { withTimeout } from '@akemi-mio/core/utils/async'
import { AsyncLock } from '@akemi-mio/core/utils/AsyncLock'
import type { AgentService } from '@akemi-mio/intelligence/agent/AgentService'
import type { DevPlan, PlanManagerLike } from '@akemi-mio/evolution/types'
import type { EvolutionGitOps } from '@akemi-mio/evolution-core'
import type { ISubsystem, HealthCheckResult, SubsystemState } from '@akemi-mio/core/core/lifecycle/types'
import type { ExecutionInput, ExecutionResult } from './types'
import type { CicdStepResult } from '@akemi-mio/evolution-cicd/types'
import type { CicdOrchestrator } from '@akemi-mio/evolution-cicd/CicdOrchestrator'
import { planStepMapper } from '@akemi-mio/evolution-cicd/PlanStepMapper'

export class EvolutionExecutor implements ISubsystem {
  readonly name = 'EvolutionExecutor'
  state: SubsystemState = 'created'

  private agentService: AgentService
  private planManager: PlanManagerLike | null
  private gitOps: EvolutionGitOps | null = null
  private planExecTimeoutMs: number
  private stepRetryBaseMs: number
  private planExecConsecutiveErrors = 0
  private executeFailures = 0
  private currentSnapshotBranch: string | null = null
  private executionLock = new AsyncLock()
  private proposalValidator: any = null
  private safetyMode: string = 'auto'

  /** CI/CD Orchestrator（可选注入）：将 CI/CD 可映射的步骤通过 MCP 工具执行而非 LLM */
  private cicdOrchestrator: CicdOrchestrator | null = null

  constructor(
    agentService: AgentService,
    planManager: PlanManagerLike | null,
    options?: {
      planExecTimeoutMs?: number
      stepRetryBaseMs?: number
    },
  ) {
    this.agentService = agentService
    this.planManager = planManager
    this.planExecTimeoutMs = options?.planExecTimeoutMs ?? 300000
    this.stepRetryBaseMs = options?.stepRetryBaseMs ?? 1000
  }

  async init(): Promise<void> {
    this.state = 'initializing'
    log('INFO', 'evolution_executor.init')
    this.state = 'ready'
  }

  async start(): Promise<void> {
    this.state = 'running'
  }
  async stop(): Promise<void> {
    this.currentSnapshotBranch = null
    this.state = 'ready'
  }
  async destroy(): Promise<void> {
    this.state = 'stopped'
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return { healthy: true, metrics: { consecutiveErrors: this.planExecConsecutiveErrors, executeFailures: this.executeFailures } }
  }

  setGitOps(gitOps: EvolutionGitOps | null): void {
    this.gitOps = gitOps
  }
  setProposalValidator(v: any): void {
    this.proposalValidator = v
  }
  setSafetyMode(mode: string) {
    this.safetyMode = mode
  }
  setCicdOrchestrator(orchestrator: CicdOrchestrator | null): void {
    this.cicdOrchestrator = orchestrator
    if (orchestrator) {
      log('INFO', 'evolution_executor_cicd_attached', { ready: orchestrator.isReady?.() ?? false })
    }
  }
  getExecuteFailures(): number {
    return this.executeFailures
  }

  // ==================== 步骤检测 ====================

  hasPendingStep(): boolean {
    const pm = this.planManager
    if (!pm) return false
    const plan = pm.getActivePlan()
    if (!plan) return false
    return plan.steps.some((s) => s.status === 'pending' || s.status === 'failed')
  }

  getPlanProgress(): { completed: number; total: number } {
    const plan = this.planManager?.getActivePlan()
    if (!plan) return { completed: 0, total: 0 }
    return {
      completed: plan.steps.filter((s) => s.status === 'done').length,
      total: plan.steps.length,
    }
  }

  // ==================== 步骤执行 ====================

  async executeNextStep(input: ExecutionInput): Promise<ExecutionResult> {
    if (this.safetyMode === 'review') {
      log('INFO', 'plan_exec_skipped_review', { safetyMode: this.safetyMode })
      return { success: false, stepIndex: input.stepIndex, error: 'review mode, skip execution', planCompleted: false }
    }

    const pm = this.planManager
    if (!pm) return { success: false, stepIndex: input.stepIndex, error: 'no plan manager', planCompleted: false }

    return this.executionLock.run(async () => {
      const allPlans = pm.listPlans()
      const activePlans = allPlans
        .filter((p: DevPlan) => p.status === 'active')
        .sort((a: DevPlan, b: DevPlan) => (b.priority || 0) - (a.priority || 0))
      const plan = activePlans.length > 0 ? activePlans[0] : null
      if (!plan) return { success: false, stepIndex: input.stepIndex, error: 'no active plan', planCompleted: false }

      // 查找 pending 或 failed 步骤
      let nextStep = plan.steps.find((s) => s.status === 'pending')
      if (!nextStep) nextStep = plan.steps.find((s) => s.status === 'failed')
      if (!nextStep) {
        const inProgress = plan.steps.find((s) => s.status === 'in_progress')
        if (!inProgress) {
          pm.completePlan(plan.id, '所有步骤已完成')
          this.autoGitCommit(plan.title).catch(() => {})
          return { success: true, stepIndex: -1, planCompleted: true }
        }
        return { success: false, stepIndex: input.stepIndex, error: 'step already in progress', planCompleted: false }
      }

      const stepIdx = plan.steps.indexOf(nextStep)
      return this.executeStep(plan, nextStep, stepIdx)
    })
  }

  private async executeStep(plan: DevPlan, step: DevPlan['steps'][0], stepIdx: number): Promise<ExecutionResult> {
    const pm = this.planManager!
    log('INFO', 'plan_exec_step', { plan_id: plan.id, step: step.description })
    pm.updateStep(plan.id, stepIdx, 'in_progress')

    // Git 快照
    if (this.gitOps && !this.currentSnapshotBranch) {
      const tag = `${plan.id}_step_${stepIdx}`
      const branch = await this.gitOps.createSnapshot(tag)
      if (branch) {
        this.currentSnapshotBranch = branch
        eventBus.emit('evolution.snapshot.created', { tag, branch, timestamp: Date.now() })
      }
    }

    // ProposalValidator
    if (this.proposalValidator) {
      try {
        const vr = await this.proposalValidator.validate({
          id: plan.id,
          title: plan.title,
          description: plan.description,
          targetFiles: plan.steps?.map((s: any) => s.description) || [],
          expectedOutcome: '',
          risk: 'medium',
          createdAt: Date.now(),
        })
        if (!vr.passed) log('WARN', 'plan_exec_proposal_validation_failed', { planId: plan.id })
      } catch (err: any) {
        log('WARN', 'plan_exec_proposal_validation_error', { error: String(err) })
      }
    }

    // ★ CI/CD 映射检查：如果该步骤可映射且 CicdOrchestrator 就绪，优先使用 MCP 工具执行
    if (this.cicdOrchestrator && this.cicdOrchestrator.isReady?.() && planStepMapper.isMappable(step.description)) {
      log('INFO', 'plan_exec_cicd_mapped', { step: step.description.slice(0, 80) })
      try {
        const cicdResult: CicdStepResult = await this.cicdOrchestrator.executeStep(step.description)
        if (cicdResult.passed) {
          const summary = `[CI/CD] ${cicdResult.summary}`
          pm.updateStep(plan.id, stepIdx, 'done', summary)
          this.planExecConsecutiveErrors = 0
          this.executeFailures = 0
          log('INFO', 'plan_step_done_cicd', { plan_id: plan.id, step: step.description, action: cicdResult.action })
          this.cleanupSnapshot()
          return { success: true, stepIndex: stepIdx, planCompleted: false }
        } else {
          // CI/CD 检查未通过：记录失败让 Evolution 系统决定回滚
          const summary = `[CI/CD 失败] ${cicdResult.summary}`
          log('WARN', 'plan_step_cicd_failed', { plan_id: plan.id, step: step.description, summary })
          return this.handleStepFailure(plan, step, stepIdx, summary)
        }
      } catch (err: any) {
        log('WARN', 'plan_exec_cicd_error', { error: err.message })
        // CI/CD 工具异常时回退到 LLM 执行
      }
    }

    // 指数退避重试
    const MAX_RETRIES = 3
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const planCtx = pm.getFormattedContext()
        const execPrompt = PLAN_EXECUTE_PROMPT(planCtx, step.description)
        const result = await withTimeout(
          () => this.agentService.runAgentTask(execPrompt, buildEvolutionSystemPrompt()),
          this.planExecTimeoutMs,
          'plan_exec_timeout',
        )

        if (result.success) {
          pm.updateStep(plan.id, stepIdx, 'done', result.summary)
          this.planExecConsecutiveErrors = 0
          this.executeFailures = 0
          log('INFO', 'plan_step_done', { plan_id: plan.id, step: step.description })
          this.cleanupSnapshot()
          return { success: true, stepIndex: stepIdx, planCompleted: false }
        } else {
          if (attempt < MAX_RETRIES) {
            const delay = Math.pow(2, attempt - 1) * this.stepRetryBaseMs
            await new Promise((r) => setTimeout(r, delay))
          } else {
            return this.handleStepFailure(plan, step, stepIdx, result.summary)
          }
        }
      } catch (err: any) {
        if (attempt < MAX_RETRIES) {
          const delay = Math.pow(2, attempt - 1) * this.stepRetryBaseMs
          await new Promise((r) => setTimeout(r, delay))
        } else {
          return this.handleStepFailure(plan, step, stepIdx, String(err))
        }
      }
    }

    return { success: false, stepIndex: stepIdx, error: 'unreachable', planCompleted: false }
  }

  private async handleStepFailure(plan: DevPlan, step: DevPlan['steps'][0], stepIdx: number, error: string): Promise<ExecutionResult> {
    const pm = this.planManager!
    pm.updateStep(plan.id, stepIdx, 'failed', error)
    this.planExecConsecutiveErrors++
    this.executeFailures++

    // 回滚
    if (this.currentSnapshotBranch && this.gitOps) {
      const rollbackSuccess = await this.gitOps.rollbackToSnapshot(this.currentSnapshotBranch)
      eventBus.emit('evolution.rollback.completed', {
        level: 'task',
        ref: this.currentSnapshotBranch,
        success: rollbackSuccess,
        error: rollbackSuccess ? undefined : '回滚执行失败',
      })
      this.currentSnapshotBranch = null
    }

    log('ERROR', 'plan_step_error', { plan_id: plan.id, step: step.description, error })
    if (this.planExecConsecutiveErrors >= 3) {
      pm.abandonPlan(plan.id, '自动放弃：连续步骤执行失败')
      this.planExecConsecutiveErrors = 0
      log('WARN', 'plan_auto_abandoned', { plan_id: plan.id })
    }

    return { success: false, stepIndex: stepIdx, error, planCompleted: false }
  }

  private cleanupSnapshot(): void {
    if (this.currentSnapshotBranch && this.gitOps) {
      this.gitOps.cleanupSnapshot(this.currentSnapshotBranch).catch(() => {})
      this.currentSnapshotBranch = null
    }
  }

  /** 重置执行计数器（外部调用，如冷却恢复时） */
  resetFailures(): void {
    this.planExecConsecutiveErrors = 0
    this.executeFailures = 0
  }

  private async autoGitCommit(planTitle: string): Promise<void> {
    if (!this.gitOps) return
    await this.gitOps.autoGitCommit(planTitle).catch(() => {})
  }
}
