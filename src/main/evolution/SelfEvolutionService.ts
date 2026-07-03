/**
 * SelfEvolutionService — 自进化调度编排器（精简版）
 *
 * 职责已重新定位：
 * 1. 调度自动化管道（PipelineOrchestrator）的周期性执行
 * 2. 读取管道指标并报告给用户（而非 LLM 自我分析）
 * 3. 维护调度状态机（冷却/失败计数跨重启）
 * 4. 安全模式管理、用户活跃保护
 *
 * 已移除（闭环内循环组件）：
 * - SelfEvaluator / MetaLearner / PromptEvolutionManager（LLM 评 LLM）
 * - ActionPlanner / ActionRegistry config-fix 动作（零价值）
 * - PatternMiner / CapabilityCompiler / PreservationEngine（来自 traces 的循环论证）
 * - ExecutionTracer / IntentExtractor / TraceAligner（同上）
 * - 退化检测 / 指纹系统（同一问题的反复检测无意义）
 * - LLM 预热 / 策略变异 / prompt 覆盖层
 *
 * 外部信号管道（PipelineOrchestrator）与 SelfEvolutionService 并列，
 * SelfEvolutionService 只读地消费管道指标。
 */

import { join, dirname } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { log } from '../logger/Logger'
import { scheduler, Scheduler } from '../core/Scheduler'
import { eventBus, EventBus } from '../core/EventBus'
import { AsyncLock } from '../utils/AsyncLock'
import { PlanIntegrityChecker } from './PlanIntegrityChecker'
import { EVOLUTION_SAFETY_MODE, WORKSPACE } from '../config'
import type { AgentService } from '../agent/AgentService'
import type { PlanManagerLike } from './types'
import type { ISubsystem, HealthCheckResult, SubsystemState } from '../core/lifecycle/types'
import type { PipelineOrchestrator, PipelineMetrics } from './automation'
import { insertMessage, createMessageId } from '../db/messages'
import { getMainWindow } from '../core/Lifecycle'

// =============================================================================
// 调度状态机状态枚举
// =============================================================================

export enum EvolutionSchedulerState {
  IDLE = 'IDLE',
  ANALYZING = 'ANALYZING',
  COOLDOWN = 'COOLDOWN',
}

type SafetyMode = 'review' | 'auto'

/**
 * SelfEvolutionService — 自进化调度编排器（精简版）
 *
 * 薄层协调器：
 * - 调度自动化管道周期性运行
 * - 读取管道指标生成管理报告
 * - 维护冷却/失败状态跨重启
 * - 安全模式管理
 */
export class SelfEvolutionService implements ISubsystem {
  readonly name = 'SelfEvolutionService'
  state: SubsystemState = 'created'

  // ==================== 外部依赖 ====================
  private agentService: AgentService
  private scheduler: Scheduler
  private eventBus: EventBus
  private planManager: PlanManagerLike | null = null

  /** 自动化管道引用（可选注入） */
  private pipeline: PipelineOrchestrator | null = null

  // ==================== 调度状态机 ====================
  private schedulerState: EvolutionSchedulerState = EvolutionSchedulerState.IDLE
  private schedulerTickId: string | null = null
  /** 后备心跳间隔（30 分钟） */
  private schedulerTickMs: number = 30 * 60 * 1000
  private lastRun: number = 0

  // ==================== 用户活跃保护 ====================
  private mioActive = false
  private mioActiveSince = 0
  private lastUserInputTime = 0
  private static readonly USER_COOLDOWN_MS = 5 * 60 * 1000
  private static readonly MIO_ACTIVE_TIMEOUT_MS = 10 * 60 * 1000

  // ==================== 安全 & 冷却 ====================
  private safetyMode: SafetyMode = EVOLUTION_SAFETY_MODE as SafetyMode
  private tryRunFailures = 0
  private executeFailures = 0
  private maxFailures = 3
  private recoveryCooldownUntil = 0
  private lastSuccessTime = 0
  private intervalMs = 2 * 60 * 60 * 1000
  private readonly evolutionLock = new AsyncLock()
  private firstRunComplete = false

