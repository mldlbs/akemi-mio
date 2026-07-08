/**
 * Progress Protocol — 系统级进展观察基础设施
 *
 * 本文件是 Progress 子系统的唯一公共 API。
 * 职责仅定义协议，不包含任何实现、决策逻辑或 Consumer。
 *
 * 核心不变量：
 * ProgressSnapshot is an immutable observation of runtime behavior,
 * never an interpretation of runtime quality.
 *
 * 依赖约束：
 * - Progress 不 import Guardrail
 * - Progress 不 import Runtime
 * - Progress 不 import ChatExecutor
 * - Progress 只依赖 EvaluationEvent（types.ts）
 *
 * ── 数据流 ──
 * EvaluationEvent[]
 *        │
 *        ▼
 * ProgressAnalyzer.compute()
 *        │
 *        ▼
 * ProgressSnapshot
 *        │
 *        ├────→ ProgressConsumer (Guardrail)
 *        ├────→ ProgressConsumer (Fitness)
 *        ├────→ ProgressConsumer (Reflection)
 *        └────→ ProgressConsumer (Evolution)
 *
 * ── 设计原则 ──
 * 1. ProgressSnapshot 只包含不可变事实，不包含阈值/评分/决策
 * 2. ProgressAnalyzer 是唯一生产者，纯函数，幂等
 * 3. ProgressConsumer 用 consume() 统一入口，无统一返回值
 * 4. Consumer 不定义 Signal，不扫描 Event，彼此独立
 */

import type { EvaluationEvent } from './types'

// ══════════════════════════════════════════════
// Signal 1 — State Change（状态变化事实）
// ══════════════════════════════════════════════

/**
 * @deprecated v1 嵌套格式，将在 v2 迁移到扁平 ProgressSignal。
 * 新增消费者应使用 ProgressSignal 而非此类型。
 */
export interface StateChangeSignal {
  /** 是否有新的 tool.completed 结果 */
  hasNewToolResult: boolean
  /** 是否有新的 assistant 文本输出 */
  hasNewAssistantContent: boolean
  /** 是否有新的 planning 状态变化 */
  hasPlanningStateChange: boolean
  /** 连续无状态变化的轮次数 */
  stagnantTurnCount: number
  /** 上次发生状态变化的轮次索引（-1 = 从未发生） */
  lastChangeTurn: number
  /** @deprecated 格式化字符串，v2 移除 */
  summary: string
}

// ══════════════════════════════════════════════
// Signal 2 — Information Gain（信息增益事实）
// ══════════════════════════════════════════════

/**
 * @deprecated v1 嵌套格式，将在 v2 迁移到扁平 ProgressSignal。
 */
export interface InformationGainSignal {
  /** 连续低输出（<= 20 chars）的轮次数 */
  consecutiveLowOutputTurns: number
  /** 连续重复 assistant 内容的次数 */
  repeatedOutputCount: number
  /** 工具结果重复的计数（相同工具 + 相同输出指纹） */
  repeatedToolResultCount: number
  /** 工具结果新颖度 0~1（0 = 全部重复，1 = 全部新颖） */
  toolResultNovelty: number
  /** @deprecated 格式化字符串，v2 移除 */
  summary: string
}

// ══════════════════════════════════════════════
// Signal 3 — Goal Progress（目标推进事实）
// ══════════════════════════════════════════════

/**
 * @deprecated v1 嵌套格式，将在 v2 迁移到扁平 ProgressSignal。
 */
export interface GoalProgressSignal {
  /** 已完成子任务数（task.completed 计数） */
  completedSubtasks: number
  /** 是否有阶段转换（workflow.completed → workflow.started） */
  hasPhaseTransition: boolean
  /** 连续无推进事件的轮次数 */
  stagnantTurnCount: number
  /** @deprecated 格式化字符串，v2 移除 */
  summary: string
}

// ══════════════════════════════════════════════
// v1 ProgressSnapshot（当前 Guardrail 消费的形状）
// ══════════════════════════════════════════════

/**
 * ProgressSnapshot — 特定时刻的推进观察结果。
 *
 * 当前为 v1 格式（嵌套 Signal），兼容现有 GuardrailPolicy。
 * v2 将迁移到 `signal: ProgressSignal` 扁平格式。
 *
 * 所有字段直接从 EvaluationEvent 推导：
 * - 不含任何阈值化值（无 degrading/stalled）
 * - 不含任何评分（无 score/health）
 * - 不含任何决策（无 shouldTerminate/recommendation）
 * - 不含任何 Policy 概念
 */
