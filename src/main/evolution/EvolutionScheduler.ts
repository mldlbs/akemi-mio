import { eventBus, EventBus } from '../core/EventBus'
import { log } from '../logger/Logger'
import { AsyncLock } from '../utils/AsyncLock'
import type { AgentService } from '../agent/AgentService'

/**
 * 调度状态机状态枚举
 * IDLE → ANALYZING → IDLE 或 → EXECUTING → IDLE
 * EXECUTING → VERIFYING → IDLE（验证模式启用时）
 * COOLDOWN → IDLE（冷却超时后自动转换）
 */
export enum EvolutionSchedulerState {
  IDLE = 'IDLE',
  ANALYZING = 'ANALYZING',
  EXECUTING = 'EXECUTING',
  VERIFYING = 'VERIFYING',
  COOLDOWN = 'COOLDOWN',
}

export type SchedulerCallbacks = {
  onAnalyze: () => Promise<void>
  onExecute: () => Promise<void>
}

const MIN_INTERVAL_HOURS = 1

/**
 * 调度状态机 — 管理 Evolution 的分析/执行/冷却周期。
 * 从 SelfEvolutionService 提取，职责单一。
 */
export class EvolutionScheduler {
  private agentService: AgentService
  private eventBus: EventBus

  currentState: EvolutionSchedulerState = EvolutionSchedulerState.IDLE
  private callbacks: SchedulerCallbacks

  schedulerTickId: string | null = null
  schedulerTaskId: string | null = null
  schedulerTickMs: number = 5 * 60 * 1000
  lastAnalysisTime: number = 0
  lastExecutionTime: number = 0
  lastRun: number = 0
  tryRunFailures: number = 0
  executeFailures: number = 0
  maxFailures: number = 3
  recoveryCooldownUntil: number = 0
  lastSuccessTime: number = 0
  intervalMs: number = 2 * 60 * 60 * 1000
  planExecTimeoutMs: number
  currentAnalysisTimeoutMs: number
  analysisStuckTimeoutMs: number
  readonly evolutionLock = new AsyncLock()

  constructor(
    agentService: AgentService,
    callbacks: SchedulerCallbacks,
    bus?: EventBus,
    options?: {
      schedulerTickMs?: number
      planExecTimeoutMs?: number
      analysisTimeoutMs?: number
      analysisStuckTimeoutMs?: number
    },
  ) {
    this.agentService = agentService
    this.callbacks = callbacks
    this.eventBus = bus || eventBus
    this.planExecTimeoutMs = options?.planExecTimeoutMs ?? 300000
    this.currentAnalysisTimeoutMs = options?.analysisTimeoutMs ?? 120000
    this.analysisStuckTimeoutMs = options?.analysisStuckTimeoutMs ?? 60_000
  }

  start(): void {
    log('INFO', 'evolution_scheduler_started', {
      interval_hours: this.intervalMs / 3600000,
      scheduler_tick_ms: this.schedulerTickMs,
    })
  }

  stop(): void {
    log('INFO', 'evolution_scheduler_stopped')
  }

  getState(): EvolutionSchedulerState {
    return this.currentState
  }

  getRecoveryCooldown(): { active: boolean; remainingMs: number } {
    if (this.recoveryCooldownUntil === 0 || Date.now() > this.recoveryCooldownUntil) {
      return { active: false, remainingMs: 0 }
    }
    return { active: true, remainingMs: this.recoveryCooldownUntil - Date.now() }
  }

  transitionState(newState: EvolutionSchedulerState, reason: string): void {
    const oldState = this.currentState
    this.currentState = newState
    log('INFO', 'scheduler_state_transition', {
      from: oldState,
      to: newState,
      reason,
    })
    this.eventBus.emit('evolution.scheduler.state' as any, {
      from: oldState,
      to: newState,
      reason,
      timestamp: Date.now(),
    })
  }

