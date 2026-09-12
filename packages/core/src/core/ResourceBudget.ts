import { log } from '@akemi-mio/core/logger/Logger'
import { eventBus } from './EventBus'
import { WORKSPACE } from '@akemi-mio/core/config'
import { join, dirname } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'

/** 预算超限异常 — Hard Budget 模式下消耗方必须处理 */
export class BudgetExceededError extends Error {
  constructor(
    public readonly resource: string,
    public readonly used: number,
    public readonly limit: number,
  ) {
    super(`Budget exceeded: ${resource} (${used}/${limit})`)
    this.name = 'BudgetExceededError'
  }
}

export interface BudgetConfig {
  /** 单次请求最大 LLM token 调用次数（含 introspection 和 retry） */
  maxLlmCallsPerRequest: number
  /** 单次 toolLoop 最大轮次 */
  maxToolLoopTurns: number
  /** 单次 LLM 调用超时（ms） */
  llmTimeoutMs: number
  /** Chat 对话最大 LLM 调用次数 */
  maxChatLlmCalls: number
  /** Evolution 循环最大 token 预算（近似，基于调用次数） */
  maxEvolutionLlmCalls: number
  /** 后台服务（reflect/sleep）最大 LLM 调用次数 */
  maxBackgroundLlmCalls: number
  /** 研究任务最大 LLM 调用次数 */
  maxResearchLlmCalls: number
  /** 单次请求最大 CPU 耗时（ms） */
  maxCpuMs: number
  /** 单次请求最大内存（MB） */
  maxMemoryMb: number
  /** toolLoop 软 override 额外轮次（仅超限时可用） */
  softOverrideTurns: number
  /** soft reply 阈值：超过此轮次后注入提示强制 LLM 生成回复（0 = 禁用） */
  softReplyThreshold: number
  /** Evolution 自任务最大 toolLoop 轮次 */
  selfTaskMaxToolLoopTurns: number
}

const DEFAULT_BUDGET: BudgetConfig = {
  maxLlmCallsPerRequest: 300,
  maxToolLoopTurns: 200,
  llmTimeoutMs: 120000,
  maxChatLlmCalls: 500,
  maxEvolutionLlmCalls: 50,
  maxBackgroundLlmCalls: 15,
  maxResearchLlmCalls: 50,
  maxCpuMs: 120_000,
  maxMemoryMb: 512,
  softOverrideTurns: 15,
  softReplyThreshold: 10,
  selfTaskMaxToolLoopTurns: 30,
}

interface BudgetState {
  llmCallsThisRequest: number
  toolLoopTurnsThisCycle: number
  evolutionLlmCallsThisCycle: number
  backgroundLlmCallsThisCycle: number
  chatLlmCallsThisCycle: number
  researchLlmCallsThisCycle: number
  cpuMsThisRequest: number
  memoryPeakMb: number
  requestStartTime: number
  contextExhausted: Set<string>
  /** 已经发出过 budget.exhausted 事件的资源集合（去重） */
  exhaustedEmitted: Set<string>
  /** 进入软 override 时的轮次（-1 表示未进入） */
  softOverrideEnteredAt: number
}

interface TaskBudget {
  taskId: string
  llmCallsUsed: number
  llmBudget: number
  cpuMsUsed: number
  cpuBudget: number
}

// ==================== 进程级预算 ====================

export interface ProcessBudgetConfig {
  maxMemoryMb: number
  maxCpuMs: number
  maxRestarts: number
}

export interface ProcessUtilization {
  memoryMb: number
  cpuMs: number
  restarts: number
}

interface ProcessBudget {
  config: ProcessBudgetConfig
  utilization: ProcessUtilization
}

/**
 * ResourceBudget — Agent OS 资源预算管理器。
 *
 * 防止单个请求或后台服务耗尽全系统的 LLM 配额。
 * 支持 CPU/内存预算、任务级预算、响应式强制执行和稳定性自适应调节。
 *
 * budget.exhausted 事件去重规则：
 * - 每种资源类型（llm.request / llm.evolution / toolLoop / cpu / memory）
 *   在同一个 request 生命周期内只 emit 一次
 * - 软 override 阶段不重复 emit，仅在硬停止时记录一次
 */
export class ResourceBudget {
  private config: BudgetConfig
  private state: BudgetState
  private taskBudgets = new Map<string, TaskBudget>()
  private processBudgets = new Map<string, ProcessBudget>()
  private originalConfig: BudgetConfig
  private readonly budgetFilePath: string

