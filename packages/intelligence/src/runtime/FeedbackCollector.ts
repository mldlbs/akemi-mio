/**
 * FeedbackCollector — 反馈收集器
 *
 * 注册到 ExecutionRuntime.onFeedback()
 * 每次 Runtime 执行完毕后接收 FeedbackEvent
 * 将反馈数据分发到：GoalEngine, IdentityModule, Memory, Evolution
 */

import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import type { FeedbackEvent } from './types'
import type { GoalEngine } from '../cognitive/GoalEngine'
import type { IdentityModule } from '@akemi-mio/intelligence-identity'
import type { MemoryService } from '@akemi-mio/intelligence-memory/MemoryService'
import type { EngineeringMemory } from '@akemi-mio/intelligence-memory/EngineeringMemory'

export class FeedbackCollector {
  private goalEngine: GoalEngine | null = null
  private identityModule: IdentityModule | null = null
  private memoryService: MemoryService | null = null
  private engineeringMemory: EngineeringMemory | null = null

  stats = {
    totalTasks: 0,
    successTasks: 0,
    failedTasks: 0,
    totalTools: 0,
    successTools: 0,
    failedTools: 0,
    totalBudgetRejected: 0,
    totalGoalRejected: 0,
    recentFailures: [] as string[],
    bySource: {} as Record<string, { total: number; success: number; tools: number; failedTools: number }>,
  }

  setGoalEngine(engine: GoalEngine): void {
    this.goalEngine = engine
  }
  setIdentityModule(mod: IdentityModule): void {
    this.identityModule = mod
  }
  setMemoryService(ms: MemoryService): void {
    this.memoryService = ms
  }
  setEngineeringMemory(em: EngineeringMemory): void {
    this.engineeringMemory = em
  }
  setResourceController(rc: any): void {
    /* reserved */
  }

  async handle(event: FeedbackEvent): Promise<void> {
    this.stats.totalTasks++
    event.result.success ? this.stats.successTasks++ : this.stats.failedTasks++

    if (!this.stats.bySource[event.source]) {
      this.stats.bySource[event.source] = { total: 0, success: 0, tools: 0, failedTools: 0 }
    }
    this.stats.bySource[event.source].total++
    if (event.result.success) this.stats.bySource[event.source].success++

    const toolCount = event.result.toolExecutions.length
    this.stats.totalTools += toolCount
    this.stats.bySource[event.source].tools += toolCount
    for (const te of event.result.toolExecutions) {
      te.result.success ? this.stats.successTools++ : this.stats.failedTools++
      if (!te.result.success) this.stats.bySource[event.source].failedTools++
    }

    if (event.budgetRejected) this.stats.totalBudgetRejected++
    if (event.goalRejected) this.stats.totalGoalRejected++

    if (event.failurePattern) {
      this.stats.recentFailures.push(`[${event.source}] ${event.failurePattern}`)
      if (this.stats.recentFailures.length > 20) this.stats.recentFailures = this.stats.recentFailures.slice(-20)
    }

    // Identity 更新
    if (this.identityModule && event.result.toolExecutions.length >= 3) {
      const rate = event.toolSuccessRate
      if (rate < 0.3) {
        this.identityModule.updateTraits({ score: 0.3, reason: 'tool_failure', context: `runtime_${event.source}` })
      } else if (rate > 0.8) {
        this.identityModule.updateTraits({ score: 0.8, reason: 'tool_success', context: `runtime_${event.source}` })
      }
    }

    // EngineeringMemory 存储失败模式
    if (this.engineeringMemory && event.failurePattern) {
      this.engineeringMemory.store({
        type: 'failure_pattern',
        content: `[${event.source}] ${event.failurePattern}`,
        source: `runtime_${event.taskId}`,
        confidence: 0.6,
        relatedFiles: [],
        tags: ['runtime_feedback', event.source],
      })
    }

    // 发出 EventBus 事件供 Evolution 消费
    eventBus.emit('runtime.feedback.collected' as any, {
      source: event.source,
      success: event.result.success,
      toolSuccessRate: event.toolSuccessRate,
      phaseTiming: event.result.phaseTiming,
      totalMs: event.result.totalMs,
      failurePattern: event.failurePattern,
      timestamp: event.timestamp,
    })
  }

  getFormattedContext(): string {
    const lines: string[] = ['---', '【Runtime 执行统计】']
    lines.push(`总任务: ${this.stats.totalTasks} (成功: ${this.stats.successTasks}, 失败: ${this.stats.failedTasks})`)
    lines.push(`总工具调用: ${this.stats.totalTools} (成功: ${this.stats.successTools}, 失败: ${this.stats.failedTools})`)
    lines.push(`预算拒绝: ${this.stats.totalBudgetRejected}, 目标拒绝: ${this.stats.totalGoalRejected}`)
    for (const [source, s] of Object.entries(this.stats.bySource)) {
      lines.push(`  ${source}: ${s.total} 任务, ${s.success} 成功, ${s.tools} 工具, ${s.failedTools} 失败`)
    }
    if (this.stats.recentFailures.length > 0) {
      lines.push('', '近期失败模式:')
      for (const f of this.stats.recentFailures.slice(-5)) lines.push(`  - ${f.slice(0, 120)}`)
    }
    lines.push('---')
    return lines.join('\n')
  }

  resetStats(): void {
    this.stats = {
      totalTasks: 0,
      successTasks: 0,
      failedTasks: 0,
      totalTools: 0,
      successTools: 0,
      failedTools: 0,
      totalBudgetRejected: 0,
      totalGoalRejected: 0,
      recentFailures: [],
      bySource: {},
    }
  }
}