  async schedulerTick(): Promise<void> {
    if (this.agentService.isBusy()) {
      if (
        this.lastRun > 0 &&
        Date.now() - this.lastRun > this.currentAnalysisTimeoutMs &&
        this.currentState === EvolutionSchedulerState.ANALYZING
      ) {
        log('WARN', 'scheduler_tick_stale_abort', {
          state: this.currentState,
          ageMs: Date.now() - this.lastRun,
        })
        this.agentService.abortSelfTask?.()
        await new Promise((r) => setTimeout(r, 300))
        if (!this.agentService.isBusy()) {
          this.transitionState(EvolutionSchedulerState.IDLE, '残留分析任务已中止')
        } else {
          return
        }
      } else {
        return
      }
    }

    if (this.recoveryCooldownUntil > 0) {
      if (Date.now() > this.recoveryCooldownUntil) {
        this.tryRunFailures = 0
        this.recoveryCooldownUntil = 0
        this.transitionState(EvolutionSchedulerState.IDLE, '冷却期结束')
      } else {
        return
      }
    }

    switch (this.currentState) {
      case EvolutionSchedulerState.IDLE: {
        const hoursSinceLastAnalysis = (Date.now() - this.lastAnalysisTime) / (1000 * 60 * 60)
        if (this.lastAnalysisTime === 0 || hoursSinceLastAnalysis >= Math.max(this.intervalMs / (1000 * 60 * 60), MIN_INTERVAL_HOURS)) {
          this.transitionState(EvolutionSchedulerState.ANALYZING, `距上次分析 ${hoursSinceLastAnalysis.toFixed(1)}h，开始新分析`)
          await this.callbacks.onAnalyze()
        }
        break
      }
      case EvolutionSchedulerState.ANALYZING: {
        if (Date.now() - this.lastAnalysisTime > this.currentAnalysisTimeoutMs * 2) {
          log('WARN', 'scheduler_tick_analyzing_stuck', {
            lastAnalysisAgeMs: Date.now() - this.lastAnalysisTime,
          })
          this.agentService.abortSelfTask?.()
          this.transitionState(EvolutionSchedulerState.IDLE, '分析任务被强制中止')
        }
        if (this.analysisStuckTimeoutMs > 0 && Date.now() - this.lastAnalysisTime > this.analysisStuckTimeoutMs) {
          log('WARN', 'scheduler_tick_analysis_stuck_timeout', {
            ageMs: Date.now() - this.lastAnalysisTime,
            stuckTimeoutMs: this.analysisStuckTimeoutMs,
          })
          this.agentService.abortSelfTask?.()
          this.transitionState(EvolutionSchedulerState.EXECUTING, 'analysis_stuck_timeout: 分析卡死超时，自动转入执行模式')
        }
        break
      }
      case EvolutionSchedulerState.EXECUTING: {
        if (Date.now() - this.lastExecutionTime > this.planExecTimeoutMs * 2) {
          log('WARN', 'scheduler_tick_executing_stuck', {
            lastExecAgeMs: Date.now() - this.lastExecutionTime,
          })
          this.agentService.abortSelfTask?.()
          this.transitionState(EvolutionSchedulerState.IDLE, '执行任务被强制中止')
        }
        break
      }
      case EvolutionSchedulerState.VERIFYING: {
        if (Date.now() - this.lastExecutionTime > this.planExecTimeoutMs * 3) {
          log('WARN', 'scheduler_tick_verifying_stuck', {
            lastExecAgeMs: Date.now() - this.lastExecutionTime,
          })
          this.transitionState(EvolutionSchedulerState.IDLE, '验证阶段超时，跳过')
        }
        break
      }
      case EvolutionSchedulerState.COOLDOWN:
        break
    }
  }

  hasPendingPlanStep(planManager: { getActivePlan: () => any } | null): boolean {
    if (!planManager) return false
    const plan = planManager.getActivePlan()
    if (!plan) return false
    return plan.steps.some((s: any) => s.status === 'pending' || s.status === 'failed')
  }
}
