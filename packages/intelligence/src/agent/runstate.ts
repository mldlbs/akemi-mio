import { log } from '@akemi-mio/core/logger/Logger'
import type { Evidence } from '@akemi-mio/evolution-goals'
import type { ChatErrorCode } from '../llm/types'

export interface GovernorRecord {
  step: number
  action: 'continue' | 'stop' | 'shift'
  reason: string
  failedTools: string[]
  roundResult: 'all_ok' | 'partial' | 'all_failed'
}

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
  /** Guardrail 请求终止：放行最后一轮 LLM 回复后退出 */
  guardrailStop = false
  /**
   * 终止本轮的 LLM 错误码（`TIMEOUT` / `NETWORK` / `RATE_LIMITED` …），空串 = 没有终止性错误。
   *
   * 由 `handleLlmError` 在返回 `'return'`（不再重试）时写入。`toolLoop` 只会给上层一个
   * 空字符串，若不记下来，`run()` 就无法区分「模型返回了空内容」和「模型超时三次后放弃」，
   * 只能一律报 `NO_REPLY` —— 用户会看到「模型没有返回内容」，而真实原因是超时/限流。
   *
   * 类型是 `ChatErrorCode` 而不是 `string`：这个值会**原样**变成 `ChatResult.error`
   * 跨 IPC 给 renderer 展示，必须落在已知错误码集合内（见 `llm/types.ts` 的说明）。
   */
  terminalLlmError: ChatErrorCode | '' = ''
  softReplyInjected = false
  /** 前几轮已经口头汇报过的内容摘要 */
  spokenReplies: string[] = []
  /** ExecutionGovernor 决策历史 */
  governorHistory: GovernorRecord[] = []
  /** M6.1 当前执行目标 id（由 ChatExecutor 绑定） */
  activeGoalId: string | null = null
  /** M6.1 本轮已收集的执行证据（内存镜像，持久化由 ExecutionGoalStore 负责） */
  evidence: Evidence[] = []

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
    this.governorHistory = []
    this.activeGoalId = null
    this.evidence = []
  }

  /** 记录 ExecutionGovernor 决策 */
  recordGovernor(
    decision: { action: GovernorRecord['action']; reason: string },
    failedTools: string[],
    roundResult: GovernorRecord['roundResult'],
  ): void {
    this.governorHistory.push({
      step: this.step,
      action: decision.action,
      reason: decision.reason,
      failedTools,
      roundResult,
    })
  }

  get running(): boolean {
    return this.state === RunState.RUNNING || this.state === RunState.WAIT_TOOL
  }
}
