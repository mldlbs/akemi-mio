/**
 * ExperimentRunStore — 实验运行存储（机制涌现 P2b，定案 D4/D5/A1/A3/A4）
 *
 * ExperimentRun 实体：candidateId/baselineId/assignment/outcome/metrics/evidenceIds/stale。
 * 三模式：baseline/candidate/ablation；消融缺任一侧=inconclusive。
 * 停止规则：minSamples 硬门槛（默认 30），n<minSamples 只能产出 inconclusive、禁进 PromotionRequest。
 * stale 标记：baseSnapshotId 与当前 runtime 不匹配时标 stale，stale 禁晋级。
 * Memory 机制性隔离（A1）：MIO EXPERIMENT 标志路由 experiment-memory.jsonl。
 */

// ══════════════════════════════════════════
// ExperimentRun 实体
// ══════════════════════════════════════════

export type ExperimentAssignment = 'baseline' | 'candidate' | 'ablation'

export type ExperimentOutcome = 'success' | 'failure' | 'inconclusive'

export interface ExperimentRun {
  id: string
  hypothesisId?: string
  candidateId?: string
  baselineId?: string
  assignment: ExperimentAssignment
  outcome: ExperimentOutcome
  /** 指标快照（白名单标量） */
  metrics: Record<string, number | boolean | string>
  /** 证据 trace/memory id 列表 */
  evidenceIds: string[]
  /** 快照 id（实验时的 runtime 快照） */
  baseSnapshotId?: string
  /** stale：baseSnapshotId 与当前 runtime 不匹配 → 禁晋级 */
  stale?: boolean
  createdAt: number
  completedAt?: number
}

// ══════════════════════════════════════════
// 停止规则配置（R6，可配置，非文档数字）
// ══════════════════════════════════════════

export interface StoppingRuleConfig {
  /** 最小样本量硬门槛；n < minSamples → 只能 inconclusive，禁晋级 */
  minSamples: number
  /** 最大样本量（可选，达到后强制停止） */
  maxSamples?: number
  /** 最小成功率阈值（可选，0-1；达到后可提前 promote 候选） */
  minSuccessRate?: number
  /** 最大失败率阈值（可选，0-1；超过后可提前 reject 候选） */
  maxFailureRate?: number
  /** 实验最大持续时间 ms（可选） */
  maxDurationMs?: number
}

/** 默认停止规则：minSamples=30（硬门槛） */
export const DEFAULT_STOPPING_RULE: StoppingRuleConfig = { minSamples: 30 }

/**
 * 解析并校验停止规则 JSON 配置。
 * 失败返回 null（fail-closed）；未知字段忽略。
 */
export function parseStoppingRule(raw: unknown): StoppingRuleConfig | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const minSamples = obj.minSamples
  if (typeof minSamples !== 'number' || !Number.isFinite(minSamples) || minSamples < 1) return null
  const config: StoppingRuleConfig = { minSamples: Math.floor(minSamples) }
  if (typeof obj.maxSamples === 'number' && Number.isFinite(obj.maxSamples) && obj.maxSamples >= config.minSamples) {
    config.maxSamples = Math.floor(obj.maxSamples)
  }
  if (typeof obj.minSuccessRate === 'number' && Number.isFinite(obj.minSuccessRate) && obj.minSuccessRate >= 0 && obj.minSuccessRate <= 1) {
    config.minSuccessRate = obj.minSuccessRate
  }
  if (typeof obj.maxFailureRate === 'number' && Number.isFinite(obj.maxFailureRate) && obj.maxFailureRate >= 0 && obj.maxFailureRate <= 1) {
    config.maxFailureRate = obj.maxFailureRate
  }
  if (typeof obj.maxDurationMs === 'number' && Number.isFinite(obj.maxDurationMs) && obj.maxDurationMs > 0) {
    config.maxDurationMs = Math.floor(obj.maxDurationMs)
  }
  return config
}

// ══════════════════════════════════════════
// 三模式调度
// ══════════════════════════════════════════

export interface AssignmentResult {
  assignment: ExperimentAssignment
  reason?: string
}

/**
 * 根据可用侧分配三模式。
 * - 有 candidate + baseline → candidate（对照）
 * - 只有 baseline → baseline
 * - 消融：需要 candidate + baseline + ablation 标识；缺任一侧 → inconclusive
 */
export function assignExperimentMode(input: { candidateId?: string; baselineId?: string; ablationId?: string }): AssignmentResult {
  const { candidateId, baselineId, ablationId } = input
  if (ablationId) {
    // 消融需要双侧对照
    if (!candidateId || !baselineId) {
      return { assignment: 'ablation', reason: 'inconclusive_missing_side' }
    }
    return { assignment: 'ablation' }
  }
  if (candidateId && baselineId) return { assignment: 'candidate' }
  if (baselineId) return { assignment: 'baseline' }
  return { assignment: 'baseline', reason: 'no_baseline' }
}

// ══════════════════════════════════════════
// 停止规则评估
// ══════════════════════════════════════════

