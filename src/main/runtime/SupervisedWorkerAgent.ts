import { LlmService, type ToolCallInfo } from '../llm/LlmService'
import type { ServerManager } from '../mcp/ServerManager'
import { ConversationContext, type Message } from '../agent/context'
import { EventBus, eventBus } from '../core/EventBus'
import { log } from '../logger/Logger'
import type { SubAgentResult } from '../agent/SubAgentPool'
import { RuntimeState, transitionState } from './RuntimeState'
import { RUNTIME_EVENT, type RuntimeEvent, type RuntimeCommand } from './RuntimeMessage'
import { SafePoint, type WorkerId } from './WorkerContract'
import { SimpleMailbox } from './SimpleMailbox'

/**
 * SupervisedWorkerAgent — 受 Runtime 监督的 Worker 实现。
 *
 * 对比 SubAgentInstance 的核心差异：
 *   - RuntimeState（非 SubAgentStatus）
 *   - Mailbox（内部实现，不暴露）
 *   - RuntimeEvent emission（通过 EventBus）
 *   - reachSafePoint() 在 BeforeLLM / AfterLLM / AfterTool 检查 Mailbox
 *   - pause 支持（TaskExecutor 模式）
 *   - NeedDecision 流程
 *
 * 不感知 Supervisor。所有通信走 RuntimeMessage。
 */
export class SupervisedWorkerAgent {
  readonly id: WorkerId
  readonly goal: string
  state: RuntimeState = RuntimeState.READY
  readonly startedAt = Date.now()
  completedAt?: number

  private _step = 0
  private summary = ''
  private error?: string

  private llm: LlmService
  private context: ConversationContext
  private mailbox = new SimpleMailbox()
  private abortController = new AbortController()
  private mcpManager: ServerManager
  private eventBus: EventBus
  private maxTurns: number
  private llmTimeoutMs: number
  private allowedToolNames?: string[]
  private _pauseRequested = false
  private onProgress?: (msg: string) => void

  constructor(
    id: string,
    goal: string,
    mcpManager: ServerManager,
    chatKey: string,
    codeKey: string,
    options?: {
      systemPrompt?: string
      maxTurns?: number
      llmTimeoutMs?: number
      allowedToolNames?: string[]
      onProgress?: (msg: string) => void
      /** 注入 mock LlmService（用于 ReplayRunner 不依赖真实 LLM） */
      llmOverride?: LlmService
    },
  ) {
    this.id = id
    this.goal = goal
    this.mcpManager = mcpManager
    this.eventBus = eventBus
    this.maxTurns = options?.maxTurns ?? 15
    this.llmTimeoutMs = options?.llmTimeoutMs ?? 120_000
    this.allowedToolNames = options?.allowedToolNames
    this.onProgress = options?.onProgress
    this.llm = options?.llmOverride ?? new LlmService(mcpManager)
    this.llm.setConfig(chatKey, codeKey)
    this.context = new ConversationContext(undefined, undefined, undefined, options?.systemPrompt)
  }

  async run(agentGoal?: string): Promise<SubAgentResult> {
    this.setState(RuntimeState.RUNNING, 'started')
    this._pauseRequested = false
    log('INFO', 'supervised_worker_started', { id: this.id, goal: this.goal })

    try {
      let prompt = this.goal
      if (agentGoal) {
        prompt = `【上级任务】${agentGoal}\n\n【分配给你的任务】${this.goal}`
      }
      this.context.addUser(prompt)
      const reply = await this.toolLoop()
      this.summary = reply || '(无回复)'
      this.setState(RuntimeState.COMPLETED, 'finished')
      log('INFO', 'supervised_worker_completed', { id: this.id, summary_len: this.summary.length })
    } catch (err: any) {
      if (err.name === 'AbortError') {
        this.setState(RuntimeState.INTERRUPTED, 'cancelled')
        this.summary = '任务已被取消'
      } else {
        this.setState(RuntimeState.FAILED, err.message)
        this.error = err.message
        this.summary = `任务失败: ${err.message}`
      }
    }
    this.completedAt = Date.now()

    return {
      id: this.id,
      goal: this.goal,
      status: this.mapStateToStatus(),
      summary: this.summary,
      error: this.error,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
    }
  }

  /** Supervisor 下达命令（通过 Mailbox 中转，不暴露 Mailbox 引用） */
  send(command: RuntimeCommand): void {
    this.mailbox.push(command)
  }

  /** 硬取消 */
  cancel(): void {
    this.abortController.abort('manual')
  }

  /** 暂停请求（cooperative，下个 SafePoint 生效） */
  pause(reason: string): void {
    this._pauseRequested = true
    this.mailbox.push({ action: 'pause', reason, direction: 'command' })
  }

  get step(): number {
    return this._step
  }

  get pauseRequested(): boolean {
    return this._pauseRequested
  }

  // ── 工具循环 ──

