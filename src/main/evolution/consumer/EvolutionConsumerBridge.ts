/**
 * EvolutionConsumerBridge — Evolution → Consumer 桥接器
 *
 * 将 Evolution 内部状态转换为消费者可消费的格式。
 * 消费方不需要了解 Evolution 内部实现，只需通过此桥接器获取
 * EvolutionConsumerContext。
 *
 * ── 设计模式 ──
 * 1. 消费者注册制：每个消费者类型在启动时注册自己的需求契约
 * 2. 按需裁剪：getContext() 只返回消费者 requiredFields 中的字段
 * 3. 新鲜度检查：过期上下文自动降级
 * 4. 降级回退：不可用时返回空上下文，不阻塞消费者
 *
 * ── 与 SelfEvolutionService 的关系 ──
 * SelfEvolutionService 持有此桥接器的引用，在管道完成时
 * 调用 refresh() 更新内部缓存。消费者仅通过 getContext() 读取。
 *
 * ── 与 PipelineOrchestrator 的关系 ──
 * PipelineOrchestrator 的指标通过 SelfEvolutionService 间接
 * 传入桥接器，桥接器不直接访问 PipelineOrchestrator。
 */

import { log } from '../../logger/Logger'
import { DEFAULT_PLAN_CONSUMERS } from './PlanConsumerContract'
import type {
  EvolutionConsumerContext,
  ConsumerId,
  ConsumerRegistration,
  ConsumerRequirements,
  IEvolutionConsumerBridge,
  KnownIssue,
  PipelineSummary,
  SchedulerStatus,
} from './types'
import type { PipelineMetrics } from '../automation/PipelineOrchestrator'
import type { ProblemSource } from '../automation/types'

// =============================================================================
// 默认空上下文（降级用）
// =============================================================================

const EMPTY_CONTEXT: EvolutionConsumerContext = {
  pipeline: null,
  knownIssues: [],
  scheduler: {
    state: 'idle',
    lastRun: null,
    consecutiveFailures: 0,
    isHealthy: true,
  },
  timestamp: 0,
}

// =============================================================================
// EvolutionConsumerBridge
// =============================================================================

export class EvolutionConsumerBridge implements IEvolutionConsumerBridge {
  /** 已注册的消费者及其契约 */
  private registrations = new Map<ConsumerId, ConsumerRegistration>()

  /** 最近一次从 Evolution 获取的原始指标快照 */
  private lastPipelineMetrics: PipelineMetrics | null = null

  /** 调度器状态快照（由 SelfEvolutionService 更新） */
  private schedulerState: {
    state: 'idle' | 'analyzing' | 'cooling_down'
    lastRun: number | null
    consecutiveFailures: number
  } = {
    state: 'idle',
    lastRun: null,
    consecutiveFailures: 0,
  }

  /** 生命周期状态 */
  private initialized = false

  // ===========================================================================
  // 初始化
  // ===========================================================================

  /**
   * 初始化桥接器，注册默认消费者契约。
   */
  init(): void {
    if (this.initialized) return

    // 注册默认 Plan 消费者
    for (const req of DEFAULT_PLAN_CONSUMERS) {
      this.registerConsumer(req)
    }

    this.initialized = true
    log('INFO', 'evolution_consumer_bridge_initialized', {
      consumers: this.registrations.size,
    })
  }

  // ===========================================================================
  // IEvolutionConsumerBridge 接口实现
  // ===========================================================================

  /**
   * 为指定消费者获取 Evolution 上下文。
   *
   * 1. 按消费者契约裁剪输出字段
   * 2. 检查新鲜度，过期则返回空上下文
   * 3. 不可用时按契约的 fallbackStrategy 降级
   */
  getContext(consumerId: ConsumerId): EvolutionConsumerContext | null {
    const reg = this.registrations.get(consumerId)
    if (!reg) {
      log('WARN', 'evolution_consumer_not_registered', { consumerId })
      return null
    }

    const { requirements } = reg

    // 检查新鲜度
    if (reg.lastKnownContext && !this.isFresh(consumerId)) {
      log('INFO', 'evolution_consumer_context_stale', {
        consumerId,
        maxStalenessMs: requirements.faultTolerance.maxStalenessMs,
        fallback: requirements.faultTolerance.fallbackStrategy,
      })

      // 按降级策略处理
      switch (requirements.faultTolerance.fallbackStrategy) {
        case 'use_last_known':
          // 返回上次已知上下文（即使过期）
          return reg.lastKnownContext
        case 'return_default':
          return EMPTY_CONTEXT
        case 'return_empty':
          return null
      }
    }

    // 如果从未有过上下文，返回降级值
    if (!reg.lastKnownContext) {
      return null
    }

    return reg.lastKnownContext
  }

