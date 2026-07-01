/**
 * SelfEvolutionService — 进化调度编排器（薄层）
 *
 * 职责：
 * 1. 调度状态机（IDLE→ANALYZING→EXECUTING→VERIFYING→COOLDOWN）
 * 2. 编排 4 阶段流水线：Analyzer → Strategizer → Executor → Reviewer
 * 3. 系统状态持久化（冷却/失败计数跨重启）
 * 4. 安全模式管理、用户活跃保护、完整性检查
 *
 * 非职责（已下沉到各阶段）：
 * - LLM 分析/计划创建 → EvolutionAnalyzer
 * - 策略选择/评分 → EvolutionStrategizer
 * - 步骤执行/Git 回滚 → EvolutionExecutor
 * - 合规验证/回归检测 → EvolutionReviewer
 */

import { join, dirname } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { log } from '../logger/Logger'
import { scheduler, Scheduler } from '../core/Scheduler'
import { eventBus, EventBus } from '../core/EventBus'
import { withTimeout } from '../utils/async'
import { AsyncLock } from '../utils/AsyncLock'
import { PlanIntegrityChecker } from './PlanIntegrityChecker'
import { buildEvolutionSystemPrompt } from './SelfEvolutionPrompt'
import { EVOLUTION_SAFETY_MODE, WORKSPACE } from '../config'
import { EvolutionAnalyzer } from './pipeline/EvolutionAnalyzer'
import { EvolutionStrategizer } from './pipeline/EvolutionStrategizer'
import { EvolutionExecutor } from './pipeline/EvolutionExecutor'
import { EvolutionReviewer } from './pipeline/EvolutionReviewer'
import type { AgentService } from '../agent/AgentService'
import type { PlanManagerLike } from './types'
import { ResponseValidator } from './ResponseValidator'
import type { CognitiveService } from '../cognitive'
import type { ISubsystem, HealthCheckResult, SubsystemState } from '../core/lifecycle/types'
import type { AnalysisInput } from './pipeline/types'
import { PromptEvolutionManager, type PromptSlot } from './PromptEvolutionManager'
import { EvolutionSelfEvaluator } from './EvolutionSelfEvaluator'
import { MetaLearner } from './MetaLearner'
import { EvaluatorCalibrator } from './EvaluatorCalibrator'
import { ActionRegistry } from './ActionRegistry'
import { plan as planActions, formatActionPlan } from './ActionPlanner'
import { ExecutionTracer } from './ExecutionTracer'
import { IntentExtractor } from './IntentExtractor'
import { alignAll } from './TraceAligner'
import { PatternMiner } from './PatternMiner'
import { CapabilityCompiler } from './CapabilityCompiler'
import { CapabilityRegistry } from './CapabilityRegistry'
import { PreservationEngine } from './PreservationEngine'
import { EvolutionController } from './EvolutionController'
import { setCapabilityRegistry } from './ActionRegistry'
import type { ActionContext } from './ActionContext'
import { insertMessage, createMessageId } from '../db/messages'
import { getMainWindow } from '../core/Lifecycle'

// =============================================================================
// 调度状态机状态枚举
// =============================================================================

export enum EvolutionSchedulerState {
  IDLE = 'IDLE',
  ANALYZING = 'ANALYZING',
  EXECUTING = 'EXECUTING',
  VERIFYING = 'VERIFYING',
  COOLDOWN = 'COOLDOWN',
}

type SafetyMode = 'review' | 'auto'

const DEFAULT_HISTORY_PATH = join(WORKSPACE.evolution, 'history.json')

/**
 * SelfEvolutionService — 进化调度编排器
 *
 * 薄层协调器：维护调度状态机，编排 Analyzer→Strategizer→Executor→Reviewer 流水线。
 * 与外部系统（AgentService, PlanManager, CognitiveService）对接。
 */
export class SelfEvolutionService implements ISubsystem {
  readonly name = 'SelfEvolutionService'
  state: SubsystemState = 'created'

  // ==================== 外部依赖 ====================
  private agentService: AgentService
  private scheduler: Scheduler
  private eventBus: EventBus
  private planManager: PlanManagerLike | null = null
  private cognitiveService: CognitiveService | null = null

  // ==================== 内部阶段 ====================
  readonly analyzer: EvolutionAnalyzer
  readonly strategizer: EvolutionStrategizer
  readonly executor: EvolutionExecutor
  readonly reviewer: EvolutionReviewer

  // ==================== 调度状态机 ====================
  private schedulerState: EvolutionSchedulerState = EvolutionSchedulerState.IDLE
  private schedulerTickId: string | null = null
  /** 后备心跳间隔（30 分钟），事件驱动是主触发方式 */
  private schedulerTickMs: number = 30 * 60 * 1000
  private lastAnalysisTime: number = 0
  private lastExecutionTime: number = 0
  private lastRun: number = 0

  // ==================== 用户活跃保护 ====================
  private mioActive = false
  private mioActiveSince = 0
  private lastUserInputTime = 0
  private static readonly USER_COOLDOWN_MS = 5 * 60 * 1000
  private static readonly MIO_ACTIVE_TIMEOUT_MS = 10 * 60 * 1000

  // ==================== 安全 & 冷却 ====================
  private safetyMode: SafetyMode = EVOLUTION_SAFETY_MODE as SafetyMode
  private safetyModeAutoPromoted = false
  private tryRunFailures = 0
  private executeFailures = 0
  private maxFailures = 3
  private recoveryCooldownUntil = 0
  private lastSuccessTime = 0
  private intervalMs = 2 * 60 * 60 * 1000
  private readonly evolutionLock = new AsyncLock()

  // ==================== 自适应参数 ====================
  private firstRunComplete = false
  private analysisStuckTimeoutMs: number = 180_000

  // ==================== Phase 3: Meta Evolution ====================
  readonly promptEvolutionManager: PromptEvolutionManager
  readonly selfEvaluator: EvolutionSelfEvaluator
  readonly metaLearner: MetaLearner
  readonly evaluatorCalibrator: EvaluatorCalibrator
  private consecutiveCleanCycles = 0
  private consecutiveDegenerateDetections = 0

