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
import { evolutionPiperBridge } from './piper/EvolutionPiperBridge'
import { evolutionConsumerBridge } from './consumer'
import { EVOLUTION_SAFETY_MODE, WORKSPACE } from '../config'
import { asrEvolutionManager } from '../asr/AsrEvolutionManager'
import type { AgentService } from '../agent/AgentService'
import type { PlanManagerLike } from './types'
import type { ISubsystem, HealthCheckResult, SubsystemState } from '../core/lifecycle/types'
import type { PipelineOrchestrator, PipelineMetrics } from './automation'
import type { UserBehaviorLayer } from '../user-behavior/UserBehaviorLayer'
import type { PreProcessContext, PostProcessContext, PostProcessResult, DegradationSignal } from '../user-behavior/types'
import { createMessageId } from '../db/messages'
import { getMainWindow } from '../core/Lifecycle'
import { evolutionCheckpointManager } from './EvolutionCheckpointManager'
import type { MemoryEvolutionBridge, MemoryChangeEvent } from '../memory/MemoryEvolutionBridge'
import type { CicdOrchestrator } from './cicd/CicdOrchestrator'

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

  // ==================== 模块热力图相关 ====================
  /** 最近的模块热力图（由预处理钩子生成） */
  private lastHeatmap: any = null
  /** 连续冷循环计数（所有模块均为低频时的跳过次数） */
  private consecutiveColdCycles = 0
  /** 最大连续冷循环跳过数（超过此值仍会执行一次检查） */
  private static readonly MAX_COLD_CYCLES = 3

  // ==================== 最近管道指标缓存 ====================
  private lastPipelineMetrics: PipelineMetrics | null = null

  // ==================== UserBehavior 上层增强层 ====================
  private userBehaviorLayer: UserBehaviorLayer | null = null
  private lastBehaviorResult: PostProcessResult | null = null

  // ==================== Memory × Evolution 深度融合桥接器 ====================
  private memoryBridge: MemoryEvolutionBridge | null = null

  // ==================== CI/CD Orchestrator ====================
  private cicdOrchestrator: CicdOrchestrator | null = null

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
        this.syncStateToPiperBridge()
        // ★ 通知消费者桥接器：Evolution 状态已更新
        evolutionConsumerBridge.refresh()
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
    this.lastPipelineMetrics = pipeline.getMetrics() ?? null
    log('INFO', 'evolution_pipeline_attached')
  }

  /** 附加 UserBehavior 上层增强层 */
  setUserBehaviorLayer(layer: UserBehaviorLayer): void {
    this.userBehaviorLayer = layer
    log('INFO', 'evolution_user_behavior_attached', {
      features: layer.getActiveFeatures(),
    })
  }

  /** 注入 Memory × Evolution 桥接器 */
  setMemoryBridge(bridge: MemoryEvolutionBridge): void {
    this.memoryBridge = bridge
    log('INFO', 'evolution_memory_bridge_attached')

    // 订阅记忆变化事件 → 触发更及时的进化响应
    const unsubscribe = bridge.subscribeMemoryChanges((event: MemoryChangeEvent) => {
      this.onMemoryChangeEvent(event)
    })
    this.eventSubscriptions.push(unsubscribe)
  }

  /**
   * 处理记忆变化事件（v2 深度融合）。
   * 根据记忆变化类型决定是否触发即时进化分析：
   * - 重复纠正模式 → 高优先级触发进化分析
   * - 用户偏好变更 → 中等优先级（仅在 IDLE 状态触发）
   * - 新高置信度事实 → 低优先级（仅记录日志）
   * - 任务状态变更 → 仅记录
   */
  private onMemoryChangeEvent(event: MemoryChangeEvent): void {
    switch (event.type) {
      case 'repeated_correction_pattern':
        log('INFO', 'evolution_memory_event_correction', {
          topic: event.topic,
          count: event.count,
        })
        // 高频纠正信号 → 突破冷却直接触发进化分析
        if (event.count >= 3 && this.schedulerState === EvolutionSchedulerState.IDLE) {
          log('INFO', 'evolution_triggered_by_memory_correction', { topic: event.topic })
          // 防无限循环：自己触发的进化完成后会 emit cycle.completed，忽略该事件
          void this.runAnalysisCycle()
        }
        break

      case 'user_preference_changed':
        log('INFO', 'evolution_memory_event_preference', {
          key: event.key,
          value: event.value,
        })
        // 偏好变更 → 仅在 IDLE 且不在冷却时触发
        if (
          this.schedulerState === EvolutionSchedulerState.IDLE &&
          this.recoveryCooldownUntil === 0
        ) {
          log('INFO', 'evolution_triggered_by_memory_preference', { key: event.key })
          void this.runAnalysisCycle()
        }
        break

      case 'new_high_confidence_fact':
        log('INFO', 'evolution_memory_event_new_fact', {
          confidence: event.confidence,
          snippet: event.content.slice(0, 40),
        })
        // 新事实 → 仅记录，不触发进化（信息量不足以判断是否需要行动）
        break

      case 'task_state_changed':
        log('INFO', 'evolution_memory_event_task', {
          taskId: event.taskId,
          status: event.status,
        })
        // 任务变更 → 仅记录
        break
    }
  }

  /** 获取当前桥接器（供外部只读访问） */
  getMemoryBridge(): MemoryEvolutionBridge | null {
    return this.memoryBridge
  }

  /** 注入 CI/CD Orchestrator */
  setCicdOrchestrator(orchestrator: CicdOrchestrator | null): void {
    this.cicdOrchestrator = orchestrator
    if (orchestrator) {
      log('INFO', 'evolution_cicd_orchestrator_attached')
    }
  }

  /** 获取当前 CI/CD Orchestrator（供外部只读访问） */
  getCicdOrchestrator(): CicdOrchestrator | null {
    return this.cicdOrchestrator
  }

  /** 获取最近一次 UserBehavior 后处理结果 */
  getLastBehaviorResult(): PostProcessResult | null {
    return this.lastBehaviorResult
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

    // 初始同步 Evolution 状态到 PiperTTS 桥接器
    this.syncStateToPiperBridge()

    // ★ 初始化消费者桥接器（注册默认消费者契约）
    evolutionConsumerBridge.init()
    this.syncSchedulerStateToConsumerBridge()

    // ★ 检查点恢复：检测上次中断是否有未完成的检查点（后台执行，不阻塞启动）
    void this.recoverCheckpointsOnStartup()

    // 注册进程信号处理，确保任意中断都能保存检查点现场
    evolutionCheckpointManager.registerSignalHandlers()

    // 首次管道延迟 120 秒执行（等渲染进程 IPC 通道稳定，避免启动时冲垮）
    this._firstRunTimer = setTimeout(() => {
      if (this.pipeline) {
        this.pipeline.runOnce().catch(() => {})
      }
    }, 120_000)
  }

  private _firstRunTimer: ReturnType<typeof setTimeout> | null = null

  async stop(): Promise<void> {
    this.state = 'stopping'

    // ★ 标记当前检查点为 interrupted（配合信号处理确保任意中断都能保留现场）
    const currentId = evolutionCheckpointManager.getCurrentCheckpointId()
    if (currentId) {
      try {
        const { getRawDb } = await import('../db/connection')
        const db = getRawDb()
        if (db) {
          db.run('UPDATE evolution_checkpoints SET status = ?, completed_at = ? WHERE id = ?', [
            'interrupted',
            Date.now(),
            currentId,
          ])
          log('INFO', 'evolution_stop_marked_interrupted', { checkpointId: currentId })
        }
      } catch (err) {
        log('WARN', 'evolution_stop_mark_failed', { error: String(err) })
      }
    }

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
  getExecuteFailures(): number {
    return this.executeFailures
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

  /**
   * 将当前 Evolution 状态同步到 EvolutionPiperBridge，
   * 使 PiperTTS 能感知 Evolution 的调度/安全/冷却状态。
   */
  private syncStateToPiperBridge(): void {
    const cooldown = this.getRecoveryCooldown()
    evolutionPiperBridge.syncEvolutionState({
      schedulerState:
        this.schedulerState === EvolutionSchedulerState.ANALYZING
          ? 'analyzing'
          : this.schedulerState === EvolutionSchedulerState.COOLDOWN
            ? 'cooldown'
            : 'idle',
      safetyMode: this.safetyMode === 'review' ? 'review' : 'auto',
      executeFailures: this.tryRunFailures + this.executeFailures,
      inCooldown: cooldown.active,
      cooldownRemainingMs: cooldown.remainingMs,
      userActive: this.mioActive,
      lastRunAt: this.lastRun,
      pipelineQueueSize: this.lastPipelineMetrics?.queueSize ?? 0,
      timestamp: Date.now(),
    })
  }

  setSafetyMode(mode: SafetyMode): void {
    this.safetyMode = mode
    this.syncStateToPiperBridge()
    log('INFO', 'evolution_safety_mode', { mode })
  }

  // ==================== 检查点恢复 ====================

  /**
   * 在服务启动时检测并处理上次中断留下的未完成检查点。
   * 结果会以 Evolution 消息的形式写入 UI。
   */
  private async recoverCheckpointsOnStartup(): Promise<void> {
    try {
      const summary = await evolutionCheckpointManager.recoverOnStartup()
      if (!summary) {
        log('INFO', 'evolution_no_unfinished_checkpoints')
        return
      }

      log('INFO', 'evolution_checkpoint_recovery', { summary: summary.slice(0, 200) })

      // 将恢复摘要写入 UI 消息（不写入 messages 表）
      try {
        const msg = {
          id: createMessageId(),
          source: 'electron' as const,
          role: 'assistant' as const,
          content: summary,
          category: 'evolution' as const,
          sessionId: SelfEvolutionService.EVOLUTION_SESSION_ID,
          createdAt: Date.now(),
        }
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('message:new', msg)
        }
      } catch {
        // 窗口可能尚未创建
      }
    } catch (err: any) {
      log('ERROR', 'evolution_checkpoint_recovery_error', { error: String(err) })
    }
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

    // ★ 冷模块降频：如果最近一次热力图显示没有高频模块，跳过本次周期间隔检查
    if (this.lastHeatmap && this.lastHeatmap.hasSufficientData) {
      const hasHotModules = this.lastHeatmap.hotModules?.length > 0
      if (!hasHotModules) {
        this.consecutiveColdCycles++
        if (this.consecutiveColdCycles < SelfEvolutionService.MAX_COLD_CYCLES) {
          log('INFO', 'scheduler_tick_cold_module_skip', {
            coldCycles: this.consecutiveColdCycles,
            maxColdCycles: SelfEvolutionService.MAX_COLD_CYCLES,
          })
          return // 跳过本次周期：无高频模块需要优化
        }
      } else {
        this.consecutiveColdCycles = 0 // 有热模块，重置冷计数
      }
    }

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

      // ★ UserBehavior 预处理：在管道执行前注入行为上下文
      let preProcessData: Record<string, unknown> | undefined
      let heatmapChecked = false
      if (this.userBehaviorLayer) {
        const preCtx: PreProcessContext = {
          timestamp: startedAt,
          hoursSinceLastRun: this.lastRun > 0 ? (startedAt - this.lastRun) / (1000 * 60 * 60) : Infinity,
          consecutiveFailures: this.tryRunFailures,
          safetyMode: this.safetyMode,
          userActive: this.mioActive,
        }
        const enhanced = await this.userBehaviorLayer.preProcess(preCtx)
        // 提取扩展属性供后处理消费
        const enhancedAny = enhanced as any
        if (enhancedAny.behaviorFeatures) {
          preProcessData = { userBehaviorFeatures: enhancedAny.behaviorFeatures }
        }
        // ★ 提取模块热力图数据
        if (enhancedAny.heatmap) {
          const heatmap = enhancedAny.heatmap
          preProcessData = {
            ...preProcessData,
            heatmap,
            heatmapSummary: enhancedAny.heatmapSummary || '',
          }
          heatmapChecked = true
          log('INFO', 'evolution_heatmap_loaded', {
            hotModules: heatmap.hotModules?.length ?? 0,
            errorModules: heatmap.errorModules?.length ?? 0,
            coldModules: heatmap.coldModules?.length ?? 0,
          })
        }
        // ★ 冷模块降频标记（供管道 Collector 跳过冷模块分析）
        if (enhancedAny.shouldDampenColdModules && enhancedAny.coldModules?.length > 0) {
          preProcessData = {
            ...preProcessData,
            coldModules: enhancedAny.coldModules,
            shouldDampenColdModules: true,
          }
          log('INFO', 'evolution_cold_module_dampening', {
            coldModules: enhancedAny.coldModules,
          })
        }
      }

      // 缓存热力图供下次 scheduler tick 判断冷模块降频
      if (heatmapChecked && (preProcessData as any)?.heatmap) {
        this.lastHeatmap = (preProcessData as any).heatmap
      }

      // ★ Memory × Evolution 深度融合：在管道执行前注入长时记忆上下文
      if (this.memoryBridge && this.memoryBridge.isReady()) {
        const enhancedCtx = this.memoryBridge.getEnhancedAnalysisContext()
        if (enhancedCtx) {
          preProcessData = {
            ...preProcessData,
            memoryContext: enhancedCtx,
          }
          log('INFO', 'evolution_memory_context_injected', {
            ctxLength: enhancedCtx.length,
          })
        }

        // ★ 记忆驱动的进化优先级（v2 深度融合）：从记忆系统分析当前进化目标
        const priorities = this.memoryBridge.getTargetedEvolutionPriorities(3)
        if (priorities.length > 0) {
          preProcessData = {
            ...preProcessData,
            evolutionPriorities: priorities.map((p) => ({
              topic: p.topic,
              score: p.score,
              reason: p.reason,
              suggestedCollector: p.suggestedCollector,
            })),
          }
          log('INFO', 'evolution_priorities_injected', {
            topPriority: priorities[0].topic,
            topScore: priorities[0].score.toFixed(2),
            count: priorities.length,
          })
        }
      }

      // ★ 质量指标追踪：在每个周期开始前读取降级信号
      //   captureQualityMetrics() 会记录新的快照，供此周期消费
      let qualityDegradationSignals: DegradationSignal[] = []
      let qualityHealthScore: number | null = null
      let qualityHealthDelta: number | null = null
      if (this.userBehaviorLayer) {
        try {
          const qmResult = this.userBehaviorLayer.captureQualityMetrics()
          if (qmResult) {
            qualityDegradationSignals = qmResult.signals
            qualityHealthScore = qmResult.snapshot?.healthScore ?? null
            qualityHealthDelta = qmResult.snapshot?.healthScoreDelta ?? null
            if (preProcessData) {
              preProcessData = {
                ...preProcessData,
                qualityMetrics: {
                  healthScore: qualityHealthScore,
                  healthScoreDelta: qualityHealthDelta,
                  degradationSignals: qualityDegradationSignals.map((s) => ({
                    metric: s.metricName,
                    severity: s.severity,
                    description: s.description,
                    target: s.recommendedTarget,
                  })),
                  isDegraded: qualityDegradationSignals.length > 0,
                },
              }
            }
            if (qualityDegradationSignals.length > 0) {
              log('INFO', 'evolution_quality_degradation_detected', {
                signals: qualityDegradationSignals.length,
                healthScore: qualityHealthScore,
                delta: qualityHealthDelta,
                topSignal: qualityDegradationSignals[0]?.description?.slice(0, 80),
              })
            }
          }
        } catch (err: any) {
          log('WARN', 'evolution_quality_metrics_error', { error: err.message })
        }
      }

      try {
        // ★ 检查点体系：在每个关键阶段创建 git 快照 + 数据库记录，
        //   确保进程中断后能恢复现场或回滚。
        const cycleId = `cycle_${startedAt}`

        // pre_cycle：整个周期开始前的完整快照
        const preCycleCkpt = await evolutionCheckpointManager.beginCheckpoint(cycleId, 'pre_cycle')

        // 步骤 1：触发自动化管道（如果已注入）
        if (this.pipeline) {
          log('INFO', 'evolution_trigger_pipeline')

          // pre_pipeline：管道执行前的快照（含当前工作区所有变更）
          const prePipelineCkpt = await evolutionCheckpointManager.beginCheckpoint(cycleId, 'pre_pipeline')

          const metrics = await this.pipeline.runOnce()
          this.lastPipelineMetrics = metrics
          // ★ 同步管道指标到消费者桥接器
          evolutionConsumerBridge.updatePipelineMetrics(metrics)
          this.tryRunFailures = 0
          this.lastSuccessTime = Date.now()
          this.recoveryCooldownUntil = 0

          // pre_pipeline 完成
          if (prePipelineCkpt) evolutionCheckpointManager.completeCheckpoint(prePipelineCkpt)

          // post_execute：管道执行完成后的确认快照
          const postExecCkpt = await evolutionCheckpointManager.beginCheckpoint(cycleId, 'post_execute')

          summary = this.buildPipelineSummary(metrics)
          success = true

          // ★ CI/CD 质量门禁：在每次进化周期中运行综合质量检查
          if (this.cicdOrchestrator && this.cicdOrchestrator.isReady()) {
            log('INFO', 'evolution_cicd_quality_gate_start')
            try {
              const gateResult = await this.cicdOrchestrator.executeStep('[quality_gate] 进化周期质量门禁')
              if (gateResult.passed) {
                summary += `\n\n【CI/CD 质量门禁】✅ 通过（${gateResult.durationMs}ms）`
                log('INFO', 'evolution_cicd_gate_passed', { durationMs: gateResult.durationMs })
              } else {
                summary += `\n\n【CI/CD 质量门禁】⚠️ ${gateResult.summary}（${gateResult.durationMs}ms）`
                log('WARN', 'evolution_cicd_gate_failed', { summary: gateResult.summary.slice(0, 100) })
              }
            } catch (err: any) {
              log('WARN', 'evolution_cicd_gate_error', { error: err.message })
              summary += `\n\n【CI/CD 质量门禁】❌ 执行异常: ${err.message}`
            }
          }

          // 附加质量指标降级信息
          if (qualityDegradationSignals.length > 0) {
            const degradationLines = qualityDegradationSignals
              .slice(0, 3)
              .map((s, i) => `  ${i + 1}. ${s.description}（严重度: ${Math.round(s.severity * 100)}%）`)
              .join('\n')
            summary +=
              `\n\n【质量指标降级信号】检测到 ${qualityDegradationSignals.length} 个指标劣化：\n${degradationLines}` +
              (qualityHealthScore !== null ? `\n当前健康评分: ${qualityHealthScore.toFixed(0)}/100（${qualityHealthDelta !== null && qualityHealthDelta < 0 ? '↓' : '↑'}${qualityHealthDelta !== null ? Math.abs(qualityHealthDelta).toFixed(1) : ''}）` : '')
          }

          log('INFO', 'evolution_pipeline_report', {
            collected: metrics.totalCollected,
            fixed: metrics.totalFixed,
            queueSize: metrics.queueSize,
          })

          // post_execute 完成
          if (postExecCkpt) evolutionCheckpointManager.completeCheckpoint(postExecCkpt)
        } else {
          // 无管道：空 run（仅做健康检查）
          summary = '自动化管道未配置，本次跳跃'
          success = true
        }

        // pre_cycle 完成（至此全链路检查点均成功标记）
        if (preCycleCkpt) evolutionCheckpointManager.completeCheckpoint(preCycleCkpt)

        // 周期成功 → 重置失败计数
        if (success && this.recoveryCooldownUntil > 0) {
          this.recoveryCooldownUntil = 0
        }

        // ASR 自进化评估：对比上一轮变更的纠错率变化
        if (success) {
          try {
            const evalResult = asrEvolutionManager.evaluateAndDecide()
            if (evalResult.verdict !== 'not_found') {
              const actionLabel = evalResult.action === 'keep' ? '✅ 保留' : evalResult.action === 'rollback' ? '⚠️ 回滚' : '➡️ 无操作'
              log('INFO', 'asr_evolution_cycle_eval', {
                verdict: evalResult.verdict,
                action: evalResult.action,
              })
              summary += `\n\n【ASR 自进化】${actionLabel}（${evalResult.verdict === 'improved' ? '纠错率下降' : evalResult.verdict === 'worsened' ? '纠错率上升' : '基本不变'}）`
            }
          } catch (evalErr) {
            log('WARN', 'asr_evolution_eval_error', { error: String(evalErr) })
          }
        }

        // ★ UserBehavior 后处理：在完整 summary 上附加行为增强
        if (this.userBehaviorLayer && success) {
          const postCtx: PostProcessContext = {
            rawMetrics: this.lastPipelineMetrics,
            success,
            rawSummary: summary,
            durationMs: Date.now() - startedAt,
            preProcessData,
          }
          const postResult = await this.userBehaviorLayer.postProcess(postCtx)
          this.lastBehaviorResult = postResult
          if (postResult.enhancedSummary) {
            summary = postResult.enhancedSummary
          }
        }

        // ★ Memory × Evolution 深度融合：将进化周期结果持久化到记忆系统
        if (this.memoryBridge && this.memoryBridge.isReady()) {
          // 从 summary 中提取 [xxx] 标题作为洞察片段
          const insightMatches = summary.match(/【[^】]+】/g)
          const insights = insightMatches
            ? [...new Set(insightMatches)].map((m) => m.replace(/[【】]/g, '').trim()).slice(0, 3)
            : summary.length > 50
              ? [summary.slice(0, 100)]
              : undefined
          this.memoryBridge.storeEvolutionResult({
            summary,
            metrics: this.lastPipelineMetrics,
            success,
            insights,
          })
        }

        this.eventBus.emit('evolution.cycle.completed' as any, {
          success,
          summary,
          timestamp: Date.now(),
          durationMs: Date.now() - startedAt,
          mode: 'auto',
          safetyMode: this.safetyMode,
          failures: this.tryRunFailures,
          // 附加 UserBehavior 增强数据（由 feature flag 控制）
          ...(this.lastBehaviorResult?.extraData ? { userBehavior: this.lastBehaviorResult.extraData } : {}),
          ...(this.lastBehaviorResult?.messages?.length ? { behaviorMessages: this.lastBehaviorResult.messages } : {}),
        })
      } catch (err: any) {
        this.tryRunFailures++
        if (this.tryRunFailures >= this.maxFailures && this.recoveryCooldownUntil === 0) {
          this.recoveryCooldownUntil = Date.now() + Math.min(this.intervalMs, 30 * 60 * 1000)
          this.syncStateToPiperBridge()
        }

        log('ERROR', 'evolution_cycle_error', { error: String(err), failures: this.tryRunFailures })

        // ★ 检查点失败：标记当前未完成的检查点
        const currentId = evolutionCheckpointManager.getCurrentCheckpointId()
        if (currentId) {
          evolutionCheckpointManager.failCheckpoint(currentId, String(err))
        }

        // ★ 即使失败，也将结果写入记忆系统（便于后续分析失败模式）
        if (this.memoryBridge && this.memoryBridge.isReady()) {
          this.memoryBridge.storeEvolutionResult({
            summary: `Error: ${(err as Error).message}`,
            metrics: this.lastPipelineMetrics,
            success: false,
          })
        }

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
    this.syncStateToPiperBridge()
    // ★ 同步调度器状态到消费者桥接器
    this.syncSchedulerStateToConsumerBridge()
    log('INFO', 'scheduler_state_transition', { from: oldState, to: newState, reason })
    this.eventBus.emit('evolution.scheduler.state' as any, { from: oldState, to: newState, reason, timestamp: Date.now() })
  }

  /**
   * 将当前调度器状态同步到 EvolutionConsumerBridge。
   * 使 Plan/ReasoningChain 消费者能感知 Evolution 的运行状态。
   */
  private syncSchedulerStateToConsumerBridge(): void {
    evolutionConsumerBridge.updateSchedulerState({
      state:
        this.schedulerState === EvolutionSchedulerState.ANALYZING
          ? 'analyzing'
          : this.schedulerState === EvolutionSchedulerState.COOLDOWN
            ? 'cooling_down'
            : 'idle',
      lastRun: this.lastRun > 0 ? this.lastRun : null,
      consecutiveFailures: this.tryRunFailures,
      isHealthy: this.tryRunFailures < 3,
    })
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
      // 只发 IPC 展示，不写 messages 表
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
