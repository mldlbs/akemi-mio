/**
 * FeedbackLearning — 正向反馈闭环离线学习核心（设计 v1.0，P1）
 *
 * 纯计算，不碰 DB、不写 Memory、不改假设状态、不进晋级门输入。
 * 输入规范化证据事件 + 假设 provenance，输出：
 *   - ConceptPairWeight：概念对 × 三维度（选择/质量/落地）加权证据
 *   - FeedbackSnapshot：不可变 + 版本号（sha256 前 12 位）
 *   - 离线回放：原始 vs 反馈策略的逐对调整与证据追溯
 *
 * 评审决议（spec §十三）落地：
 *   §13.2 带权 Beta 变体：衰减后计数为小数，不取整（取整顺序相关会破坏 reproducibility）。
 *   §13.3 三维度归一分母 = 该维度 S_d + F_d，不跨维度、不用假设数；无事件维度取先验均值。
 *   §13.1 batch 身份：experimentRunId 优先，否则 hypothesisId（或 implemented 的 commitSha）。
 *   §13.4 快照只带结构化字段，禁止 raw 事件正文。
 */

import { createHash } from 'crypto'
import {
  FEEDBACK_EVENT_SCHEMA_VERSION,
  feedbackEvidenceDimension,
  type HypothesisFeedbackEvent,
  type HypothesisFeedbackEventType,
} from './FeedbackEvents'

export type FeedbackDimension = 'selection' | 'quality' | 'landing' | 'negative'

export const POSITIVE_DIMENSIONS: readonly FeedbackDimension[] = ['selection', 'quality', 'landing']

export interface DimensionEstimate {
  /** 衰减后的正向证据计数（小数，带权 Beta 变体） */
  positiveCount: number
  /** 衰减后的负向证据计数（小数） */
  negativeCount: number
  /** 原始事件数（未衰减，用于追溯） */
  evidenceCount: number
  /** Beta 后验均值 θ_d = (α0+S_d)/(α0+β0+S_d+F_d)；无事件时 = 先验均值 */
  posteriorMean: number
  /** 置信度 = (S+F)/(S+F+α0+β0)，先验信息之外的占比 */
  confidence: number
  /** 该维度最近证据时间，epoch ms */
  lastEvidenceAt: number
}

export type AttributionKind = 'pair' | 'hypothesis_only'

export interface ConceptPairWeight {
  conceptAId: string
  conceptBId: string
  /** 规范化 pair key（已排序），用于跨实现稳定对齐 */
  pairKey: string
  /** 归因级别：pair=可归因到概念对；hypothesis_only=provenance 缺失 */
  attribution: AttributionKind
  selection: DimensionEstimate
  quality: DimensionEstimate
  landing: DimensionEstimate
  negative: DimensionEstimate
  lastEvidenceAt: number
  /** 产出该权重的快照版本（由 buildFeedbackSnapshot 回填） */
  feedbackSnapshotVersion?: string
}

export interface FeedbackLearningConfig {
  /** 时间衰减半衰期（天），w(t)=2^(-Δt/H) */
  halfLifeDays: number
  /** Beta 先验参数 */
  alpha0: number
  beta0: number
  /** 置信度下限所需的最小样本数（参考量） */
  minSamples: number
  /** 每类事件的证据权重上限（初始实验参数，spec §五.0/§13.3） */
  weightCaps: {
    validated: number
    adopted: number
    implemented: number
    rejected: number
    regression_failed: number
  }
  /** 归因覆盖率低于此值时，只启用假设级归因（R5） */
  attributionMinCoverage: number
  /** 探索预算比例（P2 消费，快照 hash 必须含） */
  explorationBudget: number
  /** λ clamp 占总评分范围百分比（P2 消费，快照 hash 必须含） */
  lambdaClampPct: number
}

export const DEFAULT_FEEDBACK_LEARNING_CONFIG: FeedbackLearningConfig = {
  halfLifeDays: 30,
  alpha0: 1,
  beta0: 1,
  minSamples: 30,
  weightCaps: {
    validated: 0.5,
    adopted: 0.2,
    implemented: 0.3,
    rejected: 1.0,
    regression_failed: 1.0,
  },
  attributionMinCoverage: 0.3,
  explorationBudget: 0.2,
  lambdaClampPct: 0.1,
}

export interface HypothesisProvenanceLike {
  sources?: Array<{ name: string; type: string; origin?: string; timestamp?: string }>
}

/** 单条事件对某维度的贡献权重（未衰减）。负向事件归 negative 维度。 */
export function evidenceWeight(eventType: HypothesisFeedbackEventType, caps: FeedbackLearningConfig['weightCaps']): number {
  switch (eventType) {
    case 'validated':
      return caps.validated
    case 'adopted':
      return caps.adopted
    case 'implemented':
      return caps.implemented
    case 'rejected':
      return caps.rejected
    case 'regression_failed':
      return caps.regression_failed
    default:
      return 1
  }
}