export interface StoppingDecision {
  /** 是否应停止实验 */
  shouldStop: boolean
  /** 推荐结果（仅在 n>=minSamples 且有足够信息时非 null） */
  recommended: ExperimentOutcome | null
  /** 停止原因（公开原因，不泄漏沙箱内部） */
  reason: string
}

/**
 * 基于样本评估停止规则。
 *
 * - n < minSamples → 只能产出 inconclusive（A3 硬门槛）
 * - n >= minSamples 且有 maxFailureRate/minSuccessRate → 可提前停止
 * - maxSamples / maxDurationMs 达到 → 停止
 */
export function evaluateStoppingRule(
  config: StoppingRuleConfig,
  runs: readonly ExperimentRun[],
  now: number = Date.now(),
): StoppingDecision {
  const n = runs.length
  const successCount = runs.filter((r) => r.outcome === 'success').length
  const failureCount = runs.filter((r) => r.outcome === 'failure').length
  const inconclusiveCount = runs.filter((r) => r.outcome === 'inconclusive').length
  const successRate = n > 0 ? successCount / n : 0
  const failureRate = n > 0 ? failureCount / n : 0

  // 硬门槛：n < minSamples → inconclusive（A3）
  if (n < config.minSamples) {
    return {
      shouldStop: false,
      recommended: null,
      reason: 'below_min_samples',
    }
  }

  // maxSamples
  if (config.maxSamples !== undefined && n >= config.maxSamples) {
    return { shouldStop: true, recommended: majorityOutcome(successCount, failureCount, inconclusiveCount), reason: 'max_samples' }
  }

  // maxFailureRate 超过 → 停止 + reject
  if (config.maxFailureRate !== undefined && failureRate > config.maxFailureRate) {
    return { shouldStop: true, recommended: 'failure', reason: 'failure_rate_exceeded' }
  }

  // minSuccessRate 达到 → 停止 + success
  if (config.minSuccessRate !== undefined && successRate >= config.minSuccessRate) {
    return { shouldStop: true, recommended: 'success', reason: 'success_rate_met' }
  }

  // maxDurationMs
  if (config.maxDurationMs !== undefined) {
    const oldest = Math.min(...runs.map((r) => r.createdAt))
    if (now - oldest >= config.maxDurationMs) {
      return { shouldStop: true, recommended: majorityOutcome(successCount, failureCount, inconclusiveCount), reason: 'max_duration' }
    }
  }

  return { shouldStop: false, recommended: null, reason: 'continue' }
}

function majorityOutcome(s: number, f: number, i: number): ExperimentOutcome {
  if (s > f && s > i) return 'success'
  if (f > s && f > i) return 'failure'
  return 'inconclusive'
}

// ══════════════════════════════════════════
// 晋级门控（A3 + A4）
// ══════════════════════════════════════════

export interface PromotionGateResult {
  allowed: boolean
  /** 公开原因 */
  reason: string
}

/**
 * 检查是否允许进入 PromotionRequest。
 * A3：n < minSamples 禁晋级。
 * A4：stale 禁晋级。
 */
export function checkPromotionGate(
  config: StoppingRuleConfig,
  runs: readonly ExperimentRun[],
  currentSnapshotId?: string,
): PromotionGateResult {
  // A4: stale 检查
  const anyStale = runs.some((r) => r.stale === true)
  if (anyStale) {
    return { allowed: false, reason: 'stale_snapshot' }
  }
  // A4: baseSnapshotId 与当前 runtime 不匹配
  if (currentSnapshotId) {
    const mismatched = runs.some((r) => r.baseSnapshotId !== undefined && r.baseSnapshotId !== currentSnapshotId)
    if (mismatched) {
      return { allowed: false, reason: 'snapshot_mismatch' }
    }
  }
  // A3: minSamples 硬门槛
  const n = runs.length
  if (n < config.minSamples) {
    return { allowed: false, reason: 'below_min_samples' }
  }
  return { allowed: true, reason: 'ok' }
}

// ══════════════════════════════════════════
// Memory 机制性隔离（A1）
// ══════════════════════════════════════════

/**
 * 实验 Memory 路由：MIO EXPERIMENT 标志 → experiment-memory.jsonl。
 * 服务端 memory-record 检测此标志并强制路由。
 */
export function routeExperimentMemoryPath(baseMemoryPath: string, isExperiment: boolean): string {
  if (!isExperiment) return baseMemoryPath
  // 替换扩展名为 experiment-memory.jsonl
  const dir = baseMemoryPath.includes('/') ? baseMemoryPath.slice(0, baseMemoryPath.lastIndexOf('/') + 1) : ''
  return `${dir}experiment-memory.jsonl`
}

/** MIO EXPERIMENT 环境标志检测 */
export function isExperimentMode(env: Record<string, string | undefined> = process.env): boolean {
  return env.MIO_EXPERIMENT === '1' || env.MIO_EXPERIMENT === 'true'
}
