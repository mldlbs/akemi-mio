import { log } from '../logger/Logger'

/**
 * Agent 运行状态枚举
 * 替代旧的二值 inToolLoop boolean，支持打断、审批、错误等完整生命周期
 */
export enum RunState {
  READY = 'ready',
  RUNNING = 'running',
  WAIT_TOOL = 'wait_tool',
  INTERRUPTED = 'interrupted',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

/**
 * 状态可转换矩阵
 */
const TRANSITIONS: Record<RunState, RunState[]> = {
  [RunState.READY]: [RunState.RUNNING, RunState.CANCELLED],
  [RunState.RUNNING]: [RunState.WAIT_TOOL, RunState.INTERRUPTED, RunState.COMPLETED, RunState.FAILED, RunState.CANCELLED],
  [RunState.WAIT_TOOL]: [RunState.RUNNING, RunState.INTERRUPTED, RunState.CANCELLED, RunState.FAILED],
  [RunState.INTERRUPTED]: [RunState.RUNNING, RunState.CANCELLED],
  [RunState.COMPLETED]: [RunState.READY],
  [RunState.FAILED]: [RunState.READY],
  [RunState.CANCELLED]: [RunState.READY],
}

/**
 * Agent 运行上下文 — 保存整个工具循环的运行时状态
 */
export class RunContext {
  readonly runId: string
  state: RunState = RunState.READY
  /** toolLoop 当前轮次 */
  step = 0
  /** 中断标志 — 新用户输入或用户取消时设置 */
  interruptFlag = false
  /** 中断来源描述（如"用户新输入"） */
  interruptReason = ''
  /** 中止信号 — 用于取消正在进行的 LLM 调用或工具执行 */
  abortController = new AbortController()
  /** LLM 回复累积文本 */
  reply = ''
  /** 当前轮次的工具调用信息 */
  toolCalls: Array<{ name: string; args: Record<string, unknown> }> = []
  /** 起始时间戳 */
  startedAt = 0

  // ── Guardrail 计数器（原 AgentService 散落字段） ──
  consecutiveToolErrors = 0
  consecutiveTimeouts = 0
  consecutiveReadOnlyRounds = 0
  consecutiveReadOnlyErrors = 0
  /** 连续只读卡死累计次数（跨 toolLoop 不重置） */
  readonlyStuckCount = 0
  /** 当前 toolLoop 中强制续行 plan 的次数，超过上限则跳出避免死循环 */
  forceContinueCount = 0
  /** 上一次 force_continue 时 pending steps 的描述，用于检测停滞 */
  lastForceContinuePendingDesc = ''
  /** 连续 N 次 force_continue 而未取得进展 */
  forceContinueStagnation = 0
  /** 抑制强制续行（tryRun 分析模式用） */
  suppressForceContinue = false
  softReplyInjected = false
  /** 前几轮已经口头汇报过的内容摘要 */
  spokenReplies: string[] = []

  constructor(runId: string) {
    this.runId = runId
  }

  /** 安全状态转移 */
  transition(to: RunState): boolean {
    const allowed = TRANSITIONS[this.state]
    if (!allowed?.includes(to)) {
      log('WARN', 'run_state_invalid_transition', { from: this.state, to, runId: this.runId })
      return false
    }
    this.state = to
    return true
  }

  /** 标记中断（用户打断/新输入） */
  interrupt(reason: string): void {
    this.interruptFlag = true
    this.interruptReason = reason
    this.abortController.abort()
    this.transition(RunState.INTERRUPTED)
  }

  /** 重置为 READY，准备新一次运行 */
  reset(): void {
    this.state = RunState.READY
    this.step = 0
    this.interruptFlag = false
    this.interruptReason = ''
    this.abortController = new AbortController()
    this.reply = ''
    this.toolCalls = []
    this.consecutiveToolErrors = 0
    this.consecutiveTimeouts = 0
    this.consecutiveReadOnlyRounds = 0
    this.consecutiveReadOnlyErrors = 0
    this.readonlyStuckCount = 0
    this.forceContinueCount = 0
    this.lastForceContinuePendingDesc = ''
    this.forceContinueStagnation = 0
  }

  get running(): boolean {
    return this.state === RunState.RUNNING || this.state === RunState.WAIT_TOOL
  }
}
