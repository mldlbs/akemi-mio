/**
 * WorkerContract — Worker 身份的契约定义。
 *
 * 核心原则：Worker 永远不知道谁消费 RuntimeEvent。
 *
 * Worker 只关心：
 *   1. emit RuntimeEvent（通过 EventBus）
 *   2. 在 SafePoint 检查 Mailbox（收到的是 RuntimeCommand，但 Worker 不关心是谁发的）
 *
 * Worker 不关心也不应该知道：
 *   - Supervisor
 *   - Scheduler（未来）
 *   - Logger / Replay / UI / Metrics
 *
 * 所有消费者通过 EventBus 监听 'runtime.agent.event' 即可解耦。
 */

import type { RuntimeState } from './RuntimeState'
import type { RuntimeCommand } from './RuntimeMessage'
import type { ConversationContext } from '@akemi-mio/intelligence/agent/context'
import type { SubAgentResult } from '@akemi-mio/intelligence/agent/SubAgentPool'

export type WorkerId = string

// ── Safe Point 抽象 ──

/**
 * SafePoint 枚举 Worker 工具循环中可安全检查 Mailbox 的位置。
 *
 * Worker 调用 reachSafePoint()，Supervisor 不依赖具体 Safe Point 数量。
 * 新 Safe Point 只需在此枚举加一项，不需要改接口。
 */
export enum SafePoint {
  BeforeLLM = 'before_llm',
  AfterLLM = 'after_llm',
  AfterTool = 'after_tool',
}

// ── Mailbox 接口 ──

export interface Mailbox {
  push(command: RuntimeCommand): void
  drain(): RuntimeCommand[]
  hasPending(): boolean
  readonly size: number
  clear(): void
}

// ── WorkerHandle（Supervisor 视角） ──

export interface WorkerHandle {
  readonly id: WorkerId
  readonly goal: string
  readonly state: RuntimeState
  readonly step: number

  /** 开始执行 */
  start(): Promise<void>

  /** 发送命令（Supervisor → Worker） */
  send(command: RuntimeCommand): void

  /** 硬取消 */
  cancel(): void

  /** 获取结果（仅在 completed/failed 时非 null） */
  getResult(): SubAgentResult | null
}

// ── SupervisedWorker（Worker 内部视图） ──

export interface SupervisedWorker {
  readonly id: WorkerId
  readonly goal: string
  readonly state: RuntimeState
  readonly context: ConversationContext
  readonly step: number

  run(): Promise<SubAgentResult>

  /**
   * 在 Safe Point 调用。
   * drain 所有待处理的 RuntimeCommand 并执行对应动作。
   * 如果命令要求暂停或取消，返回 true 表示"需要退出循环"。
   */
  reachSafePoint(point: SafePoint): boolean

  pauseRequested(): boolean
}
