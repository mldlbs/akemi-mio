import type { AgentRuntimeState } from './AgentRuntimeState'
import type { SupervisorDecision } from './types'
import type { ConversationContext } from '../context'
import type { SubAgentResult } from '../SubAgentPool'

// ── Worker 身份 ──

export type WorkerId = string

// ── Mailbox：Supervisor → Worker 单向通道 ──

/**
 * Mailbox 是 Supervisor 向 Worker 发送指令的独占入站通道。
 *
 * 与 ConversationContext 分开——Mailbox 携带的是元指令（pause/cancel/guidance），
 * 而不是 LLM 对话历史。Worker 在 safe point 同步检查 mailbox。
 */
export interface Mailbox {
  /** Supervisor 放入决策 */
  push(decision: SupervisorDecision): void

  /** Worker drain 所有待处理消息（FIFO），空数组 = 无消息 */
  drain(): SupervisorDecision[]

  /** 非阻塞检查是否有待处理消息 */
  hasPending(): boolean

  /** 未读消息数 */
  readonly size: number

  /** 清空所有消息（如 Worker cancel 时） */
  clear(): void
}

// ── SimpleMailbox 实现 ──

export class SimpleMailbox implements Mailbox {
  private queue: SupervisorDecision[] = []

  push(decision: SupervisorDecision): void {
    this.queue.push(decision)
  }

  drain(): SupervisorDecision[] {
    const batch = this.queue.splice(0)
    return batch
  }

  hasPending(): boolean {
    return this.queue.length > 0
  }

  get size(): number {
    return this.queue.length
  }

  clear(): void {
    this.queue = []
  }
}

// ── WorkerHandle：Supervisor 视角的 Worker ──

export interface WorkerHandle {
  readonly id: WorkerId
  readonly goal: string
  readonly state: AgentRuntimeState
  readonly mailbox: Mailbox
  readonly step: number

  /** 开始执行 */
  start(): Promise<void>

  /** 请求暂停（设置标志，Worker 在下一个 safe point 暂停） */
  pause(reason: string): void

  /** 恢复 */
  resume(): void

  /** 硬取消（通过 AbortController） */
  cancel(): void

  /** 获取结果（仅在 completed/failed 时非 null） */
  getResult(): SubAgentResult | null
}

// ── SupervisedWorker 接口 ──

export interface SupervisedWorker {
  readonly id: WorkerId
  readonly goal: string
  readonly mailbox: Mailbox
  readonly state: AgentRuntimeState
  readonly context: ConversationContext
  readonly step: number

  /**
   * 运行工具循环（带 Mailbox checking at safe points）。
   * 返回 { status, summary, error } 等结构化结果。
   */
  run(): Promise<SubAgentResult>

  /** 暂停是否被请求 */
  pauseRequested(): boolean
}

// ── Safe Point 定义 ──

/**
 * Safe Point 是 Worker 工具循环中检查 Mailbox 的位置。
 * 检查是同步的——没有待处理消息时不引入任何延迟。
 *
 * 三个 Safe Point 按执行顺序排列：
 *
 * 1. AFTER_LLM_RESPONSE — LLM 返回后、处理 tool calls 前
 * 2. AFTER_TOOL_RESULT — toolScheduler.executeAll() 完成后、下一次 LLM 调用前
 * 3. BEFORE_LLM_CALL — 调用 chatWithTools 前
 *
 * 在每个 Safe Point：
 *   cancel    → abort + exit
 *   pause     → snapshot state + 返回 PAUSED
 *   continue  → 如果包含 guidance，注入到 ConversationContext
 *   redirect  → 更新 goal + 注入重定向消息
 *   resume    → 清除暂停标志（运行时不应出现，但安全处理）
 *
 * NeedDecision 流程：
 *   Worker 自行 emit `agent.need_decision` → 状态转为 WAITING_SUPERVISOR
 *   Supervisor 收到后调用 decide() + resumeWorker() → Worker 在下次进入循环时
 *   读到 Mailbox 中的决策。
 */
export type SafePoint = 'after_llm_response' | 'after_tool_result' | 'before_llm_call'