export function isNegativeEvent(eventType: HypothesisFeedbackEventType): boolean {
  return eventType === 'rejected' || eventType === 'regression_failed'
}

/** 时间衰减 w(t) = 2^(-Δt/H)，Δt 以天为单位；未来事件不放大。 */
export function timeDecay(occurredAt: number, now: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 1
  const dtDays = Math.max(0, (now - occurredAt) / 86_400_000)
  return Math.pow(2, -dtDays / halfLifeDays)
}

/** 概念身份：取 origin（稳定字段），缺失时回退 name 并标记 hypothesis_only。 */
export function conceptIdOf(source: { name: string; origin?: string }): string {
  return source.origin && source.origin.trim() ? source.origin.trim() : `name:${source.name}`
}

export function pairKeyOf(a: string, b: string): string {
  return [a, b].sort().join('|')
}

/** 稳定序列化：对象键排序、数组保序，保证跨平台 hash 一致。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
}

export function hashPrefix(input: string, length = 12): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, length)
}

export interface EvidenceTraceEntry {
  hypothesisId: string
  eventType: HypothesisFeedbackEventType
  sourceId: string
  pairKey: string
  dimension: FeedbackDimension
  weight: number
  batchKey: string
  duplicate: boolean
}

export interface AggregateResult {
  pairs: ConceptPairWeight[]
  /** 正向事件中可归因到概念对的比例（R5） */
  attributionCoverage: number
  /** 重复事件造成的重复加权比例（去重后为 0；验收指标） */
  duplicateApplicationRate: number
  appliedCount: number
  /** 被去重抑制的重复事件数（可观测，非验收指标） */
  dedupedEventCount: number
  /** 逐事件证据追溯 */
  trace: EvidenceTraceEntry[]
}

function emptyEstimate(alpha0: number, beta0: number): DimensionEstimate {
  return {
    positiveCount: 0,
    negativeCount: 0,
    evidenceCount: 0,
    posteriorMean: alpha0 / (alpha0 + beta0),
    confidence: 0,
    lastEvidenceAt: 0,
  }
}

function batchKeyOf(event: HypothesisFeedbackEvent): string {
  return event.experimentRunId || (event.commitSha ? `commit:${event.commitSha}` : event.hypothesisId)
}

/** 稳定排序（locale 不敏感、字段序固定）——reproducibility 前提。 */
function sortEvents(events: HypothesisFeedbackEvent[]): HypothesisFeedbackEvent[] {
  return [...events].sort((a, b) => {
    if (a.hypothesisId !== b.hypothesisId) return a.hypothesisId < b.hypothesisId ? -1 : 1
    if (a.eventType !== b.eventType) return a.eventType < b.eventType ? -1 : 1
    if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1
    return a.occurredAt - b.occurredAt
  })
}

function isAttributable(sources: HypothesisProvenanceLike['sources']): boolean {
  if (!sources || sources.length < 2) return false
  return sources.filter((s) => s.origin && s.origin.trim()).length >= 2
}

/**
 * 聚合概念对权重。
 *
 * @param events 规范化后的证据事件（可乱序；内部稳定排序）
 * @param hypotheses hypothesisId → provenance（用于概念对归因）
 * @param config 学习配置
 * @param now 评估时刻，epoch ms
 */