  // ==================== 最近管道指标缓存 ====================
  private lastPipelineMetrics: PipelineMetrics | null = null

  // ==================== 状态持久化 ====================
  private stateFilePath: string

  // ==================== 事件订阅清理 ====================
  private eventSubscriptions: (() => void)[] = []

  constructor(
    agentService: AgentService,
    sched?: Scheduler,
    bus?: EventBus,
    planManager?: PlanManagerLike,
    options?: { stateFilePath?: string; intervalMs?: number; maxFailures?: number },
  ) {
    this.agentService = agentService
    this.scheduler = sched || scheduler
    this.eventBus = bus || eventBus
    this.planManager = planManager || null
    this.stateFilePath = options?.stateFilePath ?? join(WORKSPACE.evolution, 'living_plan', 'evolution_state.json')
    if (options?.intervalMs) this.intervalMs = options.intervalMs
    if (options?.maxFailures) this.maxFailures = options.maxFailures

    // 用户活跃保护
    this.eventBus.on('agent.input.received', () => {
      this.lastUserInputTime = Date.now()
      this.mioActive = true
      this.mioActiveSince = Date.now()
    })
    this.eventBus.on('agent.response.generated', () => {
      this.mioActive = false
      this.mioActiveSince = 0
    })

    // 事件驱动触发订阅（事件冷却 5min）
    this.eventSubscriptions.push(
      this.eventBus.on('stability.score.updated', (p: any) => {
        if (p.status === 'unstable' || p.status === 'critical' || p.trend === 'declining') {
          this.onTriggerEvent('stability.score.updated', p)
        }
      }),
      this.eventBus.on('budget.exhausted', (p: any) => this.onTriggerEvent('budget.exhausted', p) as any),
      this.eventBus.on('evolution.cycle.completed', (p: any) => {
        if (!p.success) this.onTriggerEvent('evolution.cycle.completed', p)
      }) as any,
      // 持续监听管道事件，更新缓存指标
      (this.eventBus.on as any)('pipeline.completed', (p: any) => {
        this.lastPipelineMetrics = this.pipeline?.getMetrics() ?? null
      }) as any,
      // 将进化结果持久化为 UI 消息
      (this.eventBus.on as any)('evolution.cycle.completed', (p: any) => {
        this.persistEvolutionMessage(p.summary, p.success, p.durationMs)
      }) as any,
    )

    this.loadState()
  }

  /** 注入管道引用 */
  setPipeline(pipeline: PipelineOrchestrator): void {
    this.pipeline = pipeline
    log('INFO', 'evolution_pipeline_attached')
  }

  private eventCooldownUntil = 0
  private static readonly EVENT_COOLDOWN_MS = 5 * 60 * 1000

  private onTriggerEvent(event: string, payload: any): void {
    if (Date.now() < this.eventCooldownUntil) return
    if (this.schedulerState !== EvolutionSchedulerState.IDLE) return
    this.eventCooldownUntil = Date.now() + SelfEvolutionService.EVENT_COOLDOWN_MS
    log('INFO', 'evolution_trigger_event', { event, payload })
    this.runAnalysisCycle()
  }

  // ==================== ISubsystem ====================

  async init(): Promise<void> {
    this.state = 'initializing'
    this.state = 'ready'
  }

  async start(): Promise<void> {
    this.state = 'running'
    // 首次启动时立即执行一次管道
    // （如果管道已注入）
    if (this.pipeline) {
      this.pipeline.runOnce().catch(() => {})
    }
  }

  async stop(): Promise<void> {
    this.state = 'stopping'
    this.stopExistingTick()
    this.disposeEventSubscriptions()
    this.state = 'stopped'
  }

  async destroy(): Promise<void> {
    this.disposeEventSubscriptions()
  }

