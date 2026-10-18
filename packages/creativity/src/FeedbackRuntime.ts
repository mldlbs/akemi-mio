/**
 * FeedbackRuntime — 正向反馈闭环受控启用（设计 v1.0，P3）
 *
 * 把"是否/如何消费反馈"从代码常量提升为可配置、可校验的运行时状态（R6 纪律）：
 *   - off     关闭：生成行为与无反馈时逐字节一致（默认）。
 *   - shadow  影子运行：计算反馈调整并记录 delta，但不应用到排序/prompt。
 *   - canary 小流量：按比例应用反馈（λ 与探索预算生效）。
 *   - full    正式启用：全部应用。
 *
 * 每阶段预固定基线、指标与回滚条件；回滚 = 切回 off（配置热切换，无需发版）。
 * 反馈永不进入 checkPromotionGate/checkSubmitGate 输入（spec §二.2）。
 */

export type FeedbackMode = 'off' | 'shadow' | 'canary' | 'full'

export interface FeedbackRuntimeConfig {
  mode: FeedbackMode
  /** λ clamp：单对调整占总评分范围的比例上限 */
  lambdaClampPct: number
  /** 探索预算：保留给低频/新组合的槽位比例 */
  explorationBudget: number
  /** 证据时间衰减半衰期（天） */
  halfLifeDays: number
  /** canary 模式应用反馈的比例 0..1 */
  canaryFraction: number
}

export const DEFAULT_FEEDBACK_RUNTIME: FeedbackRuntimeConfig = {
  mode: 'off',
  lambdaClampPct: 0.1,
  explorationBudget: 0.2,
  halfLifeDays: 30,
  canaryFraction: 0.1,
}

export const FEEDBACK_MODES: readonly FeedbackMode[] = ['off', 'shadow', 'canary', 'full']

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'string' ? Number(value) : value
  if (typeof num !== 'number' || !Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, num))
}

/**
 * 解析并校验运行时配置；失败返回 null（fail-closed，调用方回退默认 off）。
 * 未知字段忽略。
 */
export function parseFeedbackRuntime(raw: unknown): FeedbackRuntimeConfig | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const mode = obj.mode
  if (!FEEDBACK_MODES.includes(mode as FeedbackMode)) return null
  return {
    mode: mode as FeedbackMode,
    lambdaClampPct: clampNumber(obj.lambdaClampPct, 0, 0.5, DEFAULT_FEEDBACK_RUNTIME.lambdaClampPct),
    explorationBudget: clampNumber(obj.explorationBudget, 0, 1, DEFAULT_FEEDBACK_RUNTIME.explorationBudget),
    halfLifeDays: clampNumber(obj.halfLifeDays, 1, 3650, DEFAULT_FEEDBACK_RUNTIME.halfLifeDays),
    canaryFraction: clampNumber(obj.canaryFraction, 0, 1, DEFAULT_FEEDBACK_RUNTIME.canaryFraction),
  }
}

/** 从环境变量解析（缺省全 off）。 */
export function resolveFeedbackRuntime(env: Record<string, string | undefined> = process.env): FeedbackRuntimeConfig {
  const parsed = parseFeedbackRuntime({
    mode: env.MIO_FEEDBACK_MODE,
    lambdaClampPct: env.MIO_FEEDBACK_LAMBDA_PCT,
    explorationBudget: env.MIO_FEEDBACK_EXPLORATION,
    halfLifeDays: env.MIO_FEEDBACK_HALF_LIFE_DAYS,
    canaryFraction: env.MIO_FEEDBACK_CANARY_FRACTION,
  })
  // env 全缺省时 parse 返回 null（mode undefined）→ 回退默认 off
  return parsed ?? DEFAULT_FEEDBACK_RUNTIME
}

/** 该模式下是否实际应用反馈到生成（shadow 只观测）。 */
export function isFeedbackApplied(mode: FeedbackMode): boolean {
  return mode === 'canary' || mode === 'full'
}

/** 该模式下是否观测（计算 delta 并记录）。 */
export function isFeedbackObserved(mode: FeedbackMode): boolean {
  return mode === 'shadow' || mode === 'canary' || mode === 'full'
}