  constructor(config?: Partial<BudgetConfig>, budgetFilePath?: string) {
    this.config = { ...DEFAULT_BUDGET, ...config }
    this.originalConfig = { ...this.config }
    this.budgetFilePath = budgetFilePath || join(WORKSPACE.evolution, 'resource_budget.json')
    this.state = this.freshState()
    this.loadState()
  }

  private freshState(): BudgetState {
    return {
      llmCallsThisRequest: 0,
      toolLoopTurnsThisCycle: 0,
      chatLlmCallsThisCycle: 0,
      evolutionLlmCallsThisCycle: 0,
      backgroundLlmCallsThisCycle: 0,
      researchLlmCallsThisCycle: 0,
      cpuMsThisRequest: 0,
      memoryPeakMb: 0,
      requestStartTime: Date.now(),
      contextExhausted: new Set(),
      exhaustedEmitted: new Set(),
      softOverrideEnteredAt: -1,
    }
  }

  /** 检查是否有任何预算已耗尽 */
  isExhausted(): boolean {
    return (
      this.state.contextExhausted.size > 0 ||
      this.state.llmCallsThisRequest >= this.config.maxLlmCallsPerRequest ||
      this.state.cpuMsThisRequest >= this.config.maxCpuMs
    )
  }

  /** 开始新请求，重置所有计数器 */
  startRequest(): void {
    const wasExhausted = this.isExhausted()
    this.state = this.freshState()
    if (wasExhausted) {
      eventBus.emit('budget.restored', { resource: 'request', utilization: 0 })
    }
  }

  // ==================== LLM 预算 ====================

  checkLlmCall(context: 'chat' | 'evolution' | 'background' | 'research'): string | null {
    if (this.state.contextExhausted.has(context)) {
      return `${context}: 配额已耗尽`
    }

    const maxMap: Record<string, number> = {
      chat: this.config.maxChatLlmCalls,
      evolution: this.config.maxEvolutionLlmCalls,
      background: this.config.maxBackgroundLlmCalls,
      research: this.config.maxResearchLlmCalls,
    }
    const currentMap: Record<string, () => number> = {
      chat: () => this.state.chatLlmCallsThisCycle,
      evolution: () => this.state.evolutionLlmCallsThisCycle,
      background: () => this.state.backgroundLlmCallsThisCycle,
      research: () => this.state.researchLlmCallsThisCycle,
    }

    const max = maxMap[context]
    const current = currentMap[context]()
    if (current >= max) {
      return `${context}: LLM 配额已超 (${current}/${max})`
    }
    return null
  }

  /** 消耗一次 LLM 调用 — 超限时抛出 BudgetExceededError（Hard Budget） */
  consumeLlmCall(context: 'chat' | 'evolution' | 'background' | 'research'): void {
    const maxMap: Record<string, number> = {
      chat: this.config.maxChatLlmCalls,
      evolution: this.config.maxEvolutionLlmCalls,
      background: this.config.maxBackgroundLlmCalls,
      research: this.config.maxResearchLlmCalls,
    }
    const currentMap: Record<string, () => number> = {
      chat: () => this.state.chatLlmCallsThisCycle,
      evolution: () => this.state.evolutionLlmCallsThisCycle,
      background: () => this.state.backgroundLlmCallsThisCycle,
      research: () => this.state.researchLlmCallsThisCycle,
    }
    const incrementMap: Record<string, () => void> = {
      chat: () => {
        this.state.chatLlmCallsThisCycle++
      },
      evolution: () => {
        this.state.evolutionLlmCallsThisCycle++
      },
      background: () => {
        this.state.backgroundLlmCallsThisCycle++
      },
      research: () => {
        this.state.researchLlmCallsThisCycle++
      },
    }

    const max = maxMap[context]
    const current = currentMap[context]()

    if (current >= max) {
      this.state.contextExhausted.add(context)
      const resourceKey = `llm.${context}`
      if (!this.state.exhaustedEmitted.has(resourceKey)) {
        this.state.exhaustedEmitted.add(resourceKey)
        eventBus.emit('budget.exhausted', {
          resource: resourceKey,
          utilization: current / max,
        })
        log('WARN', 'budget_hard_exhausted', { resource: resourceKey, used: current, limit: max })
      }
      throw new BudgetExceededError(`llm.${context}`, current, max)
    }

    incrementMap[context]()
  }

  // ==================== ToolLoop 预算 ====================

  checkToolLoopTurn(): string | null {
    if (this.state.toolLoopTurnsThisCycle >= this.config.maxToolLoopTurns) {
      return `ToolLoop 轮次超限 (${this.state.toolLoopTurnsThisCycle}/${this.config.maxToolLoopTurns})`
    }
    return null
  }

