/**
 * 反 Memory 类型定义 — Anti-Memory Type Definitions
 *
 * 分析并反转 Memory ↔ Plan 之间的默认假设前提。
 *
 * 当前默认假设（编号 A1–A5）：
 *   A1 [主从关系] Memory 是主（上下文来源），Plan 是从（执行者）
 *   A2 [执行顺序] Memory 先加载上下文 → Plan 后在此上下文中执行
 *   A3 [决策权] Memory 决定重要性（通过分数/层级）→ Plan 遵循该优先级
 *   A4 [范围控制] Memory 存储全部（通用范围）→ Plan 从中过滤所需
 *   A5 [生命周期] Memory 长期累积 → Plan 短期任务绑定
 *
 * 每个假设的反转版本及可行性评估详见 getAntiMemoryAssumptions()。
 */

// ══════════════════════════════════════════════════════════════════
// 反转假设分析
// ══════════════════════════════════════════════════════════════════

/** 假设反转的描述 */
export interface AssumptionInversion {
  /** 原始假设 */
  original: string
  /** 反转版本 */
  inversed: string
  /** 可行性 */
  feasibility: 'high' | 'medium' | 'low'
  /** 影响范围 */
  scope: string
  /** 风险 */
  risks: string[]
  /** 潜在价值 */
  value: string
}

// ══════════════════════════════════════════════════════════════════
// Plan → Memory 指令类型
// ══════════════════════════════════════════════════════════════════

/** Plan 领域标签 — 对应 Plan:并行推进的三个子任务 */
export type PlanDomain = 'radar_merge' | 'songge_backup' | 'blog_analysis'

/** Plan 对 Memory 的指令动作 */
export type MemoryDirectiveAction = 'boost' | 'suppress' | 'pin' | 'demote' | 'archive'

/** Plan → Memory 单条指令 */
export interface MemoryDirective {
  /** 指令动作 */
  action: MemoryDirectiveAction
  /** 目标话题/关键词 */
  topic: string
  /** 强度 (0–1) */
  intensity: number
  /** 原因说明 */
  reason: string
  /** 关联的 Plan 领域 */
  domain: PlanDomain
  /** 过期时间戳（0 = 不自动过期） */
  expiresAt: number
}

/** Plan 当前执行范围快照 */
export interface PlanScopeSnapshot {
  /** 活跃的 Plan 领域列表 */
  activeDomains: PlanDomain[]
  /** 各领域聚焦话题 */
  domainTopics: Record<PlanDomain, string[]>
  /** Plan 产生的高价值关键词 */
  highValueKeywords: string[]
  /** 最近一次 Plan 执行时间戳 */
  lastPlanRunAt: number
  /** 指令列表 */
  directives: MemoryDirective[]
}

// ══════════════════════════════════════════════════════════════════
// Plan 驱动的记忆上下文（反转的上下文方向）
// ══════════════════════════════════════════════════════════════════

/**
 * 传统：Memory 提供上下文 → Plan 消费
 * 反转：Plan 提供上下文 → Memory 按照 Plan 的优先级排序输出
 */
export interface PlanDrivenMemoryContext {
  /** Plan 活跃领域列表 */
  activePlanDomains: string[]
  /** Plan 高优话题下的记忆（按 Plan 优先级排序，非 Memory 默认排序） */
  planScopedMemories: Array<{
    content: string
    planRelevance: number
    domain: PlanDomain
    originalConfidence: number
  }>
  /** 被 Plan 屏蔽的无关记忆摘要（用于审计） */
  suppressedTopics: string[]
}

// ══════════════════════════════════════════════════════════════════
// PlanMemoryDirector 配置
// ══════════════════════════════════════════════════════════════════

export interface PlanMemoryDirectorConfig {
  /** 是否启用 Plan → Memory 指令 */
  enabled: boolean
  /** 指令默认过期时间（毫秒） */
  defaultDirectiveTtlMs: number
  /** Boost 强度上限 */
  maxBoostIntensity: number
  /** Suppress 强度上限 */
  maxSuppressIntensity: number
}

export const DEFAULT_DIRECTOR_CONFIG: PlanMemoryDirectorConfig = {
  enabled: true,
  defaultDirectiveTtlMs: 24 * 60 * 60 * 1000, // 24 小时
  maxBoostIntensity: 0.5,
  maxSuppressIntensity: 0.3,
}