  /**
   * 获取消费者注册信息。
   */
  getRegistration(consumerId: ConsumerId): ConsumerRegistration | null {
    return this.registrations.get(consumerId) ?? null
  }

  /**
   * 获取消费者的需求规格。
   */
  getRequirements(consumerId: ConsumerId): ConsumerRequirements | null {
    return this.registrations.get(consumerId)?.requirements ?? null
  }

  /**
   * 检查指定消费者的上下文是否新鲜。
   * 在 maxStalenessMs 内视为新鲜。
   */
  isFresh(consumerId: ConsumerId): boolean {
    const reg = this.registrations.get(consumerId)
    if (!reg || !reg.lastKnownContext) return false

    const age = Date.now() - reg.lastKnownContext.timestamp
    return age <= reg.requirements.faultTolerance.maxStalenessMs
  }

  /**
   * 手动刷新上下文（由 Evolution 周期完成时调用）。
   * 用最新的 Evolution 状态更新所有已注册消费者的上下文。
   */
  refresh(): void {
    if (!this.initialized) {
      log('WARN', 'evolution_consumer_bridge_not_initialized')
      return
    }

    // 从当前快照构建完整上下文
    const fullContext = this.buildFullContext()

    // 为每个消费者按契约裁剪
    for (const [consumerId, reg] of this.registrations) {
      const trimmed = this.trimToRequirements(fullContext, reg.requirements)
      reg.lastKnownContext = trimmed
      reg.lastUpdatedAt = Date.now()
    }

    log('INFO', 'evolution_consumer_bridge_refreshed', {
      consumers: this.registrations.size,
      pipeline: fullContext.pipeline
        ? `collected=${fullContext.pipeline.totalCollected} fixed=${fullContext.pipeline.totalFixed}`
        : 'none',
      issues: fullContext.knownIssues.length,
    })
  }

  /**
   * 注册新消费者。
   */
  registerConsumer(requirements: ConsumerRequirements): void {
    if (this.registrations.has(requirements.consumerId)) {
      log('WARN', 'evolution_consumer_already_registered', {
        consumerId: requirements.consumerId,
      })
      return
    }

    this.registrations.set(requirements.consumerId, {
      requirements,
      lastKnownContext: null,
      lastUpdatedAt: 0,
    })

    log('INFO', 'evolution_consumer_registered', {
      consumerId: requirements.consumerId,
      requiredFields: requirements.outputFormat.requiredFields.length,
      slaMs: requirements.responseTimeSlaMs,
    })
  }

  // ===========================================================================
  // 状态注入（由 SelfEvolutionService 调用）
  // ===========================================================================

  /**
   * 从 SelfEvolutionService 注入调度器状态。
   * SelfEvolutionService 在每次状态变化时调用此方法。
   */
  updateSchedulerState(state: SchedulerStatus): void {
    this.schedulerState = state
  }

  /**
   * 从 SelfEvolutionService 注入管道指标。
   * SelfEvolutionService 在 pipeline.completed 事件中调用此方法。
   */
  updatePipelineMetrics(metrics: PipelineMetrics | null): void {
    this.lastPipelineMetrics = metrics
  }

  // ===========================================================================
  // 内部方法
  // ===========================================================================

  /**
   * 构建完整的 Evolution 上下文（包含所有可用字段）。
   */
  private buildFullContext(): EvolutionConsumerContext {
    const timestamp = Date.now()

    const pipeline = this.lastPipelineMetrics
      ? this.buildPipelineSummary(this.lastPipelineMetrics)
      : null

    const knownIssues = this.buildKnownIssues()

    const scheduler: SchedulerStatus = {
      ...this.schedulerState,
      isHealthy: this.schedulerState.consecutiveFailures < 3,
    }

    return {
      pipeline,
      knownIssues,
      scheduler,
      timestamp,
    }
  }

