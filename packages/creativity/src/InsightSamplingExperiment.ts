/**
 * InsightSamplingExperiment — insight 抽样策略 dogfood 实验（机制涌现 P3，定案 D4/R4）
 *
 * 首域 = insight 抽样策略（issue-6 P4 sourceQuota 有现成 before/after + 历史 observations 可重放）。
 * 三组对照：现有 quota 抽样 / 变体 A / 变体 B + 消融（移除配额/移除时间序保持）+ 未见任务泛化。
 * 产出 CapabilityDelta 报告；允许 inconclusive（不逼结论）。
 * 硬前置 A1：MIO EXPERIMENT 标志路由 experiment-memory.jsonl（由 ExperimentRunStore 提供）。
 */

import type { ExperimentRun, ExperimentAssignment } from './ExperimentRunStore'

/** Observation 最小形状（内联，避免跨包依赖） */
interface ObservationLike {
  id: string
  timestamp: string
  source: string
  content: string
}

/** RSS feedUrl 折叠（与 observer sourceQuota.sourceFamily 同语义） */
function sourceFamily(source: string): string {
  return /^https?:\/\//.test(source) ? 'rss' : source
}

// ══════════════════════════════════════════
// 抽样变体（策略对照）
// ══════════════════════════════════════════

export type SamplingVariant = 'baseline' | 'variant_a' | 'variant_b' | 'ablation_no_quota' | 'ablation_no_time_order'

/**
 * baseline: 现有 quota 抽样（issue-6 P4 sampleBySourceQuota）。
 * variant_a: 更高 minPerSource（保底提升，家族优先更强）。
 * variant_b: 只用 Phase A 保底，不做 Phase B 余量补齐（纯家族公平）。
 * ablation_no_quota: 移除配额 → 退化为 slice(0, limit)（issue-6 修复前）。
 * ablation_no_time_order: 移除时间序保持 → 输出按 weight 降序。
 */
export function sampleVariant(observations: readonly ObservationLike[], variant: SamplingVariant, limit = 30): ObservationLike[] {
  const obs = [...observations]
  switch (variant) {
    case 'baseline':
      return sampleByQuota(obs, limit, 5)
    case 'variant_a':
      return sampleByQuota(obs, limit, 8)
    case 'variant_b': {
      // Phase A only: 每家族取 min(quota, len)，quota = floor(limit/家族数) 或 5
      const byFamily = new Map<string, ObservationLike[]>()
      for (const o of obs) {
        const f = sourceFamily(o.source)
        const g = byFamily.get(f) ?? []
        g.push(o)
        byFamily.set(f, g)
      }
      const families = [...byFamily.keys()]
      let quota = 5
      if (families.length * quota > limit) quota = Math.max(1, Math.floor(limit / families.length))
      const out: ObservationLike[] = []
      for (const f of families) out.push(...byFamily.get(f)!.slice(0, quota))
      // 保持时间序
      out.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      return out.slice(0, limit)
    }
    case 'ablation_no_quota':
      return obs.slice(0, limit)
    case 'ablation_no_time_order': {
      const sampled = sampleByQuota(obs, limit, 5)
      return sampled.sort((a, b) => sourceFamily(a.source).localeCompare(sourceFamily(b.source)))
    }
  }
}

/**
 * 本地 quota 抽样（与 observer sourceQuota.sampleBySourceQuota 同语义的精简版）。
 * Phase A 每家族保底 + Phase B 余量最大余数法 + 时间序保持。
 */
