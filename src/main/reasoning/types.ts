/**
 * Reasoning Contract — 模型无关的推理契约
 *
 * 职责边界：
 *  - ReasoningDirective：纯数据契约，描述"应该用什么思维框架"
 *  - ThinkingPattern：稳定有限的认知模式枚举
 *  - PromptBuilder：将 Directive 翻译为模型可理解的 Prompt
 *
 * 设计原则：
 *  - 不直接生成 Prompt
 *  - 不依赖具体模型
 *  - 不引入第二次 LLM 调用
 */

/**
 * 思维模式 — 稳定有限的认知框架枚举。
 * 每个 Pattern 代表一类通用的推理结构，不与具体业务场景耦合。
 */
export type ThinkingPattern =
  /** 因果链分析：A 导致了 B，B 又导致了 C */
  | 'cause_effect'
  /** 假设验证：现象 → 假设 → 验证 → 结论 */
  | 'hypothesis_verification'
  /** 多方案评估：在约束下比较候选方案的 tradeoff */
  | 'option_evaluation'
  /** 目标-约束权衡：给定目标和限制条件，分析可行路径 */
  | 'goal_constraint_tradeoff'
  /** 无特定推理模式，沿用默认对话风格 */
  | 'none'

/**
 * 推理目标 — 推理过程要达成的具体产出。
 */
export interface Goal {
  type:
    | 'identify_root_cause'
    | 'compare_options'
    | 'evaluate_tradeoffs'
    | 'explain_causality'
    | 'provide_recommendation'
  /** 目标的补充描述 */
  description?: string
}

/**
 * 约束条件 — 推理过程中必须遵守的边界。
 */
export interface Constraint {
  type:
    | 'scope'
    | 'assumption'
    | 'priority'
  description: string
}

/**
 * 输出风格 — 推理结果的呈现方式。
 * 描述的是"逻辑组织的层次"而非"字数/格式"。
 */
export type OutputStyle =
  /** 因果关系叙述 */
  | 'causal_narrative'
  /** 结构化对比 */
  | 'structured_comparison'
  /** 结论优先 */
  | 'conclusion_first'
  /** 默认风格 */
  | 'default'

/**
 * ReasoningDirective — 推理规划的输出（纯数据契约）。
 *
 * 由 ReasoningPlanner 生成，由 PromptBuilder 消费。
 * 中间不经过任何模型调用，保证职责隔离。
 */
export interface ReasoningDirective {
  /** 选中的思维模式 */
  pattern: ThinkingPattern
  /** 推理目标列表 */
  goals: Goal[]
  /** 约束条件列表 */
  constraints: Constraint[]
  /** 输出风格 */
  outputStyle: OutputStyle
}

/** 空的 Directive — 无推理规划时的默认值。 */
export const EMPTY_DIRECTIVE: ReasoningDirective = {
  pattern: 'none',
  goals: [],
  constraints: [],
  outputStyle: 'default',
}