  private disposeEventSubscriptions(): void {
    for (const dispose of this.eventSubscriptions) dispose()
    this.eventSubscriptions = []
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return {
      healthy: true,
      metrics: {
        state: this.schedulerState as unknown as number,
        tryRunFailures: this.tryRunFailures,
        executeFailures: this.executeFailures,
        pipelineQueueSize: this.lastPipelineMetrics?.queueSize ?? 0,
        pipelineFixed: this.lastPipelineMetrics?.totalFixed ?? 0,
      },
    }
  }

  // ==================== 公共 API ====================

  scheduleEvolution(intervalHours = 2): void {
    this.stopExistingTick()
    const intervalMs = Math.max(intervalHours, 1) * 60 * 60 * 1000
    this.intervalMs = intervalMs
    this.schedulerTickId = this.scheduler.interval(
      this.schedulerTickMs,
      async () => {
        await this.schedulerTick()
        return ''
      },
      '@evolution',
    )
    log('INFO', 'evolution_started', { interval_hours: intervalHours, fallback_heartbeat_min: this.schedulerTickMs / 60000 })
  }

  stopExistingTick(): void {
    if (this.schedulerTickId) {
      this.scheduler.cancel(this.schedulerTickId)
      this.schedulerTickId = null
    }
  }

  async triggerNow(): Promise<void> {
    await this.runAnalysisCycle()
  }

  getSchedulerState(): EvolutionSchedulerState {
    return this.schedulerState
  }
  getSafetyMode(): SafetyMode {
    return this.safetyMode
  }
  getLastRun(): number {
    return this.lastRun
  }
  getConsecutiveFailures(): number {
    return this.tryRunFailures
  }
  getLastPipelineMetrics(): PipelineMetrics | null {
    return this.lastPipelineMetrics
  }

  getRecoveryCooldown(): { active: boolean; remainingMs: number } {
    if (this.recoveryCooldownUntil === 0 || Date.now() > this.recoveryCooldownUntil) {
      return { active: false, remainingMs: 0 }
    }
    return { active: true, remainingMs: this.recoveryCooldownUntil - Date.now() }
  }

  setSafetyMode(mode: SafetyMode): void {
    this.safetyMode = mode
    log('INFO', 'evolution_safety_mode', { mode })
  }

  // ==================== 调度 tick ====================

  async schedulerTick(): Promise<void> {
    // 用户活跃保护
    if (this.mioActive) {
      if (this.mioActiveSince > 0 && Date.now() - this.mioActiveSince > SelfEvolutionService.MIO_ACTIVE_TIMEOUT_MS) {
        log('WARN', 'scheduler_tick_mio_active_timeout_clear', { activeMs: Date.now() - this.mioActiveSince })
        this.mioActive = false
        this.mioActiveSince = 0
      } else {
        return
      }
    }
    if (Date.now() - this.lastUserInputTime < SelfEvolutionService.USER_COOLDOWN_MS) return

    if (this.agentService.isBusy()) return

    // 冷却恢复
    if (this.recoveryCooldownUntil > 0) {
      if (Date.now() > this.recoveryCooldownUntil) {
        this.tryRunFailures = 0
        this.executeFailures = 0
        this.recoveryCooldownUntil = 0
        this.transitionState(EvolutionSchedulerState.IDLE, '冷却期结束')
      } else return
    }

    switch (this.schedulerState) {
      case EvolutionSchedulerState.IDLE: {
        const hoursSinceLastRun = this.lastRun > 0 ? (Date.now() - this.lastRun) / (1000 * 60 * 60) : Infinity
        if (hoursSinceLastRun >= Math.max(this.intervalMs / (1000 * 60 * 60), 1)) {
          this.transitionState(EvolutionSchedulerState.ANALYZING, `距上次 ${hoursSinceLastRun.toFixed(1)}h`)
          await this.runAnalysisCycle()
        }
        break
      }
      case EvolutionSchedulerState.COOLDOWN:
        break
      default:
        break
    }
  }

  // ==================== 分析循环（简化版） ====================