  private async toolLoop(): Promise<string> {
    const messages = this.context.getMessages()

    for (let i = 0; i < this.maxTurns; i++) {
      this._step = i
      this.emitProgress(`第 ${i + 1}/${this.maxTurns} 轮`)

      if (this.abortController.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }

      // SafePoint: BeforeLLM
      if (this.reachSafePoint(SafePoint.BeforeLLM)) {
        if (this.state === RuntimeState.PAUSED) return '(paused)'
        if (this.state === RuntimeState.CANCELLED || this.state === RuntimeState.INTERRUPTED) return '(cancelled)'
      }

      this.onProgress?.(`🤔 LLM 思考中… (第 ${i + 1}/${this.maxTurns} 轮)`)

      const result = await this.llm.chatWithTools(
        messages,
        `sup_${this.id}_${i}`,
        this.llmTimeoutMs,
        undefined,
        this.abortController.signal,
        this.allowedToolNames,
      )

      if (result.error === 'TIMEOUT') {
        log('WARN', 'supervised_worker_timeout', { id: this.id, step: i })
        continue
      }
      if (result.error) {
        return `错误: ${result.error}`
      }

      // SafePoint: AfterLLM
      if (this.reachSafePoint(SafePoint.AfterLLM)) {
        if (this.state === RuntimeState.PAUSED) return '(paused)'
        if (this.state === RuntimeState.CANCELLED || this.state === RuntimeState.INTERRUPTED) return '(cancelled)'
      }

      if (result.toolCalls && result.toolCalls.length > 0) {
        await this.processToolCalls(result.toolCalls, messages)

        // SafePoint: AfterTool
        if (this.reachSafePoint(SafePoint.AfterTool)) {
          if (this.state === RuntimeState.PAUSED) return '(paused)'
          if (this.state === RuntimeState.CANCELLED || this.state === RuntimeState.INTERRUPTED) return '(cancelled)'
        }
        continue
      }

      return result.reply || ''
    }

    return '操作次数过多，已自动停止'
  }

  // ── SafePoint：检查 Mailbox ──

  /**
   * 在 SafePoint 同步检查 Mailbox。
   * 返回 true 表示需要退出循环（pause/cancel）。
   */
  reachSafePoint(_point: SafePoint): boolean {
    if (!this.mailbox.hasPending() && !this._pauseRequested) return false

    const commands = this.mailbox.drain()
    for (const cmd of commands) {
      switch (cmd.action) {
        case 'cancel':
          this.setState(RuntimeState.CANCELLED, cmd.reason)
          this.abortController.abort('supervisor_cancel')
          return true
        case 'pause':
          this._pauseRequested = true
          this.setState(RuntimeState.PAUSED, cmd.reason)
          return true
        case 'resume':
          this._pauseRequested = false
          break
        case 'continue':
          if (cmd.guidance) {
            this.context.addUser(`[Supervisor] ${cmd.guidance}`)
          }
          if (cmd.message) {
            this.context.addSystemMessage(cmd.message)
          }
          break
        case 'redirect':
          if (cmd.reason) {
            this.context.addUser(`[Supervisor] 任务重定向: ${cmd.reason}\n新目标: ${cmd.newGoal}`)
          }
          break
      }
    }
    return false
  }

  // ── 工具调用 ──

  private async processToolCalls(toolCalls: ToolCallInfo[], messages: Message[]): Promise<void> {
    for (const call of toolCalls) {
      if (this.abortController.signal.aborted) throw new DOMException('Aborted', 'AbortError')

      this.emitToolEvent('invoked', call.name, call.arguments)

      try {
        const output = await this.mcpManager.callTool(call.name, call.arguments)
        const formatted = typeof output === 'string' ? output : JSON.stringify(output)
        this.emitToolEvent('completed', call.name, { result: formatted.slice(0, 200) })
        this.onProgress?.(`🔧 ${call.name} → ${formatted.slice(0, 120)}`)
        messages.push({ role: 'tool', tool_call_id: call.id, content: formatted })
      } catch (err: any) {
        this.emitToolEvent('failed', call.name, { error: err.message })
        this.onProgress?.(`🔧 ${call.name} → ❌ ${err.message}`)
        messages.push({ role: 'tool', tool_call_id: call.id, content: `Error: ${err.message}` })
      }
    }
  }

  // ── RuntimeEvent 发射 ──

  private emitRuntimeEvent(event: RuntimeEvent): void {
    this.eventBus.emit(RUNTIME_EVENT as any, event)
  }

  private emitProgress(description: string): void {
    this.emitRuntimeEvent({
      type: 'agent.progress',
      direction: 'event',
      workerId: this.id,
      step: this._step,
      description,
      state: this.state,
      timestamp: Date.now(),
    })
  }

  private emitToolEvent(subType: 'invoked' | 'completed' | 'failed', toolName: string, meta: Record<string, any>): void {
    this.emitRuntimeEvent({
      type: 'agent.tool',
      direction: 'event',
      workerId: this.id,
      subType,
      toolName,
      argsPreview: JSON.stringify(meta).slice(0, 120),
      result: subType === 'completed' ? meta.result : undefined,
      error: subType === 'failed' ? meta.error : undefined,
      timestamp: Date.now(),
    })
  }

  private setState(to: RuntimeState, reason: string): void {
    const from = this.state
    if (!transitionState(from, to)) {
      log('WARN', 'supervised_worker_invalid_transition', { from, to, id: this.id })
      this.emitRuntimeEvent({
        type: 'agent.illegal_transition',
        direction: 'event',
        workerId: this.id,
        taskId: '',
        from,
        to,
        reason,
        timestamp: Date.now(),
      } as any)
      return
    }
    this.state = to
    this.emitRuntimeEvent({
      type: 'agent.state_changed',
      direction: 'event',
      workerId: this.id,
      from,
      to,
      reason,
      timestamp: Date.now(),
    })
  }

  private mapStateToStatus(): SubAgentResult['status'] {
    switch (this.state) {
      case RuntimeState.COMPLETED: return 'completed'
      case RuntimeState.FAILED: return 'failed'
      case RuntimeState.INTERRUPTED:
      case RuntimeState.CANCELLED: return 'interrupted'
      // paused / running / waiting → still running
      default: return 'running'
    }
  }
}