export interface ProgressSnapshot {
  /** 关联 traceId */
  traceId: string
  /** 关联 sessionId */
  sessionId: string
  /** Signal 生产算法版本 */
  version: number
  /** 已执行轮次（model.invoked 计数） */
  totalTurns: number
  /** 从第一个事件到 now 的毫秒数 */
  elapsedMs: number
  /** 观察时间戳 */
  observedAt: number

  /** @deprecated Signal 1 — 状态变化。v2 迁移到扁平格式 */
  stateChange: StateChangeSignal
  /** @deprecated Signal 2 — 信息增益。v2 迁移到扁平格式 */
  informationGain: InformationGainSignal
  /** @deprecated Signal 3 — 目标推进。v2 迁移到扁平格式 */
  goalProgress: GoalProgressSignal
}

// ══════════════════════════════════════════════
// v2 ProgressSignal（扁平事实格式 — 目标）
// ══════════════════════════════════════════════

/**
 * ProgressSignal — 一次计算产生的全部推进事实（扁平格式）。
 *
 * v2 目标格式。尚无 Consumer 消费此格式。
 * 迁移完成前保持 @alpha 状态。
 *
 * 扩展原则：
 * - 新增 Signal 只能新增字段，不改变已有字段语义
 * - 废弃字段用 @deprecated 标记，至少保留两个版本
 * - 禁止添加 action/decision/score/health/recommendation/policy 类字段
 *
 * @alpha v2 目标格式，当前未使用
 */
export interface ProgressSignal {
  /** tool.completed 事件计数 */
  toolCalls: number
  /** agent.response 事件计数 */
  assistantTurns: number
  /** 发生状态变化的轮次数（tool.completed / agent.response / progress event） */
  stateChanges: number
  /** task.completed + workflow.started + workflow.completed 事件计数 */
  goalProgressEvents: number
  /** 产生新信息的轮次数（modelOutputLength > 20 chars） */
  informationGainEvents: number
  /** 最后发生推进的轮次索引（-1 = 从未推进） */
  lastProgressTurn: number
  /** 从最后推进轮次到当前末尾的连续轮次数 */
  stagnantTurns: number
  /** Trace 内事件总数 */
  traceEvents: number
}

// ══════════════════════════════════════════════
// ProgressAnalyzer — 唯一生产者
// ══════════════════════════════════════════════

/**
 * ProgressAnalyzer — 从 EvaluationEvent[] 计算 ProgressSnapshot。
 *
 * 职责：
 * - compute() 是纯函数：输入 events → 输出 snapshot
 * - 不包含任何决策逻辑
 * - 不持有任何状态
 * - 可直接传入伪造事件测试
 *
 * 实现版本化：
 * - computeV1, computeV2 等静态方法
 * - ProgressSnapshot.version 记录算法版本
 */
export interface ProgressAnalyzer {
  /**
   * 从存储中按 traceId 加载事件并计算 ProgressSnapshot。
   * 对同一 traceId 幂等。
   */
  analyze(traceId: string): Promise<ProgressSnapshot>

  /**
   * 纯函数：直接传入 EvaluationEvent[] 计算 ProgressSnapshot。
   * 测试时无需存储。
   */
  compute(traceId: string, events: EvaluationEvent[]): ProgressSnapshot
}

// ══════════════════════════════════════════════
// ProgressConsumer — 通用消费者
// ══════════════════════════════════════════════

/**
 * ProgressConsumer — 消费 ProgressSnapshot 的通用接口。
 *
 * consume() 不定义统一返回值，因为不同 Consumer 的输出差异巨大：
 * - Guardrail → GuardrailDecision
 * - Fitness → Score
 * - Reflection → Insight
 * - Evolution → Action
 *
 * 统一入口比统一输出更稳定。
 *
 * 约束：
 * - Consumer 不自行扫描 Event 计算"进展"
 * - Consumer 无状态（不持有跨调用状态）
 * - Consumer 不依赖其他 Consumer
 * - Consumer 异常不影响其他 Consumer 的执行
 */
export interface ProgressConsumer {
  consume(snapshot: ProgressSnapshot): void | Promise<void>
}

// ══════════════════════════════════════════════
// 当前版本常量
// ══════════════════════════════════════════════

/** 当前 ProgressAnalyzer 实现版本 */
export const PROGRESS_VERSION = 1