export function aggregateConceptPairWeights(
  events: HypothesisFeedbackEvent[],
  hypotheses: Record<string, HypothesisProvenanceLike | undefined>,
  config: FeedbackLearningConfig = DEFAULT_FEEDBACK_LEARNING_CONFIG,
  now: number = Date.now(),
): AggregateResult {
  const sorted = sortEvents(events)
  const pairMap = new Map<string, ConceptPairWeight>()
  // (pairKey, dimension, batchKey) → 衰减后最大权重；同源事件不伪造样本量
  const slotMap = new Map<string, Slot>()
  const trace: EvidenceTraceEntry[] = []
  let positiveAttributed = 0
  let positiveTotal = 0
  let appliedCount = 0
  let dedupedEventCount = 0
  let naiveWeightApplied = 0
  let duplicateWeightApplied = 0

  const getPair = (pairKey: string, attribution: AttributionKind): ConceptPairWeight => {
    let pair = pairMap.get(pairKey)
    if (!pair) {
      const [conceptAId, conceptBId] = pairKey.split('|')
      pair = {
        conceptAId,
        conceptBId,
        pairKey,
        attribution,
        selection: emptyEstimate(config.alpha0, config.beta0),
        quality: emptyEstimate(config.alpha0, config.beta0),
        landing: emptyEstimate(config.alpha0, config.beta0),
        negative: emptyEstimate(config.alpha0, config.beta0),
        lastEvidenceAt: 0,
      }
      pairMap.set(pairKey, pair)
    }
    return pair
  }

  for (const event of sorted) {
    const dimension = feedbackEvidenceDimension(event.eventType)
    const weight = evidenceWeight(event.eventType, config.weightCaps)
    const batchKey = batchKeyOf(event)
    const provenance = hypotheses[event.hypothesisId]
    const sources = provenance?.sources
    const attributable = isAttributable(sources)

    if (!isNegativeEvent(event.eventType)) {
      positiveTotal++
      if (attributable) positiveAttributed++
    }

    if (!attributable) {
      // 无 provenance：只记假设级，不归因到对（R5）
      const pairKey = `hypothesis:${event.hypothesisId}`
      const pair = getPair(pairKey, 'hypothesis_only')
      const est = pair[dimension]
      est.evidenceCount += 1
      const decayed = weight * timeDecay(event.occurredAt, now, config.halfLifeDays)
      if (isNegativeEvent(event.eventType)) est.negativeCount += decayed
      else est.positiveCount += decayed
      if (event.occurredAt > pair.lastEvidenceAt) pair.lastEvidenceAt = event.occurredAt
      appliedCount++
      naiveWeightApplied += decayed
      trace.push({
        hypothesisId: event.hypothesisId,
        eventType: event.eventType,
        sourceId: event.sourceId,
        pairKey,
        dimension,
        weight: decayed,
        batchKey,
        duplicate: false,
      })
      continue
    }

    // 有 provenance：来源两两构成贡献概念对
    const ids = sources!.map(conceptIdOf)
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = pairKeyOf(ids[i], ids[j])
        const slotKey = `${key}\u0000${dimension}\u0000${batchKey}`
        const decayed = weight * timeDecay(event.occurredAt, now, config.halfLifeDays)
        const existing = slotMap.get(slotKey)
        const duplicate = !!existing && existing.weight >= decayed
        if (duplicate) {
          dedupedEventCount++
          duplicateWeightApplied += 0 // 去重后不重复加权
        } else {
          slotMap.set(slotKey, { weight: decayed, batchKey, dimension, lastEvidenceAt: event.occurredAt })
          appliedCount++
          naiveWeightApplied += decayed
        }
        trace.push({
          hypothesisId: event.hypothesisId,
          eventType: event.eventType,
          sourceId: event.sourceId,
          pairKey: key,
          dimension,
          weight: duplicate ? 0 : decayed,
          batchKey,
          duplicate,
        })
      }
    }
  }

  // slot 汇总到 pair 的维度估计（跨 batch 求和，已按 batch 去重）
  for (const [slotKey, slot] of slotMap) {
    const [pairKey, dimension] = slotKey.split('\u0000') as [string, FeedbackDimension]
    const pair = getPair(pairKey, 'pair')
    const est = pair[dimension]
    if (isNegativeEventDimension(dimension)) est.negativeCount += slot.weight
    else est.positiveCount += slot.weight
    if (slot.lastEvidenceAt > est.lastEvidenceAt) est.lastEvidenceAt = slot.lastEvidenceAt
    if (slot.lastEvidenceAt > pair.lastEvidenceAt) pair.lastEvidenceAt = slot.lastEvidenceAt
  }

  // 回填每维度 evidenceCount（原始事件数）与后验/置信度
  const rawCounts = countRawEvidence(sorted, hypotheses)
  for (const pair of pairMap.values()) {
    applyPosterior(pair, config)
    const rc = rawCounts.get(pair.pairKey)
    if (rc) {
      pair.selection.evidenceCount = rc.selection
      pair.quality.evidenceCount = rc.quality
      pair.landing.evidenceCount = rc.landing
      pair.negative.evidenceCount = rc.negative
    }
  }

  const pairs = [...pairMap.values()].sort((a, b) => (a.pairKey < b.pairKey ? -1 : a.pairKey > b.pairKey ? 1 : 0))
  return {
    pairs,
    attributionCoverage: positiveTotal === 0 ? 1 : positiveAttributed / positiveTotal,
    duplicateApplicationRate: naiveWeightApplied === 0 ? 0 : duplicateWeightApplied / naiveWeightApplied,
    appliedCount,
    dedupedEventCount,
    trace,
  }
}

interface Slot {
  weight: number
  batchKey: string
  dimension: FeedbackDimension
  lastEvidenceAt: number
}

function isNegativeEventDimension(d: FeedbackDimension): boolean {
  return d === 'negative'
}

function applyPosterior(pair: ConceptPairWeight, config: FeedbackLearningConfig): void {
  for (const d of [...POSITIVE_DIMENSIONS, 'negative'] as FeedbackDimension[]) {
    const est = pair[d]
    const s = est.positiveCount
    const f = est.negativeCount
    est.posteriorMean = (config.alpha0 + s) / (config.alpha0 + config.beta0 + s + f)
    est.confidence = (s + f) / (s + f + config.alpha0 + config.beta0)
  }
}