  /**
   * 从 PipelineMetrics 构建 PipelineSummary。
   */
  private buildPipelineSummary(metrics: PipelineMetrics): PipelineSummary {
    const healthStatus: PipelineSummary['healthStatus'] =
      metrics.totalFailed > metrics.totalFixed
        ? 'degraded'
        : metrics.totalCollected - metrics.totalFixed > 100
          ? 'stalled'
          : 'good'

    return {
      totalCollected: metrics.totalCollected,
      totalFixed: metrics.totalFixed,
      totalFailed: metrics.totalFailed,
      queueSize: metrics.queueSize,
      healthStatus,
    }
  }

  /**
   * 构建已知问题列表。
   * TODO: 当前使用 PipelineMetrics 的简化指标。
   * 未来可以从 ProblemQueue 获取更详细的问题列表。
   */
  private buildKnownIssues(): KnownIssue[] {
    if (!this.lastPipelineMetrics) return []

    const issues: KnownIssue[] = []

    // 从 PipelineMetrics 的总量推断系统级别问题
    if (this.lastPipelineMetrics.totalFailed > 0) {
      issues.push({
        source: 'tsc' as ProblemSource,
        severity: 'error',
        title: `${this.lastPipelineMetrics.totalFailed} 个问题修复失败，需要人工干预`,
        occurrenceCount: this.lastPipelineMetrics.totalFailed,
        lastSeen: this.lastPipelineMetrics.lastRunAt,
      })
    }

    if (this.lastPipelineMetrics.queueSize > 10) {
      issues.push({
        source: 'runtime' as ProblemSource,
        severity: 'warning',
        title: `问题队列积压 ${this.lastPipelineMetrics.queueSize} 个待处理`,
        occurrenceCount: this.lastPipelineMetrics.queueSize,
        lastSeen: this.lastPipelineMetrics.lastRunAt,
      })
    }

    // 按严重度排序：error → warning → info
    issues.sort((a, b) => {
      const order = { error: 0 as const, warning: 1 as const, info: 2 as const }
      return order[a.severity] - order[b.severity]
    })

    return issues
  }

  /**
   * 按消费者契约裁剪上下文。
   * 只保留 requiredFields 和 optionalFields 中定义的字段。
   */
  private trimToRequirements(
    context: EvolutionConsumerContext,
    requirements: ConsumerRequirements,
  ): EvolutionConsumerContext {
    const { requiredFields, optionalFields, maxLength } = requirements.outputFormat
    const allowedFields = new Set([...requiredFields, ...(optionalFields ?? [])])

    // 判断是否需要 pipeline 字段
    const needsPipeline = allowedFields.has('pipeline.healthStatus') ||
      allowedFields.has('pipeline.totalCollected') ||
      allowedFields.has('pipeline.totalFixed')

    // 构建裁剪后的上下文
    const trimmed: EvolutionConsumerContext = {
      pipeline: needsPipeline ? context.pipeline : null,
      knownIssues: allowedFields.has('knownIssues') ||
                   allowedFields.has('knownIssues[].severity') ||
                   allowedFields.has('knownIssues[].source')
        ? context.knownIssues
        : [],
      scheduler: allowedFields.has('scheduler.state')
        ? context.scheduler
        : EMPTY_CONTEXT.scheduler,
      timestamp: context.timestamp,
    }

    // 如果要求最大长度，序列化后裁剪
    if (maxLength && maxLength > 0) {
      const serialized = JSON.stringify(trimmed)
      if (serialized.length > maxLength) {
        // 裁剪 knownIssues（最长的列表）
        if (trimmed.knownIssues.length > 0) {
          const maxIssues = Math.max(1, Math.floor(trimmed.knownIssues.length / 2))
          trimmed.knownIssues = trimmed.knownIssues.slice(0, maxIssues)
        }
      }
    }

    return trimmed
  }
}

/**
 * 全局桥接器单例。
 * SelfEvolutionService 在初始化时注入此桥接器。
 */
export const evolutionConsumerBridge = new EvolutionConsumerBridge()