  // ==================== Phase 2: Intent Tracing ====================
  readonly intentExtractor: IntentExtractor

  // ==================== Phase 3: Capability Registry ================
  readonly patternMiner: PatternMiner
  readonly capabilityCompiler: CapabilityCompiler

  // ==================== Phase 4: PreservationEngine ==================
  readonly preservationEngine: PreservationEngine

  // ==================== Phase 5: EvolutionController ==================
  readonly evolutionController: EvolutionController

  // ==================== 状态持久化 ====================
  private stateFilePath: string
  private historyPath: string

  // ==================== 事件订阅清理 ====================
  private eventSubscriptions: (() => void)[] = []

  // ==================== 创造力建议缓存 ====================
  /** 最近一次来自创造力系统的优质假设，注入到下一次分析 prompt 中 */
  private creativityHypothesis: {
    title: string
    idea: string
    novelty: number
    feasibility: number
    impact: number
    expectedBenefit: string
    risk: string
  } | null = null

  constructor(
    agentService: AgentService,
    sched?: Scheduler,
    bus?: EventBus,
    planManager?: PlanManagerLike,
    options?: {
      historyPath?: string
      planExecTimeoutMs?: number
      analysisTimeoutMs?: number
      analysisStuckTimeoutMs?: number
      stepRetryBaseMs?: number
      maxLivingPlanBytes?: number
      stateFilePath?: string
      maxReasoningSteps?: number
      degenerationThreshold?: number
    },
  ) {
    this.agentService = agentService
    this.scheduler = sched || scheduler
    this.eventBus = bus || eventBus
    this.planManager = planManager || null

    this.historyPath = options?.historyPath || DEFAULT_HISTORY_PATH
    this.analysisStuckTimeoutMs = options?.analysisStuckTimeoutMs ?? 180_000
    this.stateFilePath = options?.stateFilePath ?? join(dirname(this.historyPath), 'living_plan', 'evolution_state.json')

    this.analyzer = new EvolutionAnalyzer(agentService, this.planManager, {
      historyPath: this.historyPath,
      maxLivingPlanBytes: options?.maxLivingPlanBytes ?? 4096,
      analysisTimeoutMs: options?.analysisTimeoutMs ?? 120000,
      degenerationThreshold: options?.degenerationThreshold ?? 3,
    })
    this.strategizer = new EvolutionStrategizer({
      scoreFilePath: join(WORKSPACE.evolution, 'strategy_scores.json'),
    })
    this.executor = new EvolutionExecutor(agentService, this.planManager, {
      planExecTimeoutMs: options?.planExecTimeoutMs ?? 300000,
      stepRetryBaseMs: options?.stepRetryBaseMs ?? 1000,
    })
    this.reviewer = new EvolutionReviewer(this.createResponseValidator(), {
      gitOps: null,
    })

    // Phase 3: Meta Evolution
    this.promptEvolutionManager = new PromptEvolutionManager()
    this.selfEvaluator = new EvolutionSelfEvaluator()
    this.metaLearner = new MetaLearner()
    this.evaluatorCalibrator = new EvaluatorCalibrator()

    // Phase 2: 意图追踪
    this.intentExtractor = new IntentExtractor()

    // Phase 3: 能力编译
    const capabilityRegistry = new CapabilityRegistry()
    this.patternMiner = new PatternMiner()
    this.capabilityCompiler = new CapabilityCompiler(capabilityRegistry)

    // 将 CapabilityRegistry 注入到 ActionRegistry（无循环依赖）
    setCapabilityRegistry(capabilityRegistry)

    // Phase 4: PreservationEngine
    this.preservationEngine = new PreservationEngine(capabilityRegistry)

    // Phase 5: EvolutionController
    this.evolutionController = new EvolutionController()

    this.loadState()

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

    // 事件驱动触发订阅（事件冷却 5min，避免风暴）
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
      // Phase 2: 接收创造力系统的高分假设
      (this.eventBus.on as any)('creativity.hypothesis.selected', (p: any) => {
        this.creativityHypothesis = {
          title: p.title,
          idea: p.idea,
          novelty: p.novelty,
          feasibility: p.feasibility,
          impact: p.impact,
          expectedBenefit: p.expectedBenefit,
          risk: p.risk,
        }
        log('INFO', 'evolution_received_creativity_hypothesis', {
          title: p.title,
          score: p.novelty + p.feasibility + p.impact,
        })
      }) as any,
      // 将进化结果持久化为 UI 消息
      (this.eventBus.on as any)('evolution.cycle.completed', (p: any) => {
        this.persistEvolutionMessage(p.summary, p.success, p.durationMs)
      }) as any,
    )
  }

  private eventCooldownUntil = 0
  private static readonly EVENT_COOLDOWN_MS = 5 * 60 * 1000

  /**
   * 事件触发入口：带冷却保护，防止事件风暴导致频繁分析
   */
  private onTriggerEvent(event: string, payload: any): void {
    if (Date.now() < this.eventCooldownUntil) {
      log('INFO', 'evolution_trigger_event_cooldown', { event, remainingMs: this.eventCooldownUntil - Date.now() })
      return
    }
    // 状态机保护：只在 IDLE 时触发
    if (this.schedulerState !== EvolutionSchedulerState.IDLE) {
      log('INFO', 'evolution_trigger_event_busy', { event, state: this.schedulerState })
      return
    }
    this.eventCooldownUntil = Date.now() + SelfEvolutionService.EVENT_COOLDOWN_MS
    log('INFO', 'evolution_trigger_event', { event, payload })
    this.runAnalysisCycle()
  }

  private createResponseValidator(): ResponseValidator {
    return new ResponseValidator(this.eventBus)
  }

  // ==================== ISubsystem ====================

  async init(): Promise<void> {
    this.state = 'initializing'
    await Promise.all([this.analyzer.init(), this.strategizer.init(), this.executor.init(), this.reviewer.init()])
    this.state = 'ready'
  }

  async start(): Promise<void> {
    this.state = 'running'
    await Promise.all([this.analyzer.start(), this.strategizer.start(), this.executor.start(), this.reviewer.start()])
  }

  async stop(): Promise<void> {
    this.state = 'stopping'
    this.stopExistingTick()
    this.disposeEventSubscriptions()
    await Promise.all([this.analyzer.stop(), this.strategizer.stop(), this.executor.stop(), this.reviewer.stop()])
    this.state = 'stopped'
  }

  async destroy(): Promise<void> {
    this.disposeEventSubscriptions()
    await Promise.all([this.analyzer.destroy(), this.strategizer.destroy(), this.executor.destroy(), this.reviewer.destroy()])
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
    if (!this.firstRunComplete) {
      log('INFO', 'evolution_warmup_first_run')
      await this.warmupFirstRun()
    }
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
  getExecuteFailures(): number {
    return this.executeFailures
  }

  getRecoveryCooldown(): { active: boolean; remainingMs: number } {
    if (this.recoveryCooldownUntil === 0 || Date.now() > this.recoveryCooldownUntil) {
      return { active: false, remainingMs: 0 }
    }
    return { active: true, remainingMs: this.recoveryCooldownUntil - Date.now() }
  }

  setSafetyMode(mode: SafetyMode): void {
    this.safetyMode = mode
    this.executor.setSafetyMode(mode)
    log('INFO', 'evolution_safety_mode', { mode })
  }

  setVerificationRunner(runner: any, verifyAfter?: boolean): void {
    this.reviewer.setVerificationRunner(runner, verifyAfter)
  }

  setRegressionDetector(detector: any): void {
    this.reviewer.setRegressionDetector(detector)
  }

  setCognitiveService(cs: CognitiveService | null): void {
    this.cognitiveService = cs
  }

  setProposalValidator(v: any): void {
    this.executor.setProposalValidator(v)
    this.reviewer.setProposalValidator(v)
  }

  setGitOps(gitOps: any): void {
    this.executor.setGitOps(gitOps)
    this.reviewer.setGitOps(gitOps)
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

    if (this.agentService.isBusy()) {
      if (
        this.lastRun > 0 &&
        Date.now() - this.lastRun > this.analyzer.getAnalysisTimeout() &&
        this.schedulerState === EvolutionSchedulerState.ANALYZING
      ) {
        log('WARN', 'scheduler_tick_stale_abort', { state: this.schedulerState, ageMs: Date.now() - this.lastRun })
        this.agentService.abortSelfTask?.()
        await new Promise((r) => setTimeout(r, 300))
        if (!this.agentService.isBusy()) this.transitionState(EvolutionSchedulerState.IDLE, '残留分析任务已中止')
        else return
      } else return
    }

    // 冷却恢复
    if (this.recoveryCooldownUntil > 0) {
      if (Date.now() > this.recoveryCooldownUntil) {
        this.tryRunFailures = 0
        this.executeFailures = 0
        this.executor.resetFailures()
        this.recoveryCooldownUntil = 0
        this.transitionState(EvolutionSchedulerState.IDLE, '冷却期结束')
      } else return
    }

    switch (this.schedulerState) {
      case EvolutionSchedulerState.IDLE: {
        const hoursSinceLastAnalysis = (Date.now() - this.lastAnalysisTime) / (1000 * 60 * 60)
        if (this.lastAnalysisTime === 0 || hoursSinceLastAnalysis >= Math.max(this.intervalMs / (1000 * 60 * 60), 1)) {
          if (!this.firstRunComplete) {
            log('INFO', 'scheduler_tick_warmup_before_first_analysis')
            await this.warmupFirstRun()
          }
          this.transitionState(EvolutionSchedulerState.ANALYZING, `距上次分析 ${hoursSinceLastAnalysis.toFixed(1)}h`)
          await this.runAnalysisCycle()
        }
        break
      }
      case EvolutionSchedulerState.ANALYZING: {
        if (Date.now() - this.lastAnalysisTime > this.analysisStuckTimeoutMs) {
          log('WARN', 'scheduler_tick_analysis_stuck_timeout', {
            ageMs: Date.now() - this.lastAnalysisTime,
            timeoutMs: this.analysisStuckTimeoutMs,
          })
          this.agentService.abortSelfTask?.()
          this.transitionState(EvolutionSchedulerState.IDLE, '分析任务被强制中止（合并超时）')
        }
        break
      }
      case EvolutionSchedulerState.EXECUTING: {
        if (Date.now() - this.lastExecutionTime > 600000) {
          log('WARN', 'scheduler_tick_executing_stuck', { lastExecAgeMs: Date.now() - this.lastExecutionTime })
          this.agentService.abortSelfTask?.()
          this.transitionState(EvolutionSchedulerState.IDLE, '执行任务被强制中止')
        }
        break
      }
      case EvolutionSchedulerState.VERIFYING: {
        if (Date.now() - this.lastExecutionTime > 900000) this.transitionState(EvolutionSchedulerState.IDLE, '验证阶段超时')
        break
      }
      case EvolutionSchedulerState.COOLDOWN:
        break
    }
  }

  // ==================== 分析循环 ====================

  private async runAnalysisCycle(): Promise<void> {
    this.transitionState(EvolutionSchedulerState.ANALYZING, '开始分析循环')
    this.lastAnalysisTime = Date.now()
    this.reviewer.startListen()

    await this.evolutionLock.run(async () => {
      if (this.agentService.isBusy()) {
        if (this.lastRun > 0 && Date.now() - this.lastRun > this.analyzer.getAnalysisTimeout()) {
          this.agentService.abortSelfTask?.()
          await new Promise((r) => setTimeout(r, 300))
          if (this.agentService.isBusy()) {
            this.transitionState(EvolutionSchedulerState.IDLE, '残留任务无法清除')
            return
          }
        } else {
          this.transitionState(EvolutionSchedulerState.IDLE, 'agent 正忙')
          return
        }
      }

      if (this.recoveryCooldownUntil > 0 && Date.now() > this.recoveryCooldownUntil) {
        this.tryRunFailures = 0
        this.executeFailures = 0
        this.executor.resetFailures()
        this.recoveryCooldownUntil = 0
      }

      // 退化检测与恢复 — 渐进式降级 + 自愈
      if (this.analyzer.isDegenerate()) {
        this.consecutiveDegenerateDetections++

        // 1. 切换到 review 安全模式
        if (this.safetyMode !== 'review') {
          this.safetyMode = 'review'
          this.executor.setSafetyMode('review')
          this.safetyModeAutoPromoted = false // 不允许自动回到 auto
          log('WARN', 'evolution_degenerate_safety_review', { safetyMode: this.safetyMode })
        }
        // Phase 3: 严重退化 → 演化 prompt（LLM 驱动）
        if (this.consecutiveDegenerateDetections >= 2) {
          const fp = this.analyzer.getFingerprints()
          const failureSummary = this.analyzer
            .loadRecentFailures()
            .slice(-3)
            .map((f) => `${f.task}: ${f.error}`)
            .join('\n')
          this.promptEvolutionManager.llmEvolvePrompt(
            'analysis_prompt',
            '退化检测：连续产生相同分析结论',
            `指纹: ${fp.slice(-3).join(' → ')}\n${failureSummary}`,
            this.agentService,
          )
          this.promptEvolutionManager.llmEvolvePrompt(
            'system_prompt',
            '退化检测：连续产生相同分析结论',
            `指纹: ${fp.slice(-3).join(' → ')}\n${failureSummary}`,
            this.agentService,
          )
        }
        // 2. 检查最后一次非退化输出年龄（>12h 强制降级清空指纹历史）
        const fingerprintAgeMs = this.analyzer.getFingerprintAgeMs()
        if (fingerprintAgeMs > 12 * 60 * 60 * 1000) {
          log('WARN', 'evolution_degenerate_recovery_timeout', { fingerprintAgeMs })
          this.analyzer.resetFingerprints()
          this.analyzer.resetDegenerationCount()
          this.consecutiveDegenerateDetections = 0
          if (this.safetyMode === 'review' && this.tryRunFailures < this.maxFailures) {
            this.safetyMode = 'auto'
            this.executor.setSafetyMode('auto')
            log('INFO', 'evolution_degenerate_recovery_auto_promoted')
          }
        } else {
          // 3. 渐进式 backoff：连续退化次数越多，跳过越久
          const backoffMs = Math.min(this.consecutiveDegenerateDetections * 30 * 60 * 1000, 4 * 60 * 60 * 1000)
          log('WARN', 'evolution_skip_degenerate', {
            consecutiveDegenerateDetections: this.consecutiveDegenerateDetections,
            backoffMinutes: Math.round(backoffMs / 60000),
          })
          this.transitionState(EvolutionSchedulerState.COOLDOWN, `退化检测跳过 (backoff ${Math.round(backoffMs / 60000)}min)`)
          if (this.recoveryCooldownUntil === 0 || this.recoveryCooldownUntil < Date.now() + backoffMs) {
            this.recoveryCooldownUntil = Date.now() + backoffMs
          }
          return
        }
      } else {
        // 连续健康运行 → 逐步降低退化计数
        if (this.consecutiveDegenerateDetections > 0) {
          this.consecutiveDegenerateDetections = Math.max(0, this.consecutiveDegenerateDetections - 1)
        }
      }

      let degradedMode = false
      if (this.tryRunFailures >= this.maxFailures) {
        if (this.recoveryCooldownUntil > 0 && Date.now() <= this.recoveryCooldownUntil) return
        degradedMode = true
      }

      this.lastRun = Date.now()
      this.eventBus.emit('evolution.cycle.started', { timestamp: this.lastRun, failures: this.tryRunFailures })
      this.performIntegrityCheck()

      const strategy = this.strategizer.select({
        consecutiveFailures: this.tryRunFailures,
        isFirstRun: this.lastRun === 0,
        isRecovering: this.recoveryCooldownUntil > 0 && Date.now() <= this.recoveryCooldownUntil,
        hoursSinceLastRun: this.lastRun > 0 ? (Date.now() - this.lastRun) / (1000 * 60 * 60) : 0,
        isDegenerate: this.analyzer.isDegenerate(),
      })

      // Phase 5: EvolutionController 三角决策
      const controllerDecision = this.evolutionController.decide({
        patterns: this.patternMiner.mine(),
        capabilities: this.capabilityCompiler.getRegistry().list(),
        consecutiveFailures: this.tryRunFailures,
        isDegenerate: this.analyzer.isDegenerate(),
        selfEvalTrend: this.selfEvaluator?.getTrend(),
      })
      // 如果控制器不健康，强制切换到 preserve
      const evolutionDirection = controllerDecision.direction
      log('INFO', 'evolution_controller_direction', {
        direction: evolutionDirection,
        expandMode: controllerDecision.expandMode,
        healthy: this.evolutionController.isHealthy(),
      })

      this.analyzer.setAnalysisTimeout(strategy.timeoutMs)
      this.analyzer.setPromptTrimMode(strategy.trimMode)
      this.analyzer.setHistoryMaxEntries(strategy.maxHistoryEntries)
      // Phase 3: 注入 prompt overlay
      this.analyzer.setPromptOverlay(this.promptEvolutionManager.getOverlay('analysis_prompt'))

      const planDetection = this.analyzer.detectPlanMode()
      const effectiveMode = degradedMode ? 'review_only' : planDetection.mode
      const effectiveSafety = degradedMode ? 'review' : this.safetyMode
      const input: AnalysisInput = {
        mode: effectiveMode,
        planContext: planDetection.planContext,
        historySummary: this.analyzer.getHistorySummary(),
        safetyMode: effectiveSafety,
        validationSummary: this.reviewer.getLastValidationSummary(),
        livingPlanCtx: this.analyzer.buildLivingPlanContext(),
        cognitiveCtx: this.cognitiveService?.getFormattedContext() || '',
        strategyCtx: this.strategizer.getFormattedContext(),
        creativityCtx: this.creativityHypothesis
          ? [
              '【创造力系统建议】',
              `标题: ${this.creativityHypothesis.title}`,
              `描述: ${this.creativityHypothesis.idea}`,
              `评分: 新颖=${this.creativityHypothesis.novelty} 可行=${this.creativityHypothesis.feasibility} 影响=${this.creativityHypothesis.impact}`,
              `预期收益: ${this.creativityHypothesis.expectedBenefit}`,
              `风险: ${this.creativityHypothesis.risk}`,
              '以上是创造力系统产出的改进建议。请评估是否值得纳入本次分析/计划，',
              '如果是则作为计划的一部分执行，如果不是则说明理由。',
            ].join('\n')
          : undefined,
        promptMode: strategy.promptMode,
      }

      let result: Awaited<ReturnType<typeof this.analyzer.analyze>> | null = null

      try {
        // 廉价预过滤：检查是否有必要运行 LLM 分析
        const preCheck = this.analyzer.shouldAnalyze()
        if (!preCheck.shouldRun) {
          log('INFO', 'evolution_skip_prefilter', { reason: preCheck.reason })
          this.eventBus.emit('evolution.cycle.completed', {
            success: true,
            summary: `预过滤跳过: ${preCheck.reason}`,
            timestamp: Date.now(),
            durationMs: 0,
            planCreated: false,
            mode: effectiveMode,
            safetyMode: effectiveSafety,
            strategyName: strategy.name,
            promptMode: strategy.promptMode,
            historyCount: this.analyzer.getHistorySummary()?.length || 0,
            failures: this.tryRunFailures,
            degradedMode,
            planMode: planDetection.mode,
          })
          this.saveState()
          return
        }

        result = await this.analyzer.analyze(input)
        this.analyzer.recordFingerprint(result.summary)

        // Phase 3: 自评估结果（在多个 if 块中共享）
        let selfEval: any = null

        if (result.success) {
          this.tryRunFailures = 0
          this.lastSuccessTime = Date.now()
          this.recoveryCooldownUntil = 0
          this.handleRecoveryParam()
          if (this.safetyMode === 'review' && !this.safetyModeAutoPromoted) {
            this.safetyMode = 'auto'
            this.safetyModeAutoPromoted = true
          }
          if (this.cognitiveService) {
            try {
              await this.cognitiveService.adjustByToken(this.analyzer.loadRecentFailures())
            } catch {
              log('WARN', 'cognitive_adjust_skipped')
            }
          }

          // Phase 3: 自评估 + prompt 性能记录
          if (result.success) {
            try {
              const activePlan = this.planManager?.getActivePlan()
              selfEval = this.selfEvaluator.evaluate({
                strategyName: strategy.name,
                promptMode: strategy.promptMode,
                analysisSummary: result.summary,
                planCreated: result.planCreated,
                planSteps: activePlan?.steps.map((s: any) => s.description) || [],
                recentHistory: this.analyzer.getFingerprints(),
                analysisMode: effectiveMode,
              })
              this.eventBus.emit('evolution.self.evaluated' as any, {
                cycleTimestamp: this.lastRun,
                strategyName: strategy.name,
                score: selfEval.score,
                dimensions: selfEval.dimensions,
                feedback: selfEval.feedback,
              })
              // 持久化 self-evaluator 到 EngineeringMemory
              if (this.agentService['memoryService']?.engineering) {
                this.selfEvaluator.injectEngineering(this.agentService['memoryService'].engineering)
              }
              // 微调策略分
              this.strategizer.getLearner().applySelfEvaluation(strategy.name, selfEval.score)
              // Phase 3: 自评估 → 元学习引导定向策略变异闭环
              const trend = this.selfEvaluator.getTrend()
              const recommendation = this.selfEvaluator.getStrategyRecommendation()
              if (trend === 'stagnant' || trend === 'downward') {
                try {
                  // 元学习检查是否应抑制变异
                  if (this.metaLearner.shouldSuppressMutation()) {
                    log('INFO', 'strategy_mutation_suppressed_by_metalearner')
                  } else {
                    // MetaLearner 推荐变异参数（比随机选择更智能）
                    const metaRec = this.metaLearner.recommendMutationParam({
                      strategyName: strategy.name,
                      currentScore: selfEval.score,
                    })
                    const targetDim = recommendation.targetDimension || undefined
                    const mutation = this.strategizer
                      .getLearner()
                      .getMutator()
                      .mutate(this.strategizer.getLearner().getCycleHistory(), targetDim)
                    if (mutation) {
                      // Track in MetaLearner
                      this.metaLearner.recordMutation({
                        parentStrategy: mutation.parent,
                        childStrategy: mutation.child,
                        paramName: metaRec.paramName || mutation.reason,
                        oldValue: 'parent',
                        newValue: mutation.child,
                        operation: mutation.operation,
                      })
                      log('INFO', 'strategy_mutated_from_selfeval', {
                        parent: mutation.parent,
                        child: mutation.child,
                        operation: mutation.operation,
                        trend,
                        metaInsight: metaRec.insight,
                      })
                    }
                  }
                } catch {
                  log('WARN', 'strategy_mutation_skipped')
                }
              }
              // 记录到 prompt 版本
              this.promptEvolutionManager.recordCycleResult(
                'analysis_prompt',
                this.promptEvolutionManager.getCurrentVersion('analysis_prompt'),
                true,
                selfEval.score,
              )
            } catch {
              log('WARN', 'self_evaluation_skipped')
            }
          } else {
            this.promptEvolutionManager.recordCycleResult(
              'analysis_prompt',
              this.promptEvolutionManager.getCurrentVersion('analysis_prompt'),
              false,
            )
          }
        } else {
          this.tryRunFailures++
          if (this.tryRunFailures >= this.maxFailures && this.recoveryCooldownUntil === 0)
            this.recoveryCooldownUntil = Date.now() + this.intervalMs
        }

        this.strategizer.evaluate(strategy.name, {
          success: result.success,
          durationMs: Date.now() - this.lastRun,
          planCreated: result.planCreated,
          stepsPlanned: 0,
          hadTimeout: result.hadTimeout,
          hadRetry: result.hadRetry,
          promptTrimmed: strategy.trimMode,
        })

        // Phase 3: 参数调优 — 应用 tuneParameters 结果
        if (result.success) {
          const tuningResult = this.strategizer.getLearner().tuneParameters()
          for (const adj of tuningResult) {
            if (adj.parameter === 'timeoutMs') this.analyzer.setAnalysisTimeout(adj.newValue as number)
            if (adj.parameter === 'trimMode') this.analyzer.setPromptTrimMode(adj.newValue as boolean)
          }
          if (tuningResult.length > 0) {
            log('INFO', 'strategy_params_tuned', { adjustments: tuningResult })
          }
          // Phase 3: 记录 outcome（演化结果）
          if (selfEval) {
            this.selfEvaluator.recordOutcome(selfEval.score, result.planCreated)
            // Phase 3: 评估器自校准（每轮记录，每 5 轮实际校准一次）
            this.evaluatorCalibrator.recordSample(selfEval.dimensions, selfEval.score, result.planCreated)
          }
          if (this.evaluatorCalibrator.getCalibrationStats().sampleCount % 5 === 0) {
            const calResult = this.evaluatorCalibrator.calibrate()
            if (calResult.sampleSize >= 5) {
              log('INFO', 'evaluator_weights_adjusted', { delta: calResult.delta })
            }
          }
          // Phase 3: 元学习周期增长
          this.metaLearner.incrementCycle()
          if (this.metaLearner.getCycleCount() % 5 === 0) {
            const metaSummary = this.metaLearner.getMetaSummary()
            if (metaSummary) {
              log('INFO', 'meta_learning_summary', { insight: metaSummary.insight })
            }
          }
          // Phase 3: prompt 总结/清理
          for (const slot of ['analysis_prompt', 'system_prompt'] as const) {
            try {
              const compact = this.promptEvolutionManager.shouldCompact(slot)
              if (compact.needSummarize) {
                this.promptEvolutionManager.summarizeOverlays(slot)
              }
              if (compact.needPrune) {
                this.promptEvolutionManager.pruneStaleRules(slot)
              }
            } catch {}
          }
        }

        // Phase 4: 对所有能力执行 preservation 评估
        const preservationSummary = this.preservationEngine.evaluateAll()
        this.eventBus.emit('evolution.preservation.completed' as any, preservationSummary)
        log('INFO', 'preservation_summary', {
          total: preservationSummary.total,
          passed: preservationSummary.passed,
          failed: preservationSummary.failed,
          avgScore: preservationSummary.avgScore,
        })

        this.saveState()
        this.eventBus.emit('evolution.cycle.completed', {
          success: result.success,
          summary: result.summary,
          timestamp: Date.now(),
          durationMs: Date.now() - this.lastRun,
          planCreated: result.planCreated,
          mode: effectiveMode,
          safetyMode: effectiveSafety,
          strategyName: strategy.name,
          promptMode: strategy.promptMode,
          planTitle: result.planSummary?.title,
          planProgress: result.planSummary ? `${result.planSummary.stepsComplete}/${result.planSummary.stepsTotal}` : undefined,
          historyCount: this.analyzer.getHistorySummary()?.length || 0,
          failures: this.tryRunFailures,
          degradedMode,
          planMode: planDetection.mode,
        })
        // Phase 3: 通知创造力系统本次分析结果
        this.eventBus.emit('evolution.plan.outcome' as any, {
          success: result.success,
          summary: result.summary.slice(0, 500),
          planTitle: result.planSummary?.title,
          stepsCompleted: (result as any).stepsCompleted ?? 0,
          stepsTotal: (result as any).stepsTotal ?? 0,
          hadTimeout: result.hadTimeout,
          hadRetry: result.hadRetry,
          durationMs: Date.now() - this.lastRun,
        })

        // Phase 4: 执行 preservation 清理（归档/降级冷能力）
        try {
          const pruned = this.preservationEngine.prune()
          if (pruned > 0) {
            log('INFO', 'preservation_pruned', { count: pruned })
          }
        } catch (err: any) {
          log('WARN', 'preservation_prune_skipped', { error: err.message })
        }
      } catch (err: any) {
        this.tryRunFailures++
        this.analyzer.setAnalysisTimeout(Math.min(Math.round(this.analyzer.getAnalysisTimeout() * 1.25), 300000))
        this.analyzer.setPromptTrimMode(true)
        this.analyzer.setHistoryMaxEntries(2)
        this.agentService.abortSelfTask?.()
        if (this.tryRunFailures >= this.maxFailures && this.recoveryCooldownUntil === 0)
          this.recoveryCooldownUntil = Date.now() + Math.min(this.intervalMs, 30 * 60 * 1000)
        this.saveState()
        log('ERROR', 'evolution_cycle_error', { error: String(err), failures: this.tryRunFailures })

        // 即使在 evolution 失败时也尝试执行 cognitive 反馈
        // 使 cognitive 的"暂停目标"建议在超时/失败场景下也能生效
        if (this.cognitiveService) {
          try {
            await this.cognitiveService.adjustByToken(this.analyzer.loadRecentFailures())
          } catch {
            log('WARN', 'cognitive_adjust_skipped_on_error')
          }
        }
        this.eventBus.emit('evolution.cycle.completed', {
          success: false,
          summary: `Error: ${err.message}`,
          timestamp: Date.now(),
          durationMs: Date.now() - this.lastRun,
          planCreated: false,
          mode: effectiveMode,
          safetyMode: effectiveSafety,
          strategyName: strategy.name,
          historyCount: this.analyzer.getHistorySummary()?.length || 0,
          failures: this.tryRunFailures,
          degradedMode,
          planMode: planDetection.mode,
        })
        this.strategizer.evaluate(strategy.name, {
          success: false,
          durationMs: Date.now() - this.lastRun,
          planCreated: false,
          stepsPlanned: 0,
          hadTimeout: true,
          hadRetry: true,
          promptTrimmed: strategy.trimMode,
        })
      }

      // 分析完成后自动触发执行：从分析结果中提取动作并执行
      if (this.safetyMode !== 'review' && result.success) {
        // Phase 1: 创建 execution trace，作为 capability 编译的 IR
        const tracer = new ExecutionTracer('evolution_self')
        tracer.recordState(
          'analysis_complete',
          {
            mode: effectiveMode,
            strategy: strategy.name,
            planMode: planDetection.mode,
            planCreated: result.planCreated,
          },
          { success: result.success, summaryLen: result.summary?.length || 0 },
        )

        const actionPlan = planActions(result, tracer, this.capabilityCompiler.getRegistry().list())
        if (actionPlan.actions.length > 0) {
          const actionName = actionPlan.actions.map((a) => a.name).join(', ')
          log('INFO', 'evolution_action_plan', { actions: actionName })

          const ctx: ActionContext = {
            agentService: this.agentService,
            eventBus: this.eventBus,
            projectRoot: process.cwd(),
            tracer,
          }

          await this.runActionCycle(actionPlan, ctx)
        } else {
          log('INFO', 'evolution_action_plan_empty')
        }

        // 持久化 trace
        tracer.persist()

        // Phase 2: 尝试将最近的 intent trace 与 execution trace 对齐
        const completedIntents = this.intentExtractor.getCompletedTraces()
        if (completedIntents.length > 0) {
          const aligned = alignAll(completedIntents, [tracer.getTrace() as any])
          if (aligned.length > 0) {
            log('INFO', 'trace_aligned', {
              intentGoal: aligned[0].intent.abstractGoal,
              score: aligned[0].alignmentScore,
              executionNodes: aligned[0].execution.nodes.length,
            })
          }
        }

        // Phase 3: 挖掘已有 trace 中的模式并编译
        const patterns = this.patternMiner.mine()
        const compiled = this.capabilityCompiler.compileAll(patterns)
        if (compiled.length > 0) {
          log('INFO', 'new_capabilities_compiled', {
            count: compiled.length,
            ids: compiled.map((c) => c.id),
          })
          // Phase 4: 对新编译的能力执行 preservation 检查
          for (const cap of compiled) {
            const report = this.preservationEngine.evaluate(cap)
            if (report.overallScore < 0.35) {
              log('WARN', 'preservation_new_capability_failed', {
                id: cap.id,
                score: report.overallScore,
                action: report.recommendedAction,
              })
            }
          }
        }
      }
    })
  }

  // ==================== 动作执行循环（替代旧的 executor 执行） ====================

  private async runActionCycle(actionPlan: import('./ActionPlanner').ActionSequence, ctx?: ActionContext): Promise<void> {
    this.transitionState(EvolutionSchedulerState.EXECUTING, `动作计划: ${actionPlan.actions.map((a) => a.name).join(' → ')}`)
    ctx?.tracer?.recordState('run_action_cycle', { actionCount: actionPlan.actions.length }, {})
    this.lastExecutionTime = Date.now()
    this.reviewer.startListen()

    const outcomes: { name: string; result: import('./ActionRegistry').ActionResult }[] = []

    for (const action of actionPlan.actions) {
      // 将 ActionContext 传递给 action.run()
      const outcome = await action.run({}, ctx)
      outcomes.push({ name: action.name, result: outcome })

      // Trace: record each action outcome
      ctx?.tracer?.recordTool(action.name, {}, outcome, { token: 0, latency: outcome.durationMs })

      if (outcome.success) {
        log('INFO', 'action_success', { action: action.name, summary: outcome.summary })
      } else {
        log('WARN', 'action_failed', { action: action.name, error: outcome.summary })
        this.executeFailures++
        if (this.executeFailures >= this.maxFailures && this.recoveryCooldownUntil === 0) {
          this.recoveryCooldownUntil = Date.now() + Math.min(this.intervalMs, 30 * 60 * 1000)
        }
        break
      }
    }

    // 成功后验证
    const allSucceeded = outcomes.every((o) => o.result.success)
    if (allSucceeded) {
      this.executeFailures = 0
      this.transitionState(EvolutionSchedulerState.VERIFYING, `${outcomes.length} 个动作执行成功，开始验证`)
      const changedFiles = await this.collectChangedFiles()
      await this.reviewer.verify(changedFiles)
      await this.reviewer.detectRegression(changedFiles)
    }

    this.reviewer.stopAndValidate('execute')
    this.transitionState(
      EvolutionSchedulerState.IDLE,
      `动作循环结束 (${outcomes.filter((o) => o.result.success).length}/${outcomes.length} 成功)`,
    )

    // 产出用户可见的消息
    this.persistActionResult(actionPlan, outcomes)
  }

  /** 将动作执行结果持久化为 UI 消息 */
  private persistActionResult(
    actionPlan: import('./ActionPlanner').ActionSequence,
    outcomes: { name: string; result: import('./ActionRegistry').ActionResult }[],
  ): void {
    const allOk = outcomes.every((o) => o.result.success)
    const totalMs = outcomes.reduce((s, o) => s + o.result.durationMs, 0)
    const lines = outcomes.map((o) => `${o.result.success ? '✓' : '✗'} ${o.name}: ${o.result.summary} (${o.result.durationMs}ms)`)
    const summary = [
      `[自进化执行] ${allOk ? '✅ 成功' : '⚠️ 部分完成'} (${totalMs}ms)`,
      '',
      ...lines,
      '',
      `触发来源: ${actionPlan.context.triggeredBy.slice(0, 200)}`,
    ].join('\n')

    try {
      const msg = {
        id: createMessageId(),
        source: 'electron' as const,
        role: 'assistant' as const,
        content: summary,
        category: 'evolution',
        sessionId: SelfEvolutionService.EVOLUTION_SESSION_ID,
        createdAt: Date.now(),
      }
      insertMessage(msg)
      const win = getMainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('message:new', msg)
      }

      // 通过 EventBus 通知 Telegram push（已订阅 evolution.action.executed）
      this.eventBus.emit('evolution.action.executed' as any, {
        text: summary,
        allOk,
        actionCount: outcomes.length,
        durationMs: totalMs,
        details: outcomes.map((o) => ({
          name: o.name,
          success: o.result.success,
          summary: o.result.summary,
          durationMs: o.result.durationMs,
        })),
      })
    } catch (err) {
      log('WARN', 'evolve_persist_action_failed', { error: String(err) })
    }
  }

  // ==================== 首次预热 ====================

  private async warmupFirstRun(): Promise<void> {
    log('INFO', 'evolution_warmup_start')
    try {
      const result = await withTimeout(
        () =>
          this.agentService.runAgentTask(
            '【预热测试】请调用 analyze_codebase 快速检查项目状态，然后回复"预热完成"。不要创建计划。',
            '你是秋山澪的自进化系统。当前是预热模式。请调用 analyze_codebase(quick=true) 然后回复。',
          ),
        30000,
        'warmup_timeout',
      )
      if (result.success) {
        this.firstRunComplete = true
        log('INFO', 'evolution_warmup_done')
      }
    } catch (err: any) {
      log('WARN', 'evolution_warmup_failed', { error: String(err) })
    }
  }

  // ==================== 完整性检查 ====================

  private performIntegrityCheck(): void {
    const pm = this.planManager
    if (!pm) return

    // 自动清理：删除 7 天前完成的计划 + 30 天前放弃的计划
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
        log('WARN', 'evolution_integrity_check_failed', { error_count: result.issues.filter((i: any) => i.severity === 'error').length })
        for (const p of allPlans) {
          if (p.status === 'active') {
            // 无步骤的计划自动标记为 abandoned
            if (!p.steps || p.steps.length === 0) {
              pm.updatePlanStatus(p.id, 'abandoned')
              log('INFO', 'evolution_plan_auto_abandoned', { planId: p.id, reason: '计划没有步骤' })
              continue
            }
            const fixResult = checker.autoFix(p)
            if (fixResult.fixed > 0)
              for (let i = 0; i < p.steps.length; i++) pm.updateStep(p.id, i, p.steps[i].status as any, p.steps[i].result)
          }
        }
      }
    } catch (err: any) {
      log('ERROR', 'evolution_integrity_check_error', { error: String(err) })
    }
  }

  // ==================== 自适应参数恢复 ====================

  private handleRecoveryParam(): void {
    if (this.analyzer.getPromptTrimMode()) {
      this.analyzer.setPromptTrimMode(false)
      log('INFO', 'evolution_param_recovery_promptTrimMode_reset')
    }
    if (this.analyzer.getHistoryMaxEntries() < 5) this.analyzer.setHistoryMaxEntries(Math.min(this.analyzer.getHistoryMaxEntries() + 1, 5))
    const timeout = this.analyzer.getAnalysisTimeout()
    if (timeout < 300_000 && timeout > 120_000) this.analyzer.setAnalysisTimeout(Math.max(120_000, Math.round(timeout * 0.9)))

    // Phase 3: 连续健康 → 重置 prompt 到基版本
    if (this.consecutiveDegenerateDetections === 0 && this.tryRunFailures === 0) {
      this.consecutiveCleanCycles++
      if (this.consecutiveCleanCycles >= 2) {
        this.promptEvolutionManager.resetToBase('analysis_prompt')
        this.promptEvolutionManager.resetToBase('system_prompt')
        this.consecutiveCleanCycles = 0
        log('INFO', 'prompt_reset_clean_cycles')
      }
    } else {
      this.consecutiveCleanCycles = 0
    }
  }

  // ==================== 状态转换 ====================

  private transitionState(newState: EvolutionSchedulerState, reason: string): void {
    const oldState = this.schedulerState
    this.schedulerState = newState
    log('INFO', 'scheduler_state_transition', { from: oldState, to: newState, reason })
    this.eventBus.emit('evolution.scheduler.state' as any, { from: oldState, to: newState, reason, timestamp: Date.now() })
  }

  // ==================== 辅助方法 ====================

  private async collectChangedFiles(): Promise<{ newFiles: string[]; modifiedFiles: string[] }> {
    try {
      const { EvolutionGitOps } = require('./EvolutionGitOps')
      return await new EvolutionGitOps().collectChangedFiles()
    } catch {
      return { newFiles: [], modifiedFiles: [] }
    }
  }

  // ==================== 将进化结果发送到 UI ====================

  /** 固定的 evolution 会话 ID，用于在 UI 中展示进化消息 */
  private static readonly EVOLUTION_SESSION_ID = 'session_evolution'

  /**
   * 将进化分析结果持久化为 assistant 消息，显示在 chat 会话中。
   */
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
      // 发送到渲染进程
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
      if (typeof state.analysisTimeoutMs === 'number') this.analyzer.setAnalysisTimeout(state.analysisTimeoutMs)
      if (typeof state.promptTrimMode === 'boolean') this.analyzer.setPromptTrimMode(state.promptTrimMode)
      if (typeof state.historyMaxEntries === 'number') this.analyzer.setHistoryMaxEntries(Math.max(state.historyMaxEntries, 3))
      const fps = state.recentAnalysisFingerprints ?? state.fingerprints
      if (Array.isArray(fps)) fps.forEach((fp: string) => this.analyzer.recordFingerprint(fp))
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
        analysisTimeoutMs: this.analyzer.getAnalysisTimeout(),
        promptTrimMode: this.analyzer.getPromptTrimMode(),
        historyMaxEntries: this.analyzer.getHistoryMaxEntries(),
        fingerprints: this.analyzer.getFingerprints(),
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
