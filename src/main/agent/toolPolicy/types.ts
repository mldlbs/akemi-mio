/**
 * ADR-008 Frozen Contract.
 *
 * ToolPolicyPlanner 的输出契约。
 * 描述"是否应该使用工具"的策略倾向。
 *
 * confidence 表示 Planner 对自身决策的置信度，
 * 不是 LLM 成功调用工具的概率，也不是 Tool 可用性评分。
 */

/** 工具使用倾向，按优先级从高到低排列 */
export type ToolPreference = 'proactive' | 'auto' | 'avoid' | 'forbidden'

/**
 * ADR-008 Frozen Contract.
 *
 * ToolDecision 的原因枚举。冻结以防止原因字段漂移。
 * 后续扩展必须通过 ADR 修订。
 *
 * UNKNOWN 提供统一落点：未识别原因、实验阶段、向后兼容
 * 场景均回退至此值，而非回退成自由字符串。
 */
export enum ToolDecisionReason {
  /** 用户明确要求执行操作 */
  USER_REQUEST = 'USER_REQUEST',
  /** 检测到文件上传或新信息可用 */
  FILE_AVAILABLE = 'FILE_AVAILABLE',
  /** 检测到执行型任务（实现、开发、部署等） */
  EXECUTION_TASK = 'EXECUTION_TASK',
  /** 检测到实时信息查询（天气、新闻、搜索等） */
  FRESH_INFORMATION = 'FRESH_INFORMATION',
  /** 检测到用户对 Agent 行为的元反馈 */
  META_FEEDBACK = 'META_FEEDBACK',
  /** 安全限制导致禁止或限制工具 */
  SAFETY = 'SAFETY',
  /** 无强信号命中，由场景兜底 */
  DEFAULT = 'DEFAULT',
  /** 未识别原因或实验阶段回退值 */
  UNKNOWN = 'UNKNOWN',
}

/**
 * ADR-008 Frozen Contract.
 *
 * ToolPolicyPlanner 的输出契约。
 *
 * preference: 工具使用倾向
 * confidence: Planner 对自身决策的置信度（0-1）
 * reason: 决策原因，冻结为确定字符串，禁止自由文本
 */
export interface ToolDecision {
  preference: ToolPreference
  confidence: number
  reason: ToolDecisionReason
}
