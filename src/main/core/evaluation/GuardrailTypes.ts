/**
 * Guardrail Types — Guardrail 专有类型定义
 *
 * 职责仅定义 Guardrail 决策/策略/配置类型。
 * Progress 相关类型（ProgressSnapshot, ProgressAnalyzer 等）已迁移到 progress.ts。
 *
 * 依赖方向（冻结）：
 *   Guardrail → progress.ts
 *
 * 不得出现的反向依赖：
 *   progress.ts → Guardrail ✗
 *
 * 关键约束：
 * - GuardrailAction 当前限定 continue / warning / terminate
 * - 后续加入 Retry / Replan / Escalate 需升级 Runtime 状态机
 * - 不依赖 EventBus，只依赖 EvaluationRepository.getTrace()
 */

import type { ProgressSnapshot } from './progress'
import type { EvaluationEvent } from './types'

// ══════════════════════════════════════════════
// GuardrailDecision — Runtime 消费的统一输出
// ══════════════════════════════════════════════

export type GuardrailAction = 'continue' | 'warning' | 'terminate'

/**
 * RuntimeAction — Runtime 消费的统一指令枚举。
 *
 * GuardrailDecision.action 映射到 RuntimeAction：
 *   continue  → CONTINUE  （不干预）
 *   warning   → WARNING   （仅记录日志，不干预执行）
 *   terminate → TERMINATE （放行本轮 LLM 回复后退出 toolLoop）
 *
 * 未来加入 Retry / Replan / Escalate 只需在此扩展，
 * Runtime（ChatExecutor）无需修改 —— GuardrailPipeline 负责映射。
 */
export type RuntimeAction = 'CONTINUE' | 'WARNING' | 'TERMINATE'

/** 将 GuardrailAction 映射为 RuntimeAction */
export function toRuntimeAction(action: GuardrailAction): RuntimeAction {
  switch (action) {
    case 'continue':
      return 'CONTINUE'
    case 'warning':
      return 'WARNING'
    case 'terminate':
      return 'TERMINATE'
  }
}

export interface GuardrailDecision {
  action: GuardrailAction
  /** 决策原因描述 */
  reason: string
  /** 决策时间戳 */
  decidedAt: number
  /** 关联 traceId */
  traceId: string
  /** 每个信号的单独状态（用于调试和 Report） */
  signals: SignalState[]
  /** 产生该决策的原始快照 */
  snapshot: ProgressSnapshot
}

export interface SignalState {
  name: string
  status: 'healthy' | 'degrading' | 'stalled'
  detail: string
}

/**
 * GuardrailPolicy — 基于 ProgressSnapshot 做出决策
 *
 * 职责：
 * - 接收 ProgressSnapshot，返回 GuardrailDecision
 * - 无内部状态，纯函数
 * - 阈值可配置
 */
export interface GuardrailPolicy {
  evaluate(snapshot: ProgressSnapshot): GuardrailDecision
}

// ══════════════════════════════════════════════
// 配置
// ══════════════════════════════════════════════

export interface GuardrailPolicyConfig {
  stateChange: {
    /** 连续无变化轮次超过此值→degrading */
    degrading: number
    /** 连续无变化轮次超过此值→stalled */
    stalled: number
  }
  informationGain: {
    /** 连续低输出轮次超过此值→degrading */
    lowOutputDegrading: number
    /** 连续低输出轮次超过此值→stalled */
    lowOutputStalled: number
    /** 连续重复内容超过此值→degrading */
    repeatedContentDegrading: number
    /** 连续重复内容超过此值→stalled */
    repeatedContentStalled: number
  }
  goalProgress: {
    /** 连续无推进轮次超过此值→degrading */
    degrading: number
    /** 连续无推进轮次超过此值→stalled */
    stalled: number
  }
}

export const DEFAULT_GUARDRAIL_POLICY_CONFIG: GuardrailPolicyConfig = {
  stateChange: { degrading: 3, stalled: 8 },
  informationGain: { lowOutputDegrading: 3, lowOutputStalled: 8, repeatedContentDegrading: 2, repeatedContentStalled: 5 },
  goalProgress: { degrading: 4, stalled: 10 },
}

// ══════════════════════════════════════════════
// 事件源接口（Interface Segregation — 仅需 getTrace）
// ══════════════════════════════════════════════

export interface TraceEventSource {
  getTrace(traceId: string): Promise<EvaluationEvent[]>
}

// ══════════════════════════════════════════════
// 向后兼容 Re-export（从 progress.ts）
//
// 这些类型已在 progress.ts 中定义，此处仅 re-export
// 以保持现有导入链不中断。
// 新代码应直接 import from './progress'。
// ══════════════════════════════════════════════

/**
 * @deprecated 从 './progress' 导入。
 * Progress 相关类型已迁移到 progress.ts，此 re-export 将在 Guardrail v2 重构时移除。
 */
export type {
  StateChangeSignal,
  InformationGainSignal,
  GoalProgressSignal,
  ProgressSnapshot,
  ProgressAnalyzer,
  ProgressConsumer,
  ProgressSignal,
} from './progress'