function sampleByQuota(observations: ObservationLike[], limit: number, minPerSource: number): ObservationLike[] {
  if (limit <= 0) return []
  if (observations.length <= limit) return observations.slice()

  const groups = new Map<string, { idx: number; obs: ObservationLike }[]>()
  observations.forEach((obs, idx) => {
    const family = sourceFamily(obs.source)
    let g = groups.get(family)
    if (!g) {
      g = []
      groups.set(family, g)
    }
    g.push({ idx, obs })
  })

  const families = [...groups.keys()]
  let quota = minPerSource
  if (families.length * quota > limit) quota = Math.max(1, Math.floor(limit / families.length))

  const picked = new Set<number>()
  const taken = new Map<string, number>()
  for (const family of families) {
    const g = groups.get(family)!
    const take = Math.min(quota, g.length)
    for (let i = 0; i < take; i++) picked.add(g[i].idx)
    taken.set(family, take)
  }

  const remaining = limit - picked.size
  if (remaining > 0) {
    const shares = families.map((family) => {
      const group = groups.get(family)!
      return { family, group, pool: group.length - taken.get(family)!, base: 0, frac: 0 }
    })
    const totalPool = shares.reduce((s, x) => s + x.pool, 0)
    if (totalPool > 0) {
      for (const s of shares) {
        const exact = (remaining * s.pool) / totalPool
        s.base = Math.floor(exact)
        s.frac = exact - s.base
      }
      let leftover = remaining - shares.reduce((s, x) => s + x.base, 0)
      const byFrac = [...shares].sort((a, b) => b.frac - a.frac)
      for (const s of byFrac) {
        if (leftover <= 0) break
        if (s.pool > s.base) {
          s.base++
          leftover--
        }
      }
      for (const s of shares) {
        const start = taken.get(s.family)!
        for (let i = start; i < start + s.base; i++) picked.add(s.group[i].idx)
      }
    }
  }

  return observations.filter((_, i) => picked.has(i))
}

// ══════════════════════════════════════════
// 评估指标
// ══════════════════════════════════════════

export interface SamplingMetrics {
  /** 家族覆盖数（sourceFamily 去重） */
  familyCoverage: number
  /** 最大家族占比（0-1；越低越公平） */
  maxFamilyShare: number
  /** 时间序保持度：spearman 相关（0-1；1=完全保持） */
  timeOrderPreservation: number
  /** 小源（len<quota）是否全部入选 */
  smallSourceIncluded: boolean
  /** 样本量 */
  sampleSize: number
}

/** 计算抽样指标 */
export function computeSamplingMetrics(original: readonly ObservationLike[], sampled: readonly ObservationLike[]): SamplingMetrics {
  const families = new Set(original.map((o) => sourceFamily(o.source)))
  const sampledFamilies = new Set(sampled.map((o) => sourceFamily(o.source)))
  const byFamily = new Map<string, number>()
  for (const s of sampled) {
    const f = sourceFamily(s.source)
    byFamily.set(f, (byFamily.get(f) ?? 0) + 1)
  }
  const maxCount = Math.max(0, ...byFamily.values())
  const maxFamilyShare = sampled.length > 0 ? maxCount / sampled.length : 0

  // 时间序保持度：采样序列在原序列中的排名相关（简化为顺序单调比）
  const idxMap = new Map<string, number>()
  original.forEach((o, i) => idxMap.set(o.id, i))
  const ranks = sampled.map((s) => idxMap.get(s.id) ?? -1)
  let concordant = 0
  let total = 0
  for (let i = 0; i < ranks.length; i++) {
    for (let j = i + 1; j < ranks.length; j++) {
      if (ranks[i] < 0 || ranks[j] < 0) continue
      total++
      if (ranks[i] < ranks[j]) concordant++
    }
  }
  const timeOrderPreservation = total > 0 ? concordant / total : 1

  // 小源：len < 5 的家族是否全部入选
  const origByFamily = new Map<string, ObservationLike[]>()
  for (const o of original) {
    const f = sourceFamily(o.source)
    const g = origByFamily.get(f) ?? []
    g.push(o)
    origByFamily.set(f, g)
  }
  const smallSourceIncluded = [...origByFamily.entries()].every(([f, g]) => {
    if (g.length >= 5) return true
    const inSample = sampled.filter((s) => sourceFamily(s.source) === f)
    return inSample.length >= g.length
  })

  return {
    familyCoverage: sampledFamilies.size,
    maxFamilyShare,
    timeOrderPreservation,
    smallSourceIncluded,
    sampleSize: sampled.length,
  }
}

// ══════════════════════════════════════════
// CapabilityDelta 报告
// ══════════════════════════════════════════