  /**
   * 消耗一次 ToolLoop 轮次 — 超限时抛出 BudgetExceededError
   *
   * 去重规则：toolLoop 资源只在首次超限时 emit 一次 budget.exhausted。
   * 后续的软 override 轮次不再重复 emit，避免日志/Telegram 风暴。
   */
  consumeToolLoopTurn(): void {
    if (this.state.toolLoopTurnsThisCycle >= this.config.maxToolLoopTurns) {
      // 已进入软 override 阶段
      if (this.state.softOverrideEnteredAt < 0) {
        // 首次超限：记录并 emit 一次
        this.state.softOverrideEnteredAt = this.state.toolLoopTurnsThisCycle
        this.state.contextExhausted.add('toolLoop')

        if (!this.state.exhaustedEmitted.has('toolLoop')) {
          this.state.exhaustedEmitted.add('toolLoop')
          eventBus.emit('budget.exhausted', {
            resource: 'toolLoop',
            utilization: 1,
          })
          log('WARN', 'budget_soft_override_started', {
            resource: 'toolLoop',
            used: this.state.toolLoopTurnsThisCycle,
            limit: this.config.maxToolLoopTurns,
            overrideAllowed: this.config.softOverrideTurns,
          })
        }
      }

      // 检查软 override 是否也耗尽
      const extraTurns = this.state.toolLoopTurnsThisCycle - this.config.maxToolLoopTurns
      if (extraTurns >= this.config.softOverrideTurns) {
        // 硬停止：软 override 轮次用完
        if (!this.state.exhaustedEmitted.has('toolLoop.hard')) {
          this.state.exhaustedEmitted.add('toolLoop.hard')
          log('WARN', 'budget_hard_stop', {
            resource: 'toolLoop',
            used: this.state.toolLoopTurnsThisCycle,
            hardLimit: this.config.maxToolLoopTurns + this.config.softOverrideTurns,
          })
        }
        throw new BudgetExceededError(
          'toolLoop',
          this.state.toolLoopTurnsThisCycle,
          this.config.maxToolLoopTurns + this.config.softOverrideTurns,
        )
      }

      // 软 override 中：不抛异常，只记录，继续递增
      this.state.toolLoopTurnsThisCycle++
      return
    }

    this.state.toolLoopTurnsThisCycle++
  }

  /** 是否正在软 override 中 */
  isInSoftOverride(): boolean {
    return this.state.softOverrideEnteredAt >= 0
  }

  /** 获取软 override 剩余轮次 */
  getSoftOverrideRemaining(): number {
    if (!this.isInSoftOverride()) return 0
    const extra = this.state.toolLoopTurnsThisCycle - this.config.maxToolLoopTurns
    return Math.max(0, this.config.softOverrideTurns - extra)
  }

  // ==================== CPU 预算 ====================

  /** 消耗 CPU 时间 — 超限时抛出 BudgetExceededError */
  consumeCpuMs(durationMs: number): void {
    this.state.cpuMsThisRequest += durationMs
    if (this.state.cpuMsThisRequest >= this.config.maxCpuMs) {
      this.state.contextExhausted.add('cpu')
      if (!this.state.exhaustedEmitted.has('cpu')) {
        this.state.exhaustedEmitted.add('cpu')
        eventBus.emit('budget.exhausted', {
          resource: 'cpu',
          utilization: this.state.cpuMsThisRequest / this.config.maxCpuMs,
        })
        log('WARN', 'budget_cpu_exhausted', { used: this.state.cpuMsThisRequest, limit: this.config.maxCpuMs })
      }
      throw new BudgetExceededError('cpu', this.state.cpuMsThisRequest, this.config.maxCpuMs)
    }
  }

  // ==================== 内存预算 ====================

  /** 检查内存消耗 — 超限时抛出 BudgetExceededError */
  consumeMemoryMb(currentHeapMb: number): void {
    if (currentHeapMb > this.state.memoryPeakMb) {
      this.state.memoryPeakMb = currentHeapMb
    }
    if (currentHeapMb >= this.config.maxMemoryMb) {
      this.state.contextExhausted.add('memory')
      if (!this.state.exhaustedEmitted.has('memory')) {
        this.state.exhaustedEmitted.add('memory')
        eventBus.emit('budget.exhausted', {
          resource: 'memory',
          utilization: currentHeapMb / this.config.maxMemoryMb,
        })
        log('WARN', 'budget_memory_exhausted', { used: currentHeapMb, limit: this.config.maxMemoryMb })
      }
      throw new BudgetExceededError('memory', currentHeapMb, this.config.maxMemoryMb)
    }
  }

