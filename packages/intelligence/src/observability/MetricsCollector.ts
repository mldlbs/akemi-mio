/**
 * MetricsCollector — 运行时指标收集器
 *
 * 监听 EventBus 事件，自动记录关键运行时指标。
 * 集成到 health:check 端点暴露。
 *
 * 收集的指标：
 * - 进化循环：总执行次数、成功/失败、平均耗时
 * - 计划管理：创建数、完成数、放弃数、完成率
 * - API 调用：总次数、成功/失败、平均耗时
 * - 工具调用：按工具名统计
 */

import { EventBus } from '@akemi-mio/core/core/EventBus'
import { eventBus as defaultEventBus } from '@akemi-mio/core/core/EventBus'
import { log } from '@akemi-mio/core/logger/Logger'

// =============================================================================
// 类型定义
// =============================================================================

export interface EvolutionMetrics {
  totalCycles: number
  successCount: number
  failureCount: number
  timeoutCount: number
  avgDurationMs: number
  lastCycleTimestamp: number | null
  cycleDurations: number[] // 最近 20 次循环耗时
}

export interface PlanMetrics {
  totalCreated: number
  totalCompleted: number
  totalAbandoned: number
  completionRate: number // 0-1
  activeCount: number
}

export interface ToolMetrics {
  totalCalls: number
  successCount: number
  failureCount: number
  byTool: Record<string, { calls: number; errors: number }>
}

export interface TaskMetrics {
  totalRegistered: number
  activeInstances: number
  completedCount: number
  failedCount: number
  avgScore: number
  graphSize: number
  cyclesDetected: number
}

export interface ResourceMetrics {
  computeUtilization: number
  memoryUtilization: number
  llmUtilization: number
  taskSlotUtilization: number
  evolutionRiskLevel: number
}

export interface StabilityMetrics {
  healthScore: number
  taskFlowEfficiency: number
  schedulerBalance: number
  evolutionRiskControl: number
  errorRateInverse: number
}

export interface ExecutionGoalMetrics {
  created: number
  completed: number
  blocked: number
  abandoned: number
}

export interface RuntimeMetrics {
  evolution: EvolutionMetrics
  plans: PlanMetrics
  tools: ToolMetrics
  tasks: TaskMetrics
  resources: ResourceMetrics
  stability: StabilityMetrics
  guardrail: {
    totalRejections: number
    hardBlocks: number
    goalDrifts: number
    trippedCount: number
  }
  executionGoals: ExecutionGoalMetrics
  apiCalls: {
    total: number
    successCount: number
    failureCount: number
  }
  memory: {
    heapUsedMB: number
    heapTotalMB: number
    rssMB: number
  }
  uptime: number
  eventLoopLagMs: number
  timestamp: number
}

// =============================================================================
// MetricsCollector
// =============================================================================

export class MetricsCollector {
  // Evolution
  private evolutionData = {
    totalCycles: 0,
    successCount: 0,
    failureCount: 0,
    timeoutCount: 0,
    cycleDurations: [] as number[],
    lastCycleTimestamp: null as number | null,
  }

  // Guardrail
  private guardrailData = {
    totalRejections: 0,
    hardBlocks: 0,
    goalDrifts: 0,
    trippedCount: 0,
  }

  // Execution goals
  private executionGoalData = {
    created: 0,
    completed: 0,
    blocked: 0,
    abandoned: 0,
  }

  // Plans
  private planData = {
    totalCreated: 0,
    totalCompleted: 0,
    totalAbandoned: 0,
    activeCount: 0,
  }

  // Tools
  private toolData: Record<string, { calls: number; errors: number }> = {}
  private toolTotalCalls = 0
  private toolSuccessCount = 0
  private toolFailureCount = 0

  // API calls (from tool execution timing)
  private apiCallTotal = 0
  private apiCallSuccess = 0
  private apiCallFailure = 0

  // Task tracking
  private taskCompletedCount = 0
  private taskFailedCount = 0
  private taskScoreSum = 0
  private taskScoreCount = 0

  private eventBus: EventBus
  private unsubscribers: Array<() => void> = []

  constructor(eventBus?: EventBus) {
    this.eventBus = eventBus || defaultEventBus
    this.subscribe()
  }

  // ===== 订阅事件 =====

