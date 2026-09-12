/**
 * ExecutionRuntime — 统一任务执行运行时类型定义
 *
 * 所有任务（Chat / Evolution / Research / Background）穿过此层。
 * LLM 降级为「文本生成器」，Runtime 持有所有决策权：
 *   - 目标对齐 (Goal Check)
 *   - 资源预算 (Budget Check)
 *   - 能力边界 (Capability Check)
 *   - 权限验证 (Permission Check)
 *   - 模型选择 (Model Routing)
 *   - 工具规划 (Tool Planning)
 *   - 执行调度 (Execution)
 *   - 反馈收集 (Feedback)
 */

import type { ToolCallInfo } from '@akemi-mio/intelligence/llm/LlmService'

// ==============================
// Runtime 状态机阶段
// ==============================

export enum RuntimePhase {
  IDLE = 'idle',
  RECEIVE = 'receive',
  UNDERSTAND = 'understand',
  PLAN = 'plan',
  ALLOCATE = 'allocate',
  EXECUTE = 'execute',
  OBSERVE = 'observe',
  REFLECT = 'reflect',
  LEARN = 'learn',
}

/** 合法状态转移矩阵 */
export const PHASE_TRANSITIONS: Record<RuntimePhase, RuntimePhase[]> = {
  [RuntimePhase.IDLE]: [RuntimePhase.RECEIVE],
  [RuntimePhase.RECEIVE]: [RuntimePhase.UNDERSTAND, RuntimePhase.IDLE],
  [RuntimePhase.UNDERSTAND]: [RuntimePhase.PLAN, RuntimePhase.IDLE],
  [RuntimePhase.PLAN]: [RuntimePhase.ALLOCATE, RuntimePhase.EXECUTE, RuntimePhase.IDLE],
  [RuntimePhase.ALLOCATE]: [RuntimePhase.EXECUTE, RuntimePhase.IDLE],
  [RuntimePhase.EXECUTE]: [RuntimePhase.OBSERVE, RuntimePhase.IDLE],
  [RuntimePhase.OBSERVE]: [RuntimePhase.REFLECT, RuntimePhase.EXECUTE, RuntimePhase.IDLE],
  [RuntimePhase.REFLECT]: [RuntimePhase.LEARN, RuntimePhase.IDLE],
  [RuntimePhase.LEARN]: [RuntimePhase.IDLE],
}

// ==============================
// 任务类型
// ==============================

export type TaskSource = 'chat' | 'evolution' | 'background' | 'research'

export interface RuntimeTask {
  id: string
  /** 任务来源 */
  source: TaskSource
  /** 用户/系统输入的文本 */
  input: string
  /** 系统提示词覆盖 */
  systemPrompt?: string
  /** 只允许 LLM 调用的工具列表（undefined = 不限制） */
  llmAllowedTools?: string[]
  /** 创建的会话 ID */
  sessionId?: string
  /** 来源元数据 */
  metadata?: Record<string, unknown>
  /** 创建时间 */
  createdAt: number
  /** 关联的目标 ID（由 GoalScheduler 分配） */
  goalId?: string
}

// ==============================
// 资源限制
// ==============================

export interface ResourceLimits {
  maxLlmCalls: number
  maxToolCalls: number
  maxContextTokens: number
  maxCpuMs: number
  maxTimeMs: number
}

// ==============================
// 执行结果
// ==============================

export interface ToolExecution {
  call: ToolCallInfo
  result: {
    success: boolean
    content: string
    error?: string
    latencyMs: number
  }
}

export interface RuntimeResult {
  success: boolean
  taskId: string
  /** LLM 生成的回复文本 */
  reply?: string
  /** 执行的工具列表 */
  toolExecutions: ToolExecution[]
  /** 各阶段耗时 (ms) */
  phaseTiming: Partial<Record<RuntimePhase, number>>
  /** 总耗时 (ms) */
  totalMs: number
  /** 消耗的 Token 估算 */
  tokenCost: number
  /** 错误信息 */
  error?: string
}

// ==============================
// 反馈事件（FeedBack → Goal/Identity/Memory/Evolution）
// ==============================

export interface FeedbackEvent {
  taskId: string
  source: TaskSource
  phase: RuntimePhase
  result: RuntimeResult
  /** 目标 ID（如有） */
  goalId?: string
  /** 工具成功率 */
  toolSuccessRate: number
  /** 是否因预算拒绝 */
  budgetRejected: boolean
  /** 是否因目标对齐拒绝 */
  goalRejected: boolean
  /** 失败模式摘要 */
  failurePattern?: string
  timestamp: number
}

// ==============================
// Runtime 配置
// ==============================

export interface RuntimeConfig {
  /** 默认 LLM 调用预算 */
  defaultResourceLimits: Record<TaskSource, ResourceLimits>
  /** 是否启用目标对齐检查 */
  enableGoalCheck: boolean
  /** 是否启用预算检查 */
  enableBudgetCheck: boolean
  /** 是否启用能力检查 */
  enableCapabilityCheck: boolean
  /** 是否启用反馈收集 */
  enableFeedback: boolean
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  defaultResourceLimits: {
    chat: { maxLlmCalls: 300, maxToolCalls: 200, maxContextTokens: 600_000, maxCpuMs: 120_000, maxTimeMs: 300_000 },
    evolution: { maxLlmCalls: 50, maxToolCalls: 30, maxContextTokens: 200_000, maxCpuMs: 60_000, maxTimeMs: 300_000 },
    background: { maxLlmCalls: 15, maxToolCalls: 10, maxContextTokens: 50_000, maxCpuMs: 30_000, maxTimeMs: 60_000 },
    research: { maxLlmCalls: 50, maxToolCalls: 30, maxContextTokens: 200_000, maxCpuMs: 60_000, maxTimeMs: 180_000 },
  },
  enableGoalCheck: true,
  enableBudgetCheck: true,
  enableCapabilityCheck: true,
  enableFeedback: true,
}
