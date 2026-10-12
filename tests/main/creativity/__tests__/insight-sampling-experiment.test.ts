import { describe, expect, it } from 'vitest'
import {
  sampleVariant,
  computeSamplingMetrics,
  runInsightSamplingExperiment,
  reportToExperimentRuns,
} from '@akemi-mio/creativity/InsightSamplingExperiment'
import type { Observation } from '@akemi-mio/observer/types'

function makeObs(id: string, source: string, timestamp: string): Observation {
  return { id, source, content: `obs-${id}`, timestamp }
}

function makeDataset(): Observation[] {
  // 模拟历史 observations：bilibili 高频 + RSS 多 feed + 小源
  const out: Observation[] = []
  let i = 0
  for (let k = 0; k < 20; k++) out.push(makeObs(`bili_${k}`, 'bilibili', `2026-09-01T${String(k).padStart(2, '0')}:00:00Z`))
  for (let k = 0; k < 12; k++)
    out.push(makeObs(`rss_${k}`, `https://feed${k}.example.com`, `2026-09-02T${String(k).padStart(2, '0')}:00:00Z`))
  for (let k = 0; k < 5; k++) out.push(makeObs(`hn_${k}`, 'hackernews', `2026-09-03T${String(k).padStart(2, '0')}:00:00Z`))
  for (let k = 0; k < 3; k++) out.push(makeObs(`gh_${k}`, 'github', `2026-09-04T${String(k).padStart(2, '0')}:00:00Z`))
  for (let k = 0; k < 2; k++) out.push(makeObs(`douyin_${k}`, 'douyin', `2026-09-05T${String(k).padStart(2, '0')}:00:00Z`))
  return out.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}

describe('InsightSamplingExperiment — sampleVariant', () => {
  const data = makeDataset()

  it('baseline = sampleBySourceQuota (limit=30)', () => {
    const sampled = sampleVariant(data, 'baseline', 30)
    expect(sampled.length).toBeLessThanOrEqual(30)
    expect(sampled.length).toBeGreaterThan(0)
  })

  it('ablation_no_quota = slice(0, limit) (issue-6 修复前)', () => {
    const sampled = sampleVariant(data, 'ablation_no_quota', 30)
    expect(sampled.length).toBe(30)
    // 前 30 条：全是 bilibili（时间序前 20 + rss 前 10）
    expect(sampled[0].source).toBe('bilibili')
  })

  it('variant_b 保底家族公平', () => {
    const sampled = sampleVariant(data, 'variant_b', 30)
    const families = new Set(sampled.map((o) => o.source))
    // rss 折叠 + bilibili + hackernews + github + douyin = 5 家族
    expect(families.size).toBeGreaterThanOrEqual(4)
  })

  it('small source (douyin/github) included in baseline', () => {
    const sampled = sampleVariant(data, 'baseline', 30)
    const small = sampled.filter((o) => o.source === 'douyin' || o.source === 'github')
    expect(small.length).toBeGreaterThan(0)
  })
})

describe('InsightSamplingExperiment — computeSamplingMetrics', () => {
  it('computes family coverage and max share', () => {
    const data = makeDataset()
    const sampled = sampleVariant(data, 'baseline', 30)
    const m = computeSamplingMetrics(data, sampled)
    expect(m.familyCoverage).toBeGreaterThanOrEqual(3)
    expect(m.maxFamilyShare).toBeGreaterThan(0)
    expect(m.maxFamilyShare).toBeLessThanOrEqual(1)
    expect(m.sampleSize).toBe(sampled.length)
  })

  it('time order preservation = 1 when sampled is subsequence', () => {
    const data = makeDataset()
    const subsequence = data.filter((_, i) => i % 2 === 0)
    const m = computeSamplingMetrics(data, subsequence)
    expect(m.timeOrderPreservation).toBe(1)
  })
})

describe('InsightSamplingExperiment — runInsightSamplingExperiment', () => {
  it('produces CapabilityDelta report with 5 variants', () => {
    const data = makeDataset()
    const report = runInsightSamplingExperiment('exp_test', data, { hypothesisId: 'h1' })
    expect(report.experimentId).toBe('exp_test')
    expect(report.hypothesisId).toBe('h1')
    expect(report.variants.length).toBe(5)
    expect(report.deltas.length).toBe(4) // baseline excluded
    expect(['variant_a_wins', 'variant_b_wins', 'baseline_wins', 'inconclusive']).toContain(report.conclusion)
  })

  it('ablation_no_quota has lower family coverage than baseline (issue-6 修复效果)', () => {
    const data = makeDataset()
    const report = runInsightSamplingExperiment('exp_ablation', data)
    const abl = report.variants.find((v) => v.variant === 'ablation_no_quota')!
    const base = report.variants.find((v) => v.variant === 'baseline')!
    expect(abl.metrics.familyCoverage).toBeLessThanOrEqual(base.metrics.familyCoverage)
  })

  it('too few observations → inconclusive', () => {
    const tiny = makeDataset().slice(0, 5)
    const report = runInsightSampling_experiment_tiny(tiny)
    expect(report.conclusion).toBe('inconclusive')
    expect(report.reason).toBe('too_few_observations')
  })

  it('generalization present when held-out exists', () => {
    const data = makeDataset()
    const report = runInsightSamplingExperiment('exp_gen', data)
    expect(report.generalization).toBeDefined()
    expect(report.generalization!.heldOutSize).toBeGreaterThan(0)
  })
})

// helper: tiny dataset wrapper (avoids name clash with main describe)
function runInsightSampling_experiment_tiny(data: Observation[]) {
  return runInsightSamplingExperiment('exp_tiny', data)
}

describe('InsightSamplingExperiment — reportToExperimentRuns', () => {
  it('converts report to ExperimentRun list', () => {
    const data = makeDataset()
    const report = runInsightSamplingExperiment('exp_runs', data)
    const runs = reportToExperimentRuns(report)
    expect(runs.length).toBe(5)
    expect(runs.every((r) => r.outcome === 'success' || r.outcome === 'failure' || r.outcome === 'inconclusive')).toBe(true)
    expect(runs[0].assignment).toBe('baseline')
  })
})
