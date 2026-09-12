import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, promises as fsp } from 'fs'
import { join } from 'path'
import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus } from '@akemi-mio/core/core/EventBus'
import type { RunContext } from './runstate'
import type { ConversationContext } from './context'
import type { ResourceBudget } from '@akemi-mio/core/core/ResourceBudget'
import type { CircuitBreaker } from '@akemi-mio/core/core/CircuitBreaker'

// =============================================================================
// Checkpoint 类型定义
// =============================================================================

export interface CheckpointData {
  meta: {
    version: 1
    runId: string
    timestamp: number
    trigger: 'milestone' | 'error' | 'interrupt' | 'shutdown'
  }
  runContext: {
    step: number
    state: string
    consecutiveTimeouts: number
    consecutiveToolErrors: number
    forceContinueCount: number
    forceContinueStagnation: number
    interruptFlag: boolean
    interruptReason: string
  }
  conversationSummary: string
  conversationStats: {
    totalMessages: number
    totalTurns: number
    lastUserMessage: string
    lastAssistantMessage: string
  }
  shortTermMemory: Array<{ user: string; assistant: string }>
  planState: {
    activePlanId: string | null
    activePlanTitle: string | null
    sessionPlanIds: string[]
    pendingStepDescriptions: string[]
  }
  resourceState: Record<string, number>
  circuitBreakerState: Record<string, { state: string; failures: number }>
  timestamps: {
    sessionStartedAt: number
    lastCheckpointAt: number
  }
  /** M6 execution goal id: used for recovery prompt after restart, not re-execution */
  executionGoalId?: string | null
}

export interface CheckpointParams {
  trigger: CheckpointData['meta']['trigger']
  runContext: RunContext | null
  context: ConversationContext
  runId: string
  planState: {
    activePlanId: string | null
    activePlanTitle: string | null
    sessionPlanIds: string[]
    pendingStepDescriptions?: string[]
  }
  resourceBudget?: ResourceBudget
  circuitBreaker?: CircuitBreaker
  error?: string
  executionGoalId?: string | null
}

// =============================================================================
// SessionRecoveryManager — 检查点保存/恢复，TASK.md/STATUS.md 管理
// =============================================================================

export class SessionRecoveryManager {
  private baseDir: string
  private checkpointsDir: string
  private sessionStartedAt: number
  /** 最近一次创建检查点的时间戳，用于防抖 */
  private lastCheckpointTime = 0

  constructor(baseDir: string) {
    this.baseDir = baseDir
    this.checkpointsDir = join(baseDir, 'checkpoints')
    this.sessionStartedAt = Date.now()
    this.ensureDirs()
  }

  // ── 目录初始化 ──