  private subscribe(): void {
    // 进化循环完成
    const unsubCycle = this.eventBus.on('evolution.cycle.completed', (data: { success: boolean; summary?: string; timestamp: number }) => {
      this.evolutionData.totalCycles++
      this.evolutionData.lastCycleTimestamp = data.timestamp

      if (data.success) {
        this.evolutionData.successCount++
      } else {
        this.evolutionData.failureCount++
        // 检测超时
        if (data.summary?.includes('timeout') || data.summary?.includes('超时')) {
          this.evolutionData.timeoutCount++
        }
      }

      // 仅保留最近 20 条
      if (this.evolutionData.cycleDurations.length > 20) {
        this.evolutionData.cycleDurations = this.evolutionData.cycleDurations.slice(-20)
      }

      log('PERF', 'metrics_evolution_cycle', {
        total: this.evolutionData.totalCycles,
        success_rate: this.getSuccessRate().toFixed(2),
      })
    })
    this.unsubscribers.push(unsubCycle)

    // 计划创建
    const unsubPlanCreate = this.eventBus.on('agent.plan.created', (_data: { planId: string; title: string }) => {
      this.planData.totalCreated++
      this.planData.activeCount++
    })
    this.unsubscribers.push(unsubPlanCreate)

    // 计划完成
    const unsubPlanComplete = this.eventBus.on('agent.plan.completed', (_data: { planId: string }) => {
      this.planData.totalCompleted++
      this.planData.activeCount = Math.max(0, this.planData.activeCount - 1)
    })
    this.unsubscribers.push(unsubPlanComplete)

    // 工具调用
    const unsubToolInvoke = this.eventBus.on('agent.tool.invoked', (data: { tool: string; args?: Record<string, any> }) => {
      this.toolTotalCalls++
      this.apiCallTotal++
      if (!this.toolData[data.tool]) {
        this.toolData[data.tool] = { calls: 0, errors: 0 }
      }
      this.toolData[data.tool].calls++
    })
    this.unsubscribers.push(unsubToolInvoke)

    // 工具完成
    const unsubToolComplete = this.eventBus.on('agent.tool.completed', (_data: { tool: string; result?: string }) => {
      this.toolSuccessCount++
      this.apiCallSuccess++
    })
    this.unsubscribers.push(unsubToolComplete)

    // 工具失败
    const unsubToolFailed = this.eventBus.on('agent.tool.failed', (data: { tool: string; error?: string }) => {
      this.toolFailureCount++
      this.apiCallFailure++
      if (this.toolData[data.tool]) {
        this.toolData[data.tool].errors++
      }
    })
    this.unsubscribers.push(unsubToolFailed)

    // 任务生命周期
    const unsubTaskLifecycle = this.eventBus.on('task.lifecycle', (data: { status: string; durationMs?: number }) => {
      if (data.status === 'completed') this.taskCompletedCount++
      else if (data.status === 'failed') this.taskFailedCount++
      if (data.durationMs) {
        this.taskScoreSum += Math.max(0, 1000 - data.durationMs) / 1000
        this.taskScoreCount++
      }
    })
    this.unsubscribers.push(unsubTaskLifecycle)

    // Guardrail 拒绝
    const unsubRejection = this.eventBus.on('goal.guardrail.rejection', (data: { reason: string }) => {
      this.guardrailData.totalRejections++
      if (data.reason === 'HARD_BLOCK') this.guardrailData.hardBlocks++
      else if (data.reason === 'GOAL_DRIFT') this.guardrailData.goalDrifts++
    })
    this.unsubscribers.push(unsubRejection)

    // Guardrail 熔断
    const unsubTripped = this.eventBus.on('goal.guardrail.tripped', () => {
      this.guardrailData.trippedCount++
    })
    this.unsubscribers.push(unsubTripped)

    // Execution goal lifecycle
    const unsubGoalCreated = this.eventBus.on('execution_goal.created', () => {
      this.executionGoalData.created++
    })
    this.unsubscribers.push(unsubGoalCreated)

    const unsubGoalCompleted = this.eventBus.on('execution_goal.completed', () => {
      this.executionGoalData.completed++
    })
    this.unsubscribers.push(unsubGoalCompleted)

    const unsubGoalBlocked = this.eventBus.on('execution_goal.blocked', () => {
      this.executionGoalData.blocked++
    })
    this.unsubscribers.push(unsubGoalBlocked)

    const unsubGoalAbandoned = this.eventBus.on('execution_goal.abandoned', () => {
      this.executionGoalData.abandoned++
    })
    this.unsubscribers.push(unsubGoalAbandoned)
  }

  // ===== 查询 =====

