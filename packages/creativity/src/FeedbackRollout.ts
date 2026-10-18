/**
 * FeedbackRollout — 正向反馈闭环放量决策（设计 v1.0，P3 收尾）
 *
 * "离线回放 → 影子运行 → 小流量 → 正式启用，每阶段预固定基线、指标、回滚条件"（spec §八 P3）。
 * 本模块把那张表落成可执行判定：
 *   - rollback：安全不变量破坏（Duplicate Application Rate > 0）→ 立即建议回滚 off。
 *   - advance：当前阶段的预固定门槛全部满足 → 建议进入下一阶段。
 *   - hold：证据不足 → 保持当前阶段。
 *
 * 纯函数：不读写文件、不查 DB。阈值进配置 + 解析校验（R6 纪律）。
 * 反馈永不进入 checkPromotionGate/checkSubmitGate；放量判定只决定"生成端消费档位"。
 */

import type { FeedbackSnapshot } from './FeedbackLearning'
import { FEEDBACK_MODES, type FeedbackMode } from './FeedbackRuntime'

// ══════════════════════════════════════════
// 阈值（预固定，进配置可校验）
// ══════════════════════════════════════════

export interface FeedbackRolloutThresholds {
  /** 每阶段所需的最少运行观测数（shadow 或 canary） */
  minStageRuns: number
  /** 升档所需的最小归因覆盖率（有 provenance 的正向事件占比） */
  minAttributionCoverage: number
  /** canary → full 所允许的最大负向事件率（负向证据 / 全部证据） */
  maxNegativeEventRate: number
}

export const DEFAULT_FEEDBACK_ROLLOUT_THRESHOLDS: FeedbackRolloutThresholds = {
  minStageRuns: 5,
  minAttributionCoverage: 0.3,
  maxNegativeEventRate: 0.5,
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'string' ? Number(value) : value
  if (typeof num !== 'number' || !Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, num))
}

/** 解析并校验放量阈值；失败返回 null（fail-closed，调用方回退默认）。 */
export function parseFeedbackRolloutThresholds(raw: unknown): FeedbackRolloutThresholds | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const hasAny = ['minStageRuns', 'minAttributionCoverage', 'maxNegativeEventRate'].some((k) => obj[k] !== undefined)
  if (!hasAny) return null
  return {
    minStageRuns: clampNumber(obj.minStageRuns, 1, 10_000, DEFAULT_FEEDBACK_ROLLOUT_THRESHOLDS.minStageRuns),
    minAttributionCoverage: clampNumber(obj.minAttributionCoverage, 0, 1, DEFAULT_FEEDBACK_ROLLOUT_THRESHOLDS.minAttributionCoverage),
    maxNegativeEventRate: clampNumber(obj.maxNegativeEventRate, 0, 1, DEFAULT_FEEDBACK_ROLLOUT_THRESHOLDS.maxNegativeEventRate),
  }
}

/** 从环境变量解析（缺省全默认）。 */
export function resolveFeedbackRolloutThresholds(
  env: Record<string, string | undefined> = process.env,
): FeedbackRolloutThresholds {
  return (
    parseFeedbackRolloutThresholds({
      minStageRuns: env.MIO_FEEDBACK_MIN_STAGE_RUNS,
      minAttributionCoverage: env.MIO_FEEDBACK_MIN_COVERAGE,
      maxNegativeEventRate: env.MIO_FEEDBACK_MAX_NEGATIVE_RATE,
    }) ?? DEFAULT_FEEDBACK_ROLLOUT_THRESHOLDS
  )
}

// ══════════════════════════════════════════
// 运行观测记录
// ══════════════════════════════════════════

/** 一次观测模式下的生成运行摘要（shadow/canary/full；off 不观测不记录）。 */
export interface FeedbackRuntimeRun {
  at: number
  mode: Exclude<FeedbackMode, 'off'>
  snapshotVersion: string | null
  pairCount: number
  applied: boolean
}

// ══════════════════════════════════════════
// 放量判定
// ══════════════════════════════════════════

/** 阶梯：off → shadow → canary → full。 */
export const FEEDBACK_MODE_LADDER: readonly FeedbackMode[] = ['off', 'shadow', 'canary', 'full']

export function nextFeedbackMode(current: FeedbackMode): FeedbackMode | null {
  const index = FEEDBACK_MODE_LADDER.indexOf(current)
  return index >= 0 && index < FEEDBACK_MODE_LADDER.length - 1 ? FEEDBACK_MODE_LADDER[index + 1] : null
}

export interface FeedbackRolloutMetrics {
  snapshotVersion: string | null
  shadowRuns: number
  canaryRuns: number
  attributionCoverage: number
  duplicateApplicationRate: number
  negativeEventRate: number
  eventCount: number
}