  private ensureDirs(): void {
    if (!existsSync(this.checkpointsDir)) {
      mkdirSync(this.checkpointsDir, { recursive: true })
    }
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true })
    }
  }

  // ── 检查点创建 ──

  async createCheckpoint(params: CheckpointParams): Promise<string> {
    // 防抖：同一 runId 的检查点 3 秒内不重复创建
    const now = Date.now()
    if (now - this.lastCheckpointTime < 3000 && params.trigger === 'milestone') {
      return ''
    }
    this.lastCheckpointTime = now

    try {
      const data = this.assembleCheckpointData(params)
      const filename = `chk_${params.runId}_${data.meta.timestamp}.json`
      const filePath = join(this.checkpointsDir, filename)
      const latestPath = join(this.checkpointsDir, 'latest.json')

      await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
      await fsp.writeFile(latestPath, JSON.stringify(data, null, 2), 'utf-8')

      await this.writeTaskStatus(data)
      await this.writeSummaryStatus(data)
      await this.appendHistory({ runId: params.runId, timestamp: data.meta.timestamp, trigger: data.meta.trigger })

      eventBus.emit('recovery.checkpoint.created', {
        runId: params.runId,
        trigger: data.meta.trigger,
        path: filePath,
      })

      log('INFO', 'checkpoint_created', {
        runId: params.runId,
        trigger: data.meta.trigger,
        path: filename,
      })

      return filePath
    } catch (err: any) {
      log('WARN', 'checkpoint_create_failed', { error: String(err) })
      return ''
    }
  }

  // ── 恢复 ──

  restoreLatestCheckpoint(): CheckpointData | null {
    try {
      const latestPath = join(this.checkpointsDir, 'latest.json')
      if (!existsSync(latestPath)) return null

      const raw = readFileSync(latestPath, 'utf-8')
      const data = JSON.parse(raw) as CheckpointData

      if (data.meta.version !== 1) {
        log('WARN', 'checkpoint_version_mismatch', { version: data.meta.version })
        return null
      }

      log('INFO', 'checkpoint_restored', {
        runId: data.meta.runId,
        trigger: data.meta.trigger,
        timestamp: new Date(data.meta.timestamp).toISOString(),
      })

      return data
    } catch (err: any) {
      log('WARN', 'checkpoint_restore_failed', { error: String(err) })
      return null
    }
  }

  hasInterruptedSession(): boolean {
    const latestPath = join(this.checkpointsDir, 'latest.json')
    if (!existsSync(latestPath)) return false

    // 检查 STATUS.md 是否有完成/不可恢复标记
    const statusPath = join(this.baseDir, 'STATUS.md')
    if (existsSync(statusPath)) {
      const content = readFileSync(statusPath, 'utf-8')
      if (content.includes('Restorable: false') || content.includes('Status: COMPLETED')) {
        return false
      }
    }

    return true
  }

  clearSession(): void {
    try {
      const latestPath = join(this.checkpointsDir, 'latest.json')
      if (existsSync(latestPath)) {
        unlinkSync(latestPath)
      }

      const statusPath = join(this.baseDir, 'STATUS.md')
      if (existsSync(statusPath)) {
        writeFileSync(statusPath, ['# Session Status', '', `Cleared: ${new Date().toISOString()}`, 'Restorable: false'].join('\n'), 'utf-8')
      }

      log('INFO', 'session_cleared')
    } catch (err: any) {
      log('WARN', 'session_clear_failed', { error: String(err) })
    }
  }

  /** 获取最近恢复的 checkpoints 记录条数，用于恢复循环检测 */
  getRecoveryFailCount(): number {
    try {
      const statusPath = join(this.baseDir, 'STATUS.md')
      if (!existsSync(statusPath)) return 0
      const content = readFileSync(statusPath, 'utf-8')
      const match = content.match(/RecoveryFailCount:\s*(\d+)/)
      return match ? parseInt(match[1], 10) : 0
    } catch {
      return 0
    }
  }

  /** 增加恢复失败计数 */
  incrementRecoveryFailCount(): void {
    try {
      const statusPath = join(this.baseDir, 'STATUS.md')
      const current = this.getRecoveryFailCount()
      const newCount = current + 1

      const lines = existsSync(statusPath) ? readFileSync(statusPath, 'utf-8').split('\n') : ['# Session Status', '', 'Restorable: true']

      const idx = lines.findIndex((l) => l.startsWith('RecoveryFailCount:'))
      if (idx >= 0) {
        lines[idx] = `RecoveryFailCount: ${newCount}`
      } else {
        lines.push(`RecoveryFailCount: ${newCount}`)
      }

      writeFileSync(statusPath, lines.join('\n'), 'utf-8')
      log('INFO', 'recovery_fail_count_incremented', { count: newCount })
    } catch (err: any) {
      log('WARN', 'recovery_fail_count_failed', { error: String(err) })
    }
  }

  /** 重置恢复失败计数 */
  resetRecoveryFailCount(): void {
    try {
      const statusPath = join(this.baseDir, 'STATUS.md')
      if (!existsSync(statusPath)) return
      const lines = readFileSync(statusPath, 'utf-8').split('\n')
      const filtered = lines.filter((l) => !l.startsWith('RecoveryFailCount:'))
      writeFileSync(statusPath, filtered.join('\n'), 'utf-8')
    } catch {
      // 静默处理
    }
  }

  /** 记录当前日期用于恢复循环时间窗口检测 */
  recordRecoveryAttempt(): void {
    try {
      const statusPath = join(this.baseDir, 'STATUS.md')
      const lines = existsSync(statusPath) ? readFileSync(statusPath, 'utf-8').split('\n') : ['# Session Status', '', 'Restorable: true']

      const filtered = lines.filter((l) => !l.startsWith('LastRecovery:'))
      filtered.push(`LastRecovery: ${Date.now()}`)
      writeFileSync(statusPath, filtered.join('\n'), 'utf-8')
    } catch {
      // 静默处理
    }
  }

  /** 检查恢复循环：连续 3 次恢复且 60 秒内 */
  isRecoveryLoop(): boolean {
    try {
      const statusPath = join(this.baseDir, 'STATUS.md')
      if (!existsSync(statusPath)) return false
      const content = readFileSync(statusPath, 'utf-8')
      const countMatch = content.match(/RecoveryFailCount:\s*(\d+)/)
      if (!countMatch || parseInt(countMatch[1], 10) < 3) return false

      const timeMatch = content.match(/LastRecovery:\s*(\d+)/)
      if (!timeMatch) return false

      const lastRecovery = parseInt(timeMatch[1], 10)
      if (Date.now() - lastRecovery > 60000) return false // 超过 60 秒不计入循环

      return true
    } catch {
      return false
    }
  }

  // ── 内部方法 ──

  private assembleCheckpointData(params: CheckpointParams): CheckpointData {
    const rc = params.runContext
    const ctx = params.context

    let lastUser = ''
    let lastAssistant = ''
    const messages = ctx.getMessages?.() || []
    for (let i = messages.length - 1; i > 0; i--) {
      if (messages[i].role === 'assistant' && !lastAssistant) {
        lastAssistant = typeof messages[i].content === 'string' ? (messages[i].content as string) : ''
      }
      if (messages[i].role === 'user' && !lastUser) {
        lastUser = typeof messages[i].content === 'string' ? (messages[i].content as string) : ''
      }
      if (lastUser && lastAssistant) break
    }

    // 保存短期记忆
    ctx.saveToShortTermMemory?.(5)

    // 使用类型断言访问 private 属性
    const shortTermMemory: Array<{ user: string; assistant: string }> = (ctx as any)['shortTermMemory'] || []

    let conversationSummary = ''
    if (shortTermMemory.length > 0) {
      conversationSummary = shortTermMemory
        .slice(-3)
        .map((m) => `用户: ${m.user.slice(0, 100)}\n你: ${m.assistant.slice(0, 200)}`)
        .join('\n\n')
    }

    return {
      meta: {
        version: 1,
        runId: params.runId,
        timestamp: Date.now(),
        trigger: params.trigger,
      },
      runContext: {
        step: rc?.step ?? 0,
        state: rc?.state ?? 'ready',
        consecutiveTimeouts: rc?.consecutiveTimeouts ?? 0,
        consecutiveToolErrors: rc?.consecutiveToolErrors ?? 0,
        forceContinueCount: rc?.forceContinueCount ?? 0,
        forceContinueStagnation: rc?.forceContinueStagnation ?? 0,
        interruptFlag: rc?.interruptFlag ?? false,
        interruptReason: rc?.interruptReason ?? '',
      },
      conversationSummary: conversationSummary.slice(0, 1000),
      conversationStats: {
        totalMessages: messages.length,
        totalTurns: Math.floor(messages.filter((m) => m.role === 'user').length),
        lastUserMessage: lastUser.slice(0, 200),
        lastAssistantMessage: lastAssistant.slice(0, 200),
      },
      shortTermMemory: shortTermMemory.slice(-5),
      planState: {
        activePlanId: params.planState.activePlanId,
        activePlanTitle: params.planState.activePlanTitle,
        sessionPlanIds: params.planState.sessionPlanIds,
        pendingStepDescriptions: params.planState.pendingStepDescriptions ?? [],
      },
      resourceState: params.resourceBudget?.getSnapshot?.() ?? {},
      circuitBreakerState: params.circuitBreaker?.getSnapshot?.() ?? {},
      executionGoalId: params.executionGoalId ?? rc?.activeGoalId ?? null,
      timestamps: {
        sessionStartedAt: this.sessionStartedAt,
        lastCheckpointAt: Date.now(),
      },
    }
  }

  private async writeTaskStatus(data: CheckpointData): Promise<void> {
    try {
      const lines: string[] = [
        '# Session Tasks',
        '',
        `Session started: ${new Date(this.sessionStartedAt).toISOString()}`,
        `Last activity: ${new Date(data.meta.timestamp).toISOString()}`,
        '',
      ]

      if (data.planState.activePlanTitle) {
        lines.push(`Active Plan: ${data.planState.activePlanTitle} (id: ${data.planState.activePlanId})`)
        lines.push('')
        if (data.planState.pendingStepDescriptions.length > 0) {
          lines.push('Pending Steps:')
          for (const step of data.planState.pendingStepDescriptions) {
            lines.push(`  - [ ] ${step}`)
          }
        }
        lines.push('')
      }

      lines.push(`Last Checkpoint: chk_${data.meta.runId}_${data.meta.timestamp}.json`)
      lines.push(`Conversation turns: ${data.conversationStats.totalTurns}`)

      const filePath = join(this.baseDir, 'TASK.md')
      await fsp.writeFile(filePath, lines.join('\n'), 'utf-8')
    } catch (err: any) {
      log('WARN', 'task_status_write_failed', { error: String(err) })
    }
  }

  private async writeSummaryStatus(data: CheckpointData): Promise<void> {
    try {
      const lines: string[] = [
        '# Session Status',
        '',
        `Session ID: ${data.meta.runId}`,
        'Status: ACTIVE (recovery available)',
        `Age: ${Math.round((data.meta.timestamp - this.sessionStartedAt) / 1000)}s`,
        `Total Checkpoints: ${this.getCheckpointCount()}`,
        '',
        'Recovery:',
        `  Last Trigger: ${data.meta.trigger}`,
        '  Restorable: true',
        '',
        'Circuit Breaker:',
      ]

      for (const [key, val] of Object.entries(data.circuitBreakerState)) {
        lines.push(`  ${key}: ${val.state} (${val.failures} failures)`)
      }

      lines.push('')
      lines.push('Memory:')
      lines.push(`  Short-term pairs: ${data.shortTermMemory.length}`)
      lines.push(`  Total messages tracked: ${data.conversationStats.totalMessages}`)

      const filePath = join(this.baseDir, 'STATUS.md')
      await fsp.writeFile(filePath, lines.join('\n'), 'utf-8')
    } catch (err: any) {
      log('WARN', 'summary_status_write_failed', { error: String(err) })
    }
  }

  private async appendHistory(entry: { runId: string; timestamp: number; trigger: string }): Promise<void> {
    try {
      const historyPath = join(this.baseDir, 'history.json')
      let history: Array<{ runId: string; timestamp: number; trigger: string }> = []

      if (existsSync(historyPath)) {
        history = JSON.parse(await fsp.readFile(historyPath, 'utf-8'))
      }

      history.push(entry)
      if (history.length > 20) {
        history = history.slice(-20)
      }

      await fsp.writeFile(historyPath, JSON.stringify(history, null, 2), 'utf-8')
    } catch (err: any) {
      log('WARN', 'history_append_failed', { error: String(err) })
    }
  }

  private getCheckpointCount(): number {
    try {
      const files = readdirSync(this.checkpointsDir)
      return files.filter((f) => f.startsWith('chk_') && f.endsWith('.json')).length
    } catch {
      return 0
    }
  }
}