  private async runAnalysisCycle(): Promise<void> {
    this.transitionState(EvolutionSchedulerState.ANALYZING, '开始周期')
    this.lastRun = Date.now()
    this.eventBus.emit('evolution.cycle.started', { timestamp: this.lastRun, failures: this.tryRunFailures })

    await this.evolutionLock.run(async () => {
      // 先执行完整性检查（老代码保留）
      this.performIntegrityCheck()

      let success = false
      let summary = ''
      const startedAt = Date.now()

      try {
        // 步骤 1：触发自动化管道（如果已注入）
        if (this.pipeline) {
          log('INFO', 'evolution_trigger_pipeline')
          const metrics = await this.pipeline.runOnce()
          this.lastPipelineMetrics = metrics
          this.tryRunFailures = 0
          this.lastSuccessTime = Date.now()
          this.recoveryCooldownUntil = 0

          summary = this.buildPipelineSummary(metrics)
          success = true

          log('INFO', 'evolution_pipeline_report', {
            collected: metrics.totalCollected,
            fixed: metrics.totalFixed,
            queueSize: metrics.queueSize,
          })
        } else {
          // 无管道：空 run（仅做健康检查）
          summary = '自动化管道未配置，本次跳跃'
          success = true
        }

        // 周期成功 → 重置失败计数
        if (success && this.recoveryCooldownUntil > 0) {
          this.recoveryCooldownUntil = 0
        }

        this.eventBus.emit('evolution.cycle.completed' as any, {
          success,
          summary,
          timestamp: Date.now(),
          durationMs: Date.now() - startedAt,
          mode: 'auto',
          safetyMode: this.safetyMode,
          failures: this.tryRunFailures,
        })
      } catch (err: any) {
        this.tryRunFailures++
        if (this.tryRunFailures >= this.maxFailures && this.recoveryCooldownUntil === 0) {
          this.recoveryCooldownUntil = Date.now() + Math.min(this.intervalMs, 30 * 60 * 1000)
        }

        log('ERROR', 'evolution_cycle_error', { error: String(err), failures: this.tryRunFailures })

        this.eventBus.emit('evolution.cycle.completed' as any, {
          success: false,
          summary: `Error: ${err.message}`,
          timestamp: Date.now(),
          durationMs: Date.now() - startedAt,
          mode: 'auto',
          safetyMode: this.safetyMode,
          failures: this.tryRunFailures,
        })
      }

      this.saveState()
    })

    this.transitionState(EvolutionSchedulerState.IDLE, '周期结束')
  }

  /** 构建管道指标可读报告 */
  private buildPipelineSummary(metrics: PipelineMetrics): string {
    if (metrics.totalCollected === 0) {
      return '自动化管道：未检测到需要修复的问题，代码库状态良好。'
    }

    const lines: string[] = [
      `【自动化管道报告】`,
      ``,
      `- 采集到 ${metrics.totalCollected} 个问题`,
      `- 自动修复 ${metrics.totalFixed} 个`,
      `- 修复失败 ${metrics.totalFailed} 个`,
      `- 队列剩余 ${metrics.queueSize} 个待处理`,
      metrics.lastRunAt > 0 ? `- 最近执行耗时：${((Date.now() - metrics.lastRunAt) / 1000).toFixed(0)}s` : '',
      ``,
    ]

    if (metrics.totalFixed > 0) {
      lines.push(`本次自动修复了 ${metrics.totalFixed} 个问题。`)
    }
    if (metrics.totalFailed > 0) {
      lines.push(`有 ${metrics.totalFailed} 个问题修复失败（已记录，后续会重试）。`)
    }
    if (metrics.queueSize > 0) {
      lines.push(`队列中有 ${metrics.queueSize} 个问题等待处理。`)
    }

    return lines.join('\n')
  }

  // ==================== 完整性检查 ====================