function countRawEvidence(
  events: HypothesisFeedbackEvent[],
  hypotheses: Record<string, HypothesisProvenanceLike | undefined>,
): Map<string, Record<FeedbackDimension, number>> {
  const counts = new Map<string, Record<FeedbackDimension, number>>()
  const bump = (pairKey: string, d: FeedbackDimension) => {
    let c = counts.get(pairKey)
    if (!c) {
      c = { selection: 0, quality: 0, landing: 0, negative: 0 }
      counts.set(pairKey, c)
    }
    c[d]++
  }
  for (const event of events) {
    const d = feedbackEvidenceDimension(event.eventType)
    const sources = hypotheses[event.hypothesisId]?.sources
    if (!isAttributable(sources)) {
      bump(`hypothesis:${event.hypothesisId}`, d)
      continue
    }
    const ids = sources!.map(conceptIdOf)
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        bump(pairKeyOf(ids[i], ids[j]), d)
      }
    }
  }
  return counts
}

export interface FeedbackSnapshot {
  /** 不可变版本号 = sha256(排序后规范化事件窗口 + 配置 + schemaVersion) 前 12 位 */
  version: string
  configHash: string
  generatedAt: number
  eventCount: number
  attributionCoverage: number
  duplicateApplicationRate: number
  /** 被去重抑制的重复事件数（可观测） */
  dedupedEventCount: number
  pairs: ConceptPairWeight[]
}

/**
 * 构建不可变快照。同输入 + 同配置 + 同版本 → 同 hash（100% 可复现）。
 */
export function buildFeedbackSnapshot(
  events: HypothesisFeedbackEvent[],
  hypotheses: Record<string, HypothesisProvenanceLike | undefined>,
  config: FeedbackLearningConfig = DEFAULT_FEEDBACK_LEARNING_CONFIG,
  now: number = Date.now(),
): FeedbackSnapshot {
  const aggregate = aggregateConceptPairWeights(events, hypotheses, config, now)
  const configHash = hashPrefix(canonicalJson(config), 12)
  const window = canonicalJson({
    schemaVersion: FEEDBACK_EVENT_SCHEMA_VERSION,
    now,
    events: sortEvents(events)
      .map((e) => ({
        hypothesisId: e.hypothesisId,
        eventType: e.eventType,
        sourceId: e.sourceId,
        sourceType: e.sourceType,
        commitSha: e.commitSha ?? null,
        experimentRunId: e.experimentRunId ?? null,
        occurredAt: e.occurredAt,
        idempotencyKey: e.idempotencyKey,
      })),
    config,
  })
  const version = hashPrefix(window, 12)
  const pairs = aggregate.pairs.map((p) => ({ ...p, feedbackSnapshotVersion: version }))
  return {
    version,
    configHash,
    generatedAt: now,
    eventCount: events.length,
    attributionCoverage: aggregate.attributionCoverage,
    duplicateApplicationRate: aggregate.duplicateApplicationRate,
    dedupedEventCount: aggregate.dedupedEventCount,
    pairs,
  }
}

export interface FeedbackAdjustment {
  pairKey: string
  /** 综合调整 ∈ [-1, 1] */
  adjustment: number
  evidenceCount: number
  posteriorMean: number
  confidence: number
  /** λ clamp 后的调整（占总评分范围的比例上限） */
  clampedAdjustment: number
}

/**
 * 离线回放：给定概念对权重，计算有界反馈调整（λ clamp）。
 * 不读 DB、不写任何状态；供 P2 接入 ConceptMixer 前做离线对比。
 */
export function replayFeedbackAdjustment(
  weight: ConceptPairWeight,
  config: FeedbackLearningConfig = DEFAULT_FEEDBACK_LEARNING_CONFIG,
): FeedbackAdjustment {
  let pos = 0
  let conf = 0
  let evidence = 0
  for (const d of POSITIVE_DIMENSIONS) {
    const est = weight[d]
    pos += est.posteriorMean * est.confidence
    conf += est.confidence
    evidence += est.evidenceCount
  }
  const posMean = conf > 0 ? pos / conf : 0.5
  const negMean = weight.negative.posteriorMean
  // 正向证据把分数拉向 +1，负向证据拉向 -1；无正向证据时取先验中性 0.5
  const adjustment = Math.max(-1, Math.min(1, (posMean - 0.5) * 2 - negMean))
  const clamp = Math.max(0, config.lambdaClampPct)
  return {
    pairKey: weight.pairKey,
    adjustment,
    evidenceCount: evidence,
    posteriorMean: posMean,
    confidence: conf,
    clampedAdjustment: adjustment * clamp,
  }
}
