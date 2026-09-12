/**
 * GoalScheduler — 目标调度器
 *
 * GoalEngine 决定「做什么」
 * GoalScheduler 决定「什么时候做」
 * ExecutionRuntime 决定「怎么做」
 */

import { log } from '@akemi-mio/core/logger/Logger'
import type { GoalEngine, Goal } from '../cognitive/GoalEngine'
import type { ExecutionRuntime } from './ExecutionRuntime'
import type { RuntimeTask, TaskSource, RuntimeResult } from './types'

export interface ScheduledTask {
  id: string
  goalId: string
  goalTitle: string
  priority: number
  source: TaskSource
  input: string
  systemPrompt?: string
  createdAt: number
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  result?: RuntimeResult
  executionCount: number
  lastRunAt?: number
}

const TASK_PRIORITY_MIN = 1
const TASK_PRIORITY_MAX = 10

export class GoalScheduler {
  private goalEngine: GoalEngine | null = null
  private runtime: ExecutionRuntime | null = null
  private queue: ScheduledTask[] = []
  private taskCounter = 0
  private running = false
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly tickMs = 60_000

  private readonly defaultTemplates: Record<string, { input: string; systemPrompt: string; source: TaskSource }> = {
    提高任务完成率: {
      input: '分析最近的工具执行失败模式，提出改进方案。',
      systemPrompt: '你是一个任务优化引擎。分析失败模式，给出具体改进建议。',
      source: 'evolution',
    },
    优化记忆系统: {
      input: '检查记忆系统的存储和检索效率，找出优化点。',
      systemPrompt: '你是一个记忆系统分析引擎。聚焦于存储效率、检索准确度和去重策略。',
      source: 'research',
    },
    提升代码质量: {
      input: '扫描代码库中近期变更，检测潜在问题。',
      systemPrompt: '你是一个代码质量分析引擎。关注类型安全、错误处理和性能。',
      source: 'evolution',
    },
  }

  setGoalEngine(engine: GoalEngine): void {
    this.goalEngine = engine
  }

  setRuntime(runtime: ExecutionRuntime): void {
    this.runtime = runtime
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.timer = setInterval(() => this.tick(), this.tickMs)
    log('INFO', 'goal_scheduler_started', { tickMs: this.tickMs })
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    log('INFO', 'goal_scheduler_stopped')
  }

  triggerNow(): void {
    this.tick()
  }

  enqueue(task: Omit<ScheduledTask, 'id' | 'createdAt' | 'status' | 'executionCount'>): string {
    const id = `sched_${Date.now()}_${++this.taskCounter}`
    const scheduled: ScheduledTask = {
      ...task,
      id,
      createdAt: Date.now(),
      status: 'pending',
      executionCount: 0,
    }
    this.queue.push(scheduled)
    this.queue.sort((a, b) => b.priority - a.priority)
    log('INFO', 'goal_scheduler_enqueued', { id, goalTitle: task.goalTitle, priority: task.priority })
    return id
  }

  dequeue(id: string): void {
    this.queue = this.queue.filter((t) => t.id !== id)
  }

  getQueue(): ScheduledTask[] {
    return [...this.queue]
  }

  getPending(): ScheduledTask[] {
    return this.queue.filter((t) => t.status === 'pending')
  }

  private async tick(): Promise<void> {
    if (!this.runtime || !this.goalEngine) return
    if (this.runtime.hasRunningTasks()) return

    try {
      const goals = this.goalEngine.getActiveGoals()
      if (goals.length === 0) return

      for (const goal of goals) {
        this.scheduleForGoal(goal)
      }

      await this.dispatchNext()
    } catch (err: any) {
      log('ERROR', 'goal_scheduler_tick_error', { error: err.message })
    }
  }

  private scheduleForGoal(goal: Goal): void {
    const existing = this.queue.find((t) => t.goalId === goal.id && t.status === 'pending')
    if (existing) return

    const lastRun = this.queue.filter((t) => t.goalId === goal.id).sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0))[0]
    if (lastRun?.lastRunAt && Date.now() - lastRun.lastRunAt < 30 * 60 * 1000) return

    const template = this.defaultTemplates[goal.title]
    if (!template) return

    const priority = Math.min(TASK_PRIORITY_MAX, Math.max(TASK_PRIORITY_MIN, goal.priority))
    this.enqueue({
      goalId: goal.id,
      goalTitle: goal.title,
      priority,
      source: template.source,
      input: template.input,
      systemPrompt: `目标: ${goal.title} - ${goal.description}\n\n${template.systemPrompt}`,
    })
  }

  private async dispatchNext(): Promise<void> {
    const pending = this.queue.filter((t) => t.status === 'pending')
    if (pending.length === 0) return

    const task = pending[0]
    task.status = 'running'

    const runtimeTask: RuntimeTask = {
      id: task.id,
      source: task.source,
      input: task.input,
      systemPrompt: task.systemPrompt,
      goalId: task.goalId,
      createdAt: Date.now(),
    }

    try {
      const result = await this.runtime!.execute(runtimeTask)
      task.status = result.success ? 'completed' : 'failed'
      task.result = result
      task.executionCount++
      task.lastRunAt = Date.now()

      if (result.success && this.goalEngine) {
        this.goalEngine.updateProgress(task.goalId, 10)
      }
    } catch (err: any) {
      task.status = 'failed'
      task.executionCount++
      task.lastRunAt = Date.now()
    }

    if (this.queue.length > 50) {
      this.queue = this.queue.sort((a, b) => (b.lastRunAt ?? b.createdAt) - (a.lastRunAt ?? a.createdAt)).slice(0, 50)
    }
  }

  getDiagnostics(): Record<string, unknown> {
    return {
      running: this.running,
      queueLength: this.queue.length,
      pending: this.getPending().length,
      tasks: this.queue.map((t) => ({
        id: t.id,
        goalTitle: t.goalTitle,
        priority: t.priority,
        status: t.status,
        executionCount: t.executionCount,
      })),
    }
  }
}