  // ==================== 任务级预算 ====================

  allocateTask(taskId: string, llmBudget: number, cpuBudget: number): void {
    this.taskBudgets.set(taskId, { taskId, llmCallsUsed: 0, llmBudget, cpuMsUsed: 0, cpuBudget })
  }

  releaseTask(taskId: string): void {
    this.taskBudgets.delete(taskId)
  }

  consumeTaskLlmCall(taskId: string): string | null {
    const tb = this.taskBudgets.get(taskId)
    if (!tb) return `Task "${taskId}" not found`
    tb.llmCallsUsed++
    if (tb.llmCallsUsed >= tb.llmBudget) {
      return `Task ${taskId}: LLM 配额已超 (${tb.llmCallsUsed}/${tb.llmBudget})`
    }
    return null
  }

  consumeTaskCpuMs(taskId: string, durationMs: number): string | null {
    const tb = this.taskBudgets.get(taskId)
    if (!tb) return `Task "${taskId}" not found`
    tb.cpuMsUsed += durationMs
    if (tb.cpuMsUsed >= tb.cpuBudget) {
      return `Task ${taskId}: CPU 配额已超 (${tb.cpuMsUsed}/${tb.cpuBudget}ms)`
    }
    return null
  }

  // ==================== 进程级预算 ====================

  /** 为子进程分配预算 */
  allocateProcessBudget(processName: string, config: ProcessBudgetConfig): void {
    this.processBudgets.set(processName, {
      config,
      utilization: { memoryMb: 0, cpuMs: 0, restarts: 0 },
    })
  }

  /** 消耗子进程内存（返回是否超限） */
  consumeProcessMemory(processName: string, mb: number): boolean {
    const pb = this.processBudgets.get(processName)
    if (!pb) return true // 未跟踪进程不计入预算

    pb.utilization.memoryMb = Math.max(pb.utilization.memoryMb, mb)
    if (mb >= pb.config.maxMemoryMb) {
      this.emitProcessExhausted(processName, 'memory', mb, pb.config.maxMemoryMb)
      return false
    }
    return true
  }

  /** 记录子进程重启 */
  recordProcessRestart(processName: string): boolean {
    const pb = this.processBudgets.get(processName)
    if (!pb) return true

    pb.utilization.restarts++
    if (pb.utilization.restarts > pb.config.maxRestarts) {
      this.emitProcessExhausted(processName, 'restarts', pb.utilization.restarts, pb.config.maxRestarts)
      return false
    }
    return true
  }

  /** 获取子进程利用率 */
  getProcessUtilization(processName: string): ProcessUtilization | null {
    return this.processBudgets.get(processName)?.utilization ?? null
  }

  /** 释放子进程预算 */
  releaseProcessBudget(processName: string): void {
    this.processBudgets.delete(processName)
  }

  private emitProcessExhausted(processName: string, resource: string, used: number, limit: number): void {
    log('WARN', 'budget_process_exhausted', { process: processName, resource, used, limit })
    eventBus.emit('budget.exhausted', { resource: `process.${processName}.${resource}`, utilization: used / limit })
  }

  // ==================== 稳定性自适应调节 ====================

  /** 根据稳定性评分自动调节预算 */
  autoTune(stabilityScore: number): void {
    if (stabilityScore >= 90) {
      this.config = {
        ...this.originalConfig,
        ...this.config,
        maxChatLlmCalls: Math.min(this.originalConfig.maxChatLlmCalls, this.config.maxChatLlmCalls + 20),
        maxEvolutionLlmCalls: Math.min(this.originalConfig.maxEvolutionLlmCalls, this.config.maxEvolutionLlmCalls + 10),
        maxToolLoopTurns: Math.min(this.originalConfig.maxToolLoopTurns, this.config.maxToolLoopTurns + 20),
      }
    } else if (stabilityScore < 40) {
      const reduce = (current: number, min: number) => Math.max(min, Math.floor(current * 0.5))
      this.config = {
        ...this.config,
        maxChatLlmCalls: reduce(this.config.maxChatLlmCalls, 30),
        maxEvolutionLlmCalls: reduce(this.config.maxEvolutionLlmCalls, 8),
        maxBackgroundLlmCalls: reduce(this.config.maxBackgroundLlmCalls, 2),
        maxResearchLlmCalls: reduce(this.config.maxResearchLlmCalls, 8),
        maxToolLoopTurns: reduce(this.config.maxToolLoopTurns, 8),
        maxCpuMs: reduce(this.config.maxCpuMs, 10000),
        softOverrideTurns: Math.max(3, Math.floor(this.config.softOverrideTurns * 0.5)),
      }
      log('WARN', 'budget_autotune_reduced', { score: stabilityScore })
    } else if (stabilityScore < 70) {
      const reduce = (current: number, min: number) => Math.max(min, Math.floor(current * 0.8))
      this.config = {
        ...this.config,
        maxChatLlmCalls: reduce(this.config.maxChatLlmCalls, 50),
        maxEvolutionLlmCalls: reduce(this.config.maxEvolutionLlmCalls, 15),
        maxBackgroundLlmCalls: reduce(this.config.maxBackgroundLlmCalls, 5),
        maxResearchLlmCalls: reduce(this.config.maxResearchLlmCalls, 15),
        maxToolLoopTurns: reduce(this.config.maxToolLoopTurns, 15),
      }
      log('INFO', 'budget_autotune_degraded', { score: stabilityScore })
    }
  }