  private performIntegrityCheck(): void {
    const pm = this.planManager
    if (!pm) return

    try {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
      const abandonedCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
      const removed = pm.cleanupOldPlans?.(cutoff, abandonedCutoff) ?? 0
      if (removed > 0) log('INFO', 'evolution_plan_cleanup', { removed })
    } catch (err: any) {
      log('WARN', 'evolution_plan_cleanup_error', { error: String(err) })
    }

    try {
      const checker = new PlanIntegrityChecker()
      const allPlans = pm.listPlans()
      const result = checker.checkAllPlans(allPlans)
      if (!result.passed) {
        log('WARN', 'evolution_integrity_check_failed', {
          error_count: result.issues.filter((i: any) => i.severity === 'error').length,
        })
        for (const p of allPlans) {
          if (p.status === 'active') {
            if (!p.steps || p.steps.length === 0) {
              ;(pm as any).updatePlanStatus(p.id, 'abandoned')
              continue
            }
            const fixResult = checker.autoFix(p)
            if (fixResult.fixed > 0)
              for (let i = 0; i < p.steps.length; i++) (pm as any).updateStep(p.id, i, p.steps[i].status as any, p.steps[i].result)
          }
        }
      }
    } catch (err: any) {
      log('ERROR', 'evolution_integrity_check_error', { error: String(err) })
    }
  }

  // ==================== 状态转换 ====================

  private transitionState(newState: EvolutionSchedulerState, reason: string): void {
    const oldState = this.schedulerState
    this.schedulerState = newState
    log('INFO', 'scheduler_state_transition', { from: oldState, to: newState, reason })
    this.eventBus.emit('evolution.scheduler.state' as any, { from: oldState, to: newState, reason, timestamp: Date.now() })
  }

  // ==================== 将结果发送到 UI ====================

  private static readonly EVOLUTION_SESSION_ID = 'session_evolution'

  private persistEvolutionMessage(summary: string, success: boolean, durationMs: number): void {
    try {
      if (!summary) return
      const content = this.formatEvolutionSummary(summary, success, durationMs)
      const msg = {
        id: createMessageId(),
        source: 'electron' as const,
        role: 'assistant' as const,
        content,
        category: 'evolution',
        sessionId: SelfEvolutionService.EVOLUTION_SESSION_ID,
        createdAt: Date.now(),
      }
      insertMessage(msg)
      try {
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('message:new', msg)
        }
      } catch {
        // 窗口可能尚未创建
      }
    } catch (err) {
      log('WARN', 'evolve_persist_msg_failed', { error: String(err) })
    }
  }

  private formatEvolutionSummary(summary: string, success: boolean, durationMs: number): string {
    const icon = success ? '✅' : '⚠️'
    const duration = durationMs > 0 ? `（${(durationMs / 1000).toFixed(0)}s）` : ''
    const trimmed = summary.length > 2000 ? summary.slice(0, 2000) + '…' : summary
    return `[自进化] ${icon}${duration}\n\n${trimmed}`
  }

  // ==================== 状态持久化 ====================

  private loadState(): void {
    try {
      if (!existsSync(this.stateFilePath)) return
      const state = JSON.parse(readFileSync(this.stateFilePath, 'utf-8'))
      if (typeof state.tryRunFailures === 'number') this.tryRunFailures = state.tryRunFailures
      if (typeof state.executeFailures === 'number') this.executeFailures = state.executeFailures
      if (typeof state.recoveryCooldownUntil === 'number') this.recoveryCooldownUntil = state.recoveryCooldownUntil
      if (typeof state.lastSuccessTime === 'number') this.lastSuccessTime = state.lastSuccessTime
      log('INFO', 'evolution_state_loaded', {
        tryRunFailures: this.tryRunFailures,
        cooldownActive: this.recoveryCooldownUntil > 0 && Date.now() < this.recoveryCooldownUntil,
      })
    } catch {
      log('WARN', 'evolution_state_load_failed')
    }
  }

  private saveState(): void {
    try {
      const state = {
        tryRunFailures: this.tryRunFailures,
        executeFailures: this.executeFailures,
        recoveryCooldownUntil: this.recoveryCooldownUntil,
        lastSuccessTime: this.lastSuccessTime,
        savedAt: Date.now(),
      }
      const dir = dirname(this.stateFilePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.stateFilePath, JSON.stringify(state, null, 2), 'utf-8')
    } catch {
      log('WARN', 'evolution_state_save_failed')
    }
  }
}
