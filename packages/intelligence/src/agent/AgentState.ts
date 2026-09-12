/**
 * AgentState — 通用 Agent 三维状态向量
 *
 * mode × stage × lifecycle 互不冲突，覆盖 Chat/Task/Evolution/Background 四种运行模式。
 * ChatExecutor/TaskExecutor 各自持有独立实例。
 *
 * 向后兼容：RunContext（runstate.ts）依然可用，逐步迁移。新代码优先使用 AgentState。
 */

// ─── 模式 ───

export const AGENT_MODES = ['chat', 'task', 'evolution', 'background'] as const
export type AgentMode = (typeof AGENT_MODES)[number]

// ─── 认知阶段（OTPAR 扩展） ───

export const COGNITIVE_STAGES = ['idle', 'observe', 'think', 'plan', 'act', 'reflect', 'sleep'] as const
export type CognitiveStage = (typeof COGNITIVE_STAGES)[number]

// ─── 生命周期 ───

export const LIFECYCLE_STATES = ['ready', 'running', 'interrupted', 'completed', 'failed'] as const
export type LifecycleState = (typeof LIFECYCLE_STATES)[number]

// ─── 子结构 ───

export interface AgentMeta {
  requestId: string
  step: number
  startedAt: number
  tokensUsed: number
  toolCount: number
}

export interface GuardCounters {
  consecutiveErrors: number
  consecutiveTimeouts: number
  forcedContinueCount: number
}

export interface AgentStateSnapshot {
  mode: AgentMode
  stage: CognitiveStage
  lifecycle: LifecycleState
  meta: Readonly<AgentMeta>
  guard: Readonly<GuardCounters>
}

// ─── 转化矩阵 ───

const STAGE_TRANSITIONS: Record<CognitiveStage, CognitiveStage[]> = {
  idle: ['observe', 'think', 'sleep'],
  observe: ['think', 'idle'],
  think: ['plan', 'act', 'idle', 'observe'],
  plan: ['act', 'idle', 'think'],
  act: ['reflect', 'observe', 'idle'],
  reflect: ['idle', 'sleep', 'observe'],
  sleep: ['idle'],
}

const LIFECYCLE_TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  ready: ['running', 'completed', 'failed'],
  running: ['interrupted', 'completed', 'failed'],
  interrupted: ['running', 'completed', 'failed'],
  completed: ['ready'],
  failed: ['ready'],
}

// ─── AgentState ───

export class AgentState {
  mode: AgentMode
  stage: CognitiveStage = 'idle'
  lifecycle: LifecycleState = 'ready'
  meta: AgentMeta
  guard: GuardCounters = { consecutiveErrors: 0, consecutiveTimeouts: 0, forcedContinueCount: 0 }
  previousStage: CognitiveStage | null = null

  constructor(mode: AgentMode, requestId: string) {
    this.mode = mode
    this.meta = {
      requestId,
      step: 0,
      startedAt: Date.now(),
      tokensUsed: 0,
      toolCount: 0,
    }
  }

  /** 转换认知阶段 */
  transitionStage(to: CognitiveStage): boolean {
    const allowed = STAGE_TRANSITIONS[this.stage]
    if (!allowed?.includes(to)) {
      return false
    }
    this.previousStage = this.stage
    this.stage = to
    return true
  }

  /** 转换生命周期 */
  transitionLifecycle(to: LifecycleState): boolean {
    const allowed = LIFECYCLE_TRANSITIONS[this.lifecycle]
    if (!allowed?.includes(to)) {
      return false
    }
    this.lifecycle = to
    return true
  }

  /** 重置为初始状态（复用实例） */
  reset(requestId?: string): void {
    this.stage = 'idle'
    this.lifecycle = 'ready'
    this.previousStage = null
    this.meta.step = 0
    this.meta.tokensUsed = 0
    this.meta.toolCount = 0
    this.guard.consecutiveErrors = 0
    this.guard.consecutiveTimeouts = 0
    this.guard.forcedContinueCount = 0
    if (requestId) {
      this.meta.requestId = requestId
      this.meta.startedAt = Date.now()
    }
  }

  /** 步骤递增 */
  incrementStep(): void {
    this.meta.step++
  }

  /** 记录 token 使用 */
  recordTokens(count: number): void {
    this.meta.tokensUsed += count
  }

  /** 记录工具调用 */
  recordToolCall(): void {
    this.meta.toolCount++
  }

  /** 是否正在运行 */
  get isRunning(): boolean {
    return this.lifecycle === 'running'
  }

  /** 是否可被中断恢复 */
  get isInterrupted(): boolean {
    return this.lifecycle === 'interrupted'
  }

  /** 快照 */
  snapshot(): AgentStateSnapshot {
    return {
      mode: this.mode,
      stage: this.stage,
      lifecycle: this.lifecycle,
      meta: { ...this.meta },
      guard: { ...this.guard },
    }
  }
}