  // ==================== 重置 ====================

  resetBackground(): void {
    this.state.backgroundLlmCallsThisCycle = 0
    this.state.contextExhausted.delete('background')
    this.state.exhaustedEmitted.delete('llm.background')
    eventBus.emit('budget.restored', { resource: 'llm.background', utilization: 0 })
  }

  resetEvolution(): void {
    this.state.evolutionLlmCallsThisCycle = 0
    this.state.contextExhausted.delete('evolution')
    this.state.exhaustedEmitted.delete('llm.evolution')
    eventBus.emit('budget.restored', { resource: 'llm.evolution', utilization: 0 })
  }

  /** 重置 toolLoop 轮次计数器（Evolution 自任务启动时调用） */
  resetToolLoopTurns(): void {
    this.state.toolLoopTurnsThisCycle = 0
    this.state.contextExhausted.delete('toolLoop')
    this.state.exhaustedEmitted.delete('toolLoop')
    this.state.exhaustedEmitted.delete('toolLoop.hard')
    this.state.softOverrideEnteredAt = -1
  }

  // ==================== 快照 & 配置 ====================

  getSnapshot(): Record<string, number> {
    return {
      llmCallsThisRequest: this.state.llmCallsThisRequest,
      toolLoopTurns: this.state.toolLoopTurnsThisCycle,
      chatLlmCalls: this.state.chatLlmCallsThisCycle,
      evolutionLlmCalls: this.state.evolutionLlmCallsThisCycle,
      backgroundLlmCalls: this.state.backgroundLlmCallsThisCycle,
      researchLlmCalls: this.state.researchLlmCallsThisCycle,
      cpuMsThisRequest: this.state.cpuMsThisRequest,
      memoryPeakMb: this.state.memoryPeakMb,
      elapsedMs: Date.now() - this.state.requestStartTime,
      exhausted: this.state.contextExhausted.size,
      softOverrideAt: this.state.softOverrideEnteredAt,
      softOverrideLeft: this.getSoftOverrideRemaining(),
    }
  }

  getConfig(): BudgetConfig {
    return { ...this.config }
  }

  updateConfig(patch: Partial<BudgetConfig>): void {
    this.config = { ...this.config, ...patch }
    this.originalConfig = { ...this.config }
    log('INFO', 'budget_config_updated', patch)
  }

  // ==================== 持久化 ====================

  /** 将跨请求计数器（evolution/background）写入磁盘 */
  saveState(): void {
    try {
      const data = {
        evolutionLlmCalls: this.state.evolutionLlmCallsThisCycle,
        backgroundLlmCalls: this.state.backgroundLlmCallsThisCycle,
        savedAt: Date.now(),
      }
      const dir = dirname(this.budgetFilePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.budgetFilePath, JSON.stringify(data, null, 2), 'utf-8')
    } catch {
      log('WARN', 'budget_state_save_failed')
    }
  }

  /** 从磁盘恢复跨请求计数器 */
  loadState(): void {
    try {
      if (!existsSync(this.budgetFilePath)) return
      const data = JSON.parse(readFileSync(this.budgetFilePath, 'utf-8'))
      if (typeof data.evolutionLlmCalls === 'number') {
        this.state.evolutionLlmCallsThisCycle = data.evolutionLlmCalls
      }
      if (typeof data.backgroundLlmCalls === 'number') {
        this.state.backgroundLlmCallsThisCycle = data.backgroundLlmCalls
      }
    } catch {
      log('WARN', 'budget_state_load_failed')
    }
  }
}
