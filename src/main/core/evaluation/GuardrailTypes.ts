/**
 * Guardrail Types — Trace-Level Progress 检测协议
 *
 * 职责仅定义接口，不包含任何检测逻辑。
 * 所有分析器和策略都是此协议的实现。
 *
 * 关键约束：
 * - GuardrailAction 当前限定 continue / warning / terminate
 * - 后续加入 Retry / Replan / Escalate 需升级 Runtime 状态机
 * - 不依赖 EventBus，只依赖 EvaluationRepository.getTrace()
 *
 * ── 数据流 ──
 * EvaluationRepository.getTrace(traceId)
 *         ↓
 * ProgressAnalyzer.analyze(traceId)
 *         ↓
 *   ProgressSnapshot
 *         ↓
 * GuardrailPolicy.evaluate(snapshot)
 *         ↓
 *   GuardrailDecision
 *         ↓
 *   GuardrailDecision ———→ RuntimeAction (CONTINUE / WARNING / TERMINATE)
 *         ↓
 * GuardrailPipeline.check()
 *         ↓
 * EvaluationEmitter (guardrail.checked / guardrail.terminated)
 *         ↓
 * Observation v1.2
 */

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

// ══════════════════════════════════════════════
// ProgressSnapshot — ProgressAnalyzer → GuardrailPolicy 的中间数据
// ══════════════════════════════════════════════

export interface ProgressSnapshot {
  traceId: string
  sessionId: string
  /** 已执行轮次（model.invoked 计数） */
  totalTurns: number
  /** 从第一个事件到 now 的毫秒数 */
  elapsedMs: number
  /** 快照生成时间 */
  computedAt: number

  /** Signal 1: 状态变化 */
  stateChange: StateChangeSignal
  /** Signal 2: 信息增益 */
  informationGain: InformationGainSignal
  /** Signal 3: 目标推进 */
  goalProgress: GoalProgressSignal
}

// ══════════════════════════════════════════════
// Signal 1 — State Change（状态变化）
// ══════════════════════════════════════════════

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
  summary: string
}

// ══════════════════════════════════════════════
// Signal 2 — Information Gain（信息增益）
// ══════════════════════════════════════════════

export interface InformationGainSignal {
  /** 连续低输出（<= 20 chars）的轮次数 */
  consecutiveLowOutputTurns: number
  /** 连续重复 assistant 内容的次数 */
  repeatedOutputCount: number
  /** 工具结果重复的计数（相同工具 + 相同输出指纹） */
  repeatedToolResultCount: number
  /** 工具结果新颖度 0~1（0 = 全部重复，1 = 全部新颖） */
  toolResultNovelty: number
  summary: string
}

// ══════════════════════════════════════════════
// Signal 3 — Goal Progress（目标推进）
// ══════════════════════════════════════════════

export interface GoalProgressSignal {
  /** 已完成子任务数（task.completed 计数） */
  completedSubtasks: number
  /** 是否有阶段转换（workflow.completed → workflow.started） */
  hasPhaseTransition: boolean
  /** 连续无推进事件的轮次数 */
  stagnantTurnCount: number
  summary: string
}

// ══════════════════════════════════════════════
// 核心接口
// ══════════════════════════════════════════════

/**
 * ProgressAnalyzer — 从事件流计算当前进展状态
 *
 * 职责：
 * - 接收 EvaluationEvent[]，计算 ProgressSnapshot
 * - 不包含任何决策逻辑
 * - 纯函数可测试：compute() 可直接传入伪造事件
 */
export interface ProgressAnalyzer {
  /** 从存储中按 traceId 加载事件并分析 */
  analyze(traceId: string): Promise<ProgressSnapshot>
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
