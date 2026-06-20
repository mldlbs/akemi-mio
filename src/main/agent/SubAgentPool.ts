import { LlmService, ToolCallInfo } from '../llm/LlmService'
import { ServerManager } from '../mcp/ServerManager'
import { ConversationContext, Message } from './context'
import { EventBus, eventBus } from '../core/EventBus'
import { log, createRequestId } from '../logger/Logger'

// ── 类型定义 ──

export type SubAgentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted'

export interface SubAgentResult {
  id: string
  goal: string
  status: SubAgentStatus
  summary: string
  error?: string
  startedAt: number
  completedAt?: number
}

interface SubAgentTask {
  id: string
  goal: string
  toolsets?: string[]
  model?: string
}

// ── 单个子 Agent 实例 ──

class SubAgentInstance {
  readonly id: string
  readonly goal: string
  status: SubAgentStatus = 'pending'
  summary = ''
  error?: string
  readonly startedAt = Date.now()
  completedAt?: number

  private llm: LlmService
  private context: ConversationContext
  private abortController = new AbortController()
  private mcpManager: ServerManager

  constructor(
    task: SubAgentTask,
    mcpManager: ServerManager,
    chatKey: string,
    codeKey: string,
  ) {
    this.id = task.id
    this.goal = task.goal
    this.mcpManager = mcpManager
    this.llm = new LlmService(mcpManager)
    this.llm.setConfig(chatKey, codeKey)
    this.context = new ConversationContext()
  }

  async run(agentGoal?: string): Promise<void> {
    this.status = 'running'
    log('INFO', 'subagent_started', { id: this.id, goal: this.goal })

    try {
      // 注入目标作为第一条用户消息
      let prompt = this.goal
      if (agentGoal) {
        prompt = `【上级任务】${agentGoal}\n\n【分配给你的任务】${this.goal}`
      }
      this.context.addUser(prompt)

      const reply = await this.toolLoop()
      this.summary = reply || '(无回复)'
      this.status = 'completed'
      log('INFO', 'subagent_completed', { id: this.id, summary_len: this.summary.length })
    } catch (err: any) {
      if (err.name === 'AbortError') {
        this.status = 'interrupted'
        this.summary = '任务已被取消'
        log('INFO', 'subagent_interrupted', { id: this.id })
      } else {
        this.status = 'failed'
        this.error = err.message
        this.summary = `任务失败: ${err.message}`
        log('WARN', 'subagent_failed', { id: this.id, error: err.message })
      }
    }
    this.completedAt = Date.now()
  }

  interrupt(): void {
    this.abortController.abort('manual')
  }

  private async toolLoop(): Promise<string> {
    const messages = this.context.getMessages()
    const maxTurns = 15

    for (let i = 0; i < maxTurns; i++) {
      if (this.abortController.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }

      const result = await this.llm.chatWithTools(
        messages,
        `sub_${this.id}_${i}`,
        30000,
      )

      if (result.error === 'TIMEOUT') {
        log('WARN', 'subagent_timeout', { id: this.id, step: i })
        continue
      }
      if (result.error) {
        return `错误: ${result.error}`
      }

      if (result.toolCalls && result.toolCalls.length > 0) {
        await this.processToolCalls(result.toolCalls, messages)
        continue
      }

      // 纯文本回复 → 完成
      return result.reply || ''
    }

    return '操作次数过多，已自动停止'
  }

  private async processToolCalls(
    toolCalls: ToolCallInfo[],
    messages: Message[],
  ): Promise<void> {
    for (const call of toolCalls) {
      if (this.abortController.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }

      try {
        const output = await this.mcpManager.callTool(call.name, call.arguments)
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: typeof output === 'string' ? output : JSON.stringify(output),
        })
      } catch (err: any) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `Error: ${err.message}`,
        })
      }
    }
  }
}

// ── 子 Agent 池 ──

const SUBAGENT_TIMEOUT_MS = 5 * 60 * 1000  // 5 分钟
const WATCHDOG_INTERVAL_MS = 30_000         // 每 30 秒检查一次

export class SubAgentPool {
  private agents = new Map<string, SubAgentInstance>()
  /** 已完成但尚未被主 agent 消费的结果 */
  private completedQueue: SubAgentResult[] = []
  private mcpManager: ServerManager
  private eventBus: EventBus
  private counter = 0
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private chatKey: string
  private codeKey: string

  constructor(mcpManager: ServerManager, bus?: EventBus, chatKey?: string, codeKey?: string) {
    this.mcpManager = mcpManager
    this.eventBus = bus || eventBus
    this.chatKey = chatKey || ''
    this.codeKey = codeKey || ''
  }

  /** 派发一个子任务，立即返回 id */
  spawn(goal: string, parentGoal?: string): string {
    const id = `sub_${++this.counter}_${Date.now().toString(36)}`
    const task: SubAgentTask = { id, goal }
    const instance = new SubAgentInstance(task, this.mcpManager, this.chatKey, this.codeKey)
    this.agents.set(id, instance)

    // 确保 watchdog 在首次 spawn 时启动
    this.ensureWatchdog()

    // 异步后台执行
    instance.run(parentGoal).then(() => this.onAgentDone(instance))

    log('INFO', 'subagent_spawned', { id, goal: goal.slice(0, 60) })
    return id
  }

  /** 派发多个并行任务 */
  spawnBatch(
    tasks: { goal: string }[],
    parentGoal?: string,
  ): string[] {
    return tasks.map(t => this.spawn(t.goal, parentGoal))
  }

  /** 打断一个子任务 */
  interrupt(id: string): boolean {
    const inst = this.agents.get(id)
    if (!inst) return false
    inst.interrupt()
    return true
  }

  /** 打断全部运行中的子任务 */
  interruptAll(): number {
    let count = 0
    for (const [id, inst] of this.agents) {
      if (inst.status === 'running') {
        inst.interrupt()
        count++
      }
    }
    return count
  }

  /** 收集所有已完成但尚未被消费的结果 */
  collectCompleted(): SubAgentResult[] {
    const results = [...this.completedQueue]
    this.completedQueue = []
    return results
  }

  /** 当前运行中的任务列表 */
  listRunning(): { id: string; goal: string; elapsed: number }[] {
    return Array.from(this.agents.values())
      .filter(a => a.status === 'running')
      .map(a => ({
        id: a.id,
        goal: a.goal.slice(0, 60),
        elapsed: Date.now() - a.startedAt,
      }))
  }

  private onAgentDone(instance: SubAgentInstance): void {
    this.agents.delete(instance.id)
    this.completedQueue.push({
      id: instance.id,
      goal: instance.goal,
      status: instance.status,
      summary: instance.summary,
      error: instance.error,
      startedAt: instance.startedAt,
      completedAt: instance.completedAt,
    })
    this.eventBus.emit('subagent.completed' as any, {
      id: instance.id,
      goal: instance.goal,
      status: instance.status,
    })
  }

  private ensureWatchdog(): void {
    if (this.watchdogTimer) return
    this.watchdogTimer = setInterval(() => {
      const now = Date.now()
      for (const [id, inst] of this.agents) {
        if (inst.status === 'running' && now - inst.startedAt > SUBAGENT_TIMEOUT_MS) {
          log('WARN', 'subagent_timeout_kill', { id, elapsed: now - inst.startedAt })
          inst.interrupt()
          this.onAgentDone(inst)
        }
      }
    }, WATCHDOG_INTERVAL_MS)
    this.watchdogTimer.unref?.()
  }

  /** 销毁池子（清理定时器） */
  dispose(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
    this.interruptAll()
    this.agents.clear()
    this.completedQueue = []
  }
}