  /** 获取当前所有指标的快照 */
  getSnapshot(): RuntimeMetrics {
    const mem = process.memoryUsage()

    return {
      evolution: {
        totalCycles: this.evolutionData.totalCycles,
        successCount: this.evolutionData.successCount,
        failureCount: this.evolutionData.failureCount,
        timeoutCount: this.evolutionData.timeoutCount,
        avgDurationMs: this.getAvgCycleDuration(),
        lastCycleTimestamp: this.evolutionData.lastCycleTimestamp,
        cycleDurations: [...this.evolutionData.cycleDurations],
      },
      plans: {
        totalCreated: this.planData.totalCreated,
        totalCompleted: this.planData.totalCompleted,
        totalAbandoned: Math.max(0, this.planData.totalCreated - this.planData.totalCompleted - this.planData.activeCount),
        completionRate: this.planData.totalCreated > 0 ? this.planData.totalCompleted / this.planData.totalCreated : 0,
        activeCount: this.planData.activeCount,
      },
      tasks: {
        totalRegistered: 0,
        activeInstances: 0,
        completedCount: this.taskCompletedCount,
        failedCount: this.taskFailedCount,
        avgScore: this.taskScoreCount > 0 ? this.taskScoreSum / this.taskScoreCount : 0,
        graphSize: 0,
        cyclesDetected: 0,
      },
      resources: {
        computeUtilization: 0,
        memoryUtilization: 0,
        llmUtilization: 0,
        taskSlotUtilization: 0,
        evolutionRiskLevel: 0,
      },
      stability: {
        healthScore: 100,
        taskFlowEfficiency: 1,
        schedulerBalance: 1,
        evolutionRiskControl: 1,
        errorRateInverse: this.apiCallTotal > 0 ? 1 - this.apiCallFailure / this.apiCallTotal : 1,
      },
      tools: {
        totalCalls: this.toolTotalCalls,
        successCount: this.toolSuccessCount,
        failureCount: this.toolFailureCount,
        byTool: { ...this.toolData },
      },
      guardrail: { ...this.guardrailData },
      executionGoals: { ...this.executionGoalData },
      apiCalls: {
        total: this.apiCallTotal,
        successCount: this.apiCallSuccess,
        failureCount: this.apiCallFailure,
      },
      memory: {
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        rssMB: Math.round(mem.rss / 1024 / 1024),
      },
      uptime: process.uptime(),
      eventLoopLagMs: -1,
      timestamp: Date.now(),
    }
  }

  private getSuccessRate(): number {
    const total = this.evolutionData.totalCycles
    return total > 0 ? this.evolutionData.successCount / total : 1
  }

  private getAvgCycleDuration(): number {
    const durations = this.evolutionData.cycleDurations
    return durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0
  }

  /** 返回稳定性评分所需的因子 */
  getStabilityInputs(): {
    taskFlowEfficiency: number
    schedulerBalance: number
    evolutionRiskControl: number
  } {
    const totalToolCalls = this.toolTotalCalls || 1
    return {
      taskFlowEfficiency:
        this.taskCompletedCount + this.taskFailedCount > 0 ? this.taskCompletedCount / (this.taskCompletedCount + this.taskFailedCount) : 1,
      schedulerBalance: this.planData.totalCreated > 0 ? this.planData.totalCompleted / this.planData.totalCreated : 1,
      evolutionRiskControl: this.evolutionData.totalCycles > 0 ? this.evolutionData.successCount / this.evolutionData.totalCycles : 1,
    }
  }

  /** 返回守卫指标 */
  getGuardrailData(): { totalRejections: number; hardBlocks: number; goalDrifts: number; trippedCount: number } {
    return { ...this.guardrailData }
  }

  /** 重置所有指标 */
  reset(): void {
    this.evolutionData = {
      totalCycles: 0,
      successCount: 0,
      failureCount: 0,
      timeoutCount: 0,
      cycleDurations: [],
      lastCycleTimestamp: null,
    }
    this.planData = {
      totalCreated: 0,
      totalCompleted: 0,
      totalAbandoned: 0,
      activeCount: 0,
    }
    this.toolData = {}
    this.toolTotalCalls = 0
    this.toolSuccessCount = 0
    this.toolFailureCount = 0
    this.apiCallTotal = 0
    this.apiCallSuccess = 0
    this.apiCallFailure = 0
    this.taskCompletedCount = 0
    this.taskFailedCount = 0
    this.taskScoreSum = 0
    this.taskScoreCount = 0
    this.guardrailData = {
      totalRejections: 0,
      hardBlocks: 0,
      goalDrifts: 0,
      trippedCount: 0,
    }
    this.executionGoalData = {
      created: 0,
      completed: 0,
      blocked: 0,
      abandoned: 0,
    }
  }

  /** 清理事件订阅 */
  destroy(): void {
    for (const unsub of this.unsubscribers) {
      unsub()
    }
    this.unsubscribers = []
  }
}