export type FeedbackRolloutDecision = 'rollback' | 'advance' | 'hold'

export interface FeedbackRolloutReport {
  decision: FeedbackRolloutDecision
  from: FeedbackMode
  /** rollback → 'off'；advance → 下一阶段；hold → null */
  to: FeedbackMode | null
  reasons: string[]
  metrics: FeedbackRolloutMetrics
}

/** 快照内负向事件率：负向证据 / 全部证据（无证据 → 0）。 */
export function negativeEventRateOf(snapshot: FeedbackSnapshot | null): number {
  if (!snapshot) return 0
  let negative = 0
  let total = 0
  for (const pair of snapshot.pairs) {
    for (const dimension of ['selection', 'quality', 'landing'] as const) {
      total += pair[dimension].evidenceCount
    }
    negative += pair.negative.evidenceCount
    total += pair.negative.evidenceCount
  }
  return total > 0 ? negative / total : 0
}

function metricsOf(snapshot: FeedbackSnapshot | null, runs: readonly FeedbackRuntimeRun[]): FeedbackRolloutMetrics {
  return {
    snapshotVersion: snapshot?.version ?? null,
    shadowRuns: runs.filter((r) => r.mode === 'shadow').length,
    canaryRuns: runs.filter((r) => r.mode === 'canary').length,
    attributionCoverage: snapshot?.attributionCoverage ?? 0,
    duplicateApplicationRate: snapshot?.duplicateApplicationRate ?? 0,
    negativeEventRate: negativeEventRateOf(snapshot),
    eventCount: snapshot?.eventCount ?? 0,
  }
}

export interface BuildFeedbackRolloutReportArgs {
  snapshot: FeedbackSnapshot | null
  runs: readonly FeedbackRuntimeRun[]
  currentMode: FeedbackMode
  thresholds?: FeedbackRolloutThresholds
}

/**
 * 放量判定。判定顺序：
 *   1. 安全不变量破坏（重复加权）→ rollback（无条件，压过一切）。
 *   2. off → shadow：观测零风险，无条件 advance。
 *   3. shadow → canary / canary → full：预固定门槛全部满足才 advance，否则 hold。
 *   4. full：已到顶，hold。
 */
export function buildFeedbackRolloutReport(args: BuildFeedbackRolloutReportArgs): FeedbackRolloutReport {
  const thresholds = args.thresholds ?? DEFAULT_FEEDBACK_ROLLOUT_THRESHOLDS
  const metrics = metricsOf(args.snapshot, args.runs)
  const reasons: string[] = []

  // 1) 安全不变量：重复加权率必须为 0（P1 验收不变量）
  if (metrics.duplicateApplicationRate > 0) {
    reasons.push(`duplicate_application_rate=${metrics.duplicateApplicationRate.toFixed(4)} > 0 (invariant broken)`)
    return { decision: 'rollback', from: args.currentMode, to: 'off', reasons, metrics }
  }

  const next = nextFeedbackMode(args.currentMode)
  if (args.currentMode === 'full' || next === null) {
    reasons.push('already at full stage')
    return { decision: 'hold', from: args.currentMode, to: null, reasons, metrics }
  }

  // 2) off → shadow：只增加观测，不改变生成行为
  if (args.currentMode === 'off') {
    reasons.push('observation adds no generation risk')
    return { decision: 'advance', from: 'off', to: 'shadow', reasons, metrics }
  }

  // 3) shadow → canary / canary → full：预固定门槛
  const stageRuns = args.currentMode === 'shadow' ? metrics.shadowRuns : metrics.canaryRuns
  const stageName = args.currentMode
  let ready = true

  if (stageRuns < thresholds.minStageRuns) {
    ready = false
    reasons.push(`${stageName} runs ${stageRuns} < min ${thresholds.minStageRuns}`)
  }
  if (metrics.attributionCoverage < thresholds.minAttributionCoverage) {
    ready = false
    reasons.push(
      `attribution coverage ${metrics.attributionCoverage.toFixed(4)} < min ${thresholds.minAttributionCoverage}`,
    )
  }
  if (args.currentMode === 'canary' && metrics.negativeEventRate > thresholds.maxNegativeEventRate) {
    ready = false
    reasons.push(`negative event rate ${metrics.negativeEventRate.toFixed(4)} > max ${thresholds.maxNegativeEventRate}`)
  }

  if (!ready) {
    return { decision: 'hold', from: args.currentMode, to: null, reasons, metrics }
  }
  reasons.push(`all ${stageName} stage gates met`)
  return { decision: 'advance', from: args.currentMode, to: next, reasons, metrics }
}