export interface VariantResult {
  variant: SamplingVariant
  metrics: SamplingMetrics
  runIds: string[]
}

export interface CapabilityDeltaReport {
  experimentId: string
  hypothesisId?: string
  baselineVariant: SamplingVariant
  variants: VariantResult[]
  /** 相对 baseline 的 delta（每指标：variant - baseline） */
  deltas: Array<{
    variant: SamplingVariant
    familyCoverageDelta: number
    maxFamilyShareDelta: number
    timeOrderPreservationDelta: number
    smallSourceIncludedDelta: number
  }>
  /** 泛化：在未见任务（held-out observations）上的表现 */
  generalization?: {
    heldOutSize: number
    baselineMetrics: SamplingMetrics
    bestVariant: SamplingVariant
    bestMetrics: SamplingMetrics
  }
  /** 结论（允许 inconclusive） */
  conclusion: 'variant_a_wins' | 'variant_b_wins' | 'baseline_wins' | 'inconclusive'
  reason: string
  createdAt: number
}

/**
 * 运行 dogfood 实验：三组对照 + 消融，产出 CapabilityDelta 报告。
 * observations 从历史重放；splitTrainTest 按时间切分（前 70% train，后 30% held-out）。
 */
export function runInsightSamplingExperiment(
  experimentId: string,
  observations: readonly ObservationLike[],
  options?: {
    hypothesisId?: string
    limit?: number
    /** 每变体重复次数（取指标均值，降噪） */
    repeats?: number
  },
): CapabilityDeltaReport {
  const limit = options?.limit ?? 30
  const repeats = options?.repeats ?? 1
  const sorted = [...observations].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  const split = Math.max(1, Math.floor(sorted.length * 0.7))
  const train = sorted.slice(0, split)
  const heldOut = sorted.slice(split)

  const variants: SamplingVariant[] = ['baseline', 'variant_a', 'variant_b', 'ablation_no_quota', 'ablation_no_time_order']
  const variantResults: VariantResult[] = []

  for (const v of variants) {
    let metricsAcc: SamplingMetrics | null = null
    const runIds: string[] = []
    for (let r = 0; r < repeats; r++) {
      const sampled = sampleVariant(train, v, limit)
      const m = computeSamplingMetrics(train, sampled)
      metricsAcc = metricsAcc
        ? {
            familyCoverage: metricsAcc.familyCoverage + m.familyCoverage,
            maxFamilyShare: metricsAcc.maxFamilyShare + m.maxFamilyShare,
            timeOrderPreservation: metricsAcc.timeOrderPreservation + m.timeOrderPreservation,
            smallSourceIncluded: metricsAcc.smallSourceIncluded && m.smallSourceIncluded,
            sampleSize: metricsAcc.sampleSize + m.sampleSize,
          }
        : m
      runIds.push(`${experimentId}:${v}:${r}`)
    }
    const avg: SamplingMetrics = metricsAcc
      ? {
          familyCoverage: Math.round(metricsAcc.familyCoverage / repeats),
          maxFamilyShare: metricsAcc.maxFamilyShare / repeats,
          timeOrderPreservation: metricsAcc.timeOrderPreservation / repeats,
          smallSourceIncluded: metricsAcc.smallSourceIncluded,
          sampleSize: Math.round(metricsAcc.sampleSize / repeats),
        }
      : { familyCoverage: 0, maxFamilyShare: 1, timeOrderPreservation: 0, smallSourceIncluded: false, sampleSize: 0 }
    variantResults.push({ variant: v, metrics: avg, runIds })
  }

  const baseline = variantResults.find((r) => r.variant === 'baseline')!
  const deltas = variantResults
    .filter((r) => r.variant !== 'baseline')
    .map((r) => ({
      variant: r.variant,
      familyCoverageDelta: r.metrics.familyCoverage - baseline.metrics.familyCoverage,
      maxFamilyShareDelta: r.metrics.maxFamilyShare - baseline.metrics.maxFamilyShare,
      timeOrderPreservationDelta: r.metrics.timeOrderPreservation - baseline.metrics.timeOrderPreservation,
      smallSourceIncludedDelta: (r.metrics.smallSourceIncluded ? 1 : 0) - (baseline.metrics.smallSourceIncluded ? 1 : 0),
    }))

  // 泛化：held-out 上 baseline vs best variant（按 familyCoverage + smallSourceIncluded 排序）
  let generalization: CapabilityDeltaReport['generalization']
  if (heldOut.length > 0) {
    const baseSampled = sampleVariant(heldOut, 'baseline', limit)
    const baseMetrics = computeSamplingMetrics(heldOut, baseSampled)
    const scored = (['variant_a', 'variant_b'] as SamplingVariant[]).map((v) => {
      const s = sampleVariant(heldOut, v, limit)
      return { v, m: computeSamplingMetrics(heldOut, s) }
    })
    const best = scored.sort((a, b) => {
      const sc = (m: SamplingMetrics) => m.familyCoverage * 10 + (m.smallSourceIncluded ? 5 : 0) - m.maxFamilyShare
      return sc(b.m) - sc(a.m)
    })[0]
    generalization = {
      heldOutSize: heldOut.length,
      baselineMetrics: baseMetrics,
      bestVariant: best?.v ?? 'baseline',
      bestMetrics: best?.m ?? baseMetrics,
    }
  }

  // 结论：variant_a / variant_b 优于 baseline → 对应 wins；否则 baseline_wins；样本太少 → inconclusive
  const aDelta = deltas.find((d) => d.variant === 'variant_a')
  const bDelta = deltas.find((d) => d.variant === 'variant_b')
  const aBetter = aDelta && (aDelta.familyCoverageDelta > 0 || aDelta.smallSourceIncludedDelta > 0)
  const bBetter = bDelta && (bDelta.familyCoverageDelta > 0 || bDelta.smallSourceIncludedDelta > 0)
  let conclusion: CapabilityDeltaReport['conclusion']
  let reason: string
  if (train.length < 10) {
    conclusion = 'inconclusive'
    reason = 'too_few_observations'
  } else if (aBetter && bBetter) {
    // 双优 → inconclusive（需人工判断）
    conclusion = 'inconclusive'
    reason = 'both_variants_improve'
  } else if (aBetter) {
    conclusion = 'variant_a_wins'
    reason = 'higher_family_coverage_or_small_source'
  } else if (bBetter) {
    conclusion = 'variant_b_wins'
    reason = 'higher_family_coverage_or_small_source'
  } else {
    conclusion = 'baseline_wins'
    reason = 'no_improvement_over_baseline'
  }

  return {
    experimentId,
    hypothesisId: options?.hypothesisId,
    baselineVariant: 'baseline',
    variants: variantResults,
    deltas,
    generalization,
    conclusion,
    reason,
    createdAt: Date.now(),
  }
}

/** 把 CapabilityDelta 报告转成 ExperimentRun 列表（供 ExperimentRunStore.checkPromotionGate 使用） */
export function reportToExperimentRuns(report: CapabilityDeltaReport): ExperimentRun[] {
  return report.variants.map((v) => ({
    id: `${report.experimentId}:${v.variant}`,
    hypothesisId: report.hypothesisId,
    candidateId: v.variant,
    baselineId: report.baselineVariant,
    assignment: (v.variant === 'baseline'
      ? 'baseline'
      : v.variant.startsWith('ablation')
        ? 'ablation'
        : 'candidate') as ExperimentAssignment,
    outcome:
      report.conclusion === 'inconclusive' ? 'inconclusive' : v.variant === report.conclusion.replace('_wins', '') ? 'success' : 'failure',
    metrics: {
      familyCoverage: v.metrics.familyCoverage,
      maxFamilyShare: v.metrics.maxFamilyShare,
      timeOrderPreservation: v.metrics.timeOrderPreservation,
      smallSourceIncluded: v.metrics.smallSourceIncluded,
      sampleSize: v.metrics.sampleSize,
    },
    evidenceIds: v.runIds,
    createdAt: report.createdAt,
  }))
}
