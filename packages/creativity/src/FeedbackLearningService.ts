/**
 * FeedbackLearningService — 正向反馈闭环 DB 侧服务（设计 v1.0，P1）
 *
 * 只读：从权威 SQLite 读证据事件 + 假设 provenance → 不可变快照 → 离线回放。
 * 不写证据层、不写 Memory、不改假设状态、不进晋级门输入。
 *
 * 仓内专用（依赖 @akemi-mio/core/db/connection），不进 npm 构建，
 * 与 DrizzleIdeaStore / DrizzleFeedbackEventStore 同构，靠 monorepo paths 解析。
 */

import { DrizzleFeedbackEventStore } from './DrizzleFeedbackEventStore'
import { DrizzleIdeaStore } from './DrizzleIdeaStore'
import {
  aggregateConceptPairWeights,
  buildFeedbackSnapshot,
  replayFeedbackAdjustment,
  DEFAULT_FEEDBACK_LEARNING_CONFIG,
  type ConceptPairWeight,
  type FeedbackAdjustment,
  type FeedbackLearningConfig,
  type FeedbackSnapshot,
  type HypothesisProvenanceLike,
} from './FeedbackLearning'
import type { HypothesisFeedbackEvent } from './FeedbackEvents'

export interface FeedbackLearningServiceOptions {
  config?: FeedbackLearningConfig
  /** 评分范围（用于把 λ clamp 折算成绝对分）；缺省 100。P2 接入 ConceptMixer 时可传实际范围。 */
  scoreRange?: number
  /** 注入自定义事件源（测试用）；缺省用 DrizzleFeedbackEventStore。 */
  eventStore?: Pick<DrizzleFeedbackEventStore, 'list'>
  /** 注入自定义假设源（测试用）；缺省用 DrizzleIdeaStore。 */
  ideaStore?: Pick<DrizzleIdeaStore, 'getHypotheses'>
  now?: number
}

export interface ReplayComparison {
  pairKey: string
  attribution: ConceptPairWeight['attribution']
  baseScore: number
  feedbackScore: number
  delta: number
  evidenceCount: number
  posteriorMean: number
  confidence: number
  clampedAdjustment: number
}

export interface ReplayReport {
  version: string
  configHash: string
  generatedAt: number
  eventCount: number
  attributionCoverage: number
  duplicateApplicationRate: number
  dedupedEventCount: number
  comparisons: ReplayComparison[]
  /** 权重变化可回溯的原始证据条数 */
  traceableEvidenceCount: number
}

function hypothesisMap(
  hypotheses: Array<{ id: string; provenance?: HypothesisProvenanceLike }>,
): Record<string, HypothesisProvenanceLike | undefined> {
  const map: Record<string, HypothesisProvenanceLike | undefined> = {}
  for (const h of hypotheses) map[h.id] = h.provenance ? { sources: h.provenance.sources } : undefined
  return map
}

export class FeedbackLearningService {
  private readonly config: FeedbackLearningConfig
  private readonly scoreRange: number
  private readonly eventStore: Pick<DrizzleFeedbackEventStore, 'list'>
  private readonly ideaStore: Pick<DrizzleIdeaStore, 'getHypotheses'>
  private readonly now: number

  constructor(options: FeedbackLearningServiceOptions = {}) {
    this.config = options.config ?? DEFAULT_FEEDBACK_LEARNING_CONFIG
    this.scoreRange = options.scoreRange ?? 100
    this.eventStore = options.eventStore ?? new DrizzleFeedbackEventStore()
    this.ideaStore = options.ideaStore ?? new DrizzleIdeaStore()
    this.now = options.now ?? Date.now()
  }

  private readEvents(): HypothesisFeedbackEvent[] {
    return this.eventStore.list()
  }

  private readHypotheses(): Record<string, HypothesisProvenanceLike | undefined> {
    return hypothesisMap(this.ideaStore.getHypotheses())
  }

  /** 权威快照：同输入/配置 → 同版本。 */
  buildSnapshot(): FeedbackSnapshot {
    return buildFeedbackSnapshot(this.readEvents(), this.readHypotheses(), this.config, this.now)
  }

  /** 归因覆盖率（R5）：有 provenance 的正向事件占比。 */
  attributionCoverage(): number {
    return aggregateConceptPairWeights(this.readEvents(), this.readHypotheses(), this.config, this.now)
      .attributionCoverage
  }

  /**
   * 离线回放：给定 baseScore（pairKey → 分），输出反馈调整后的分数与逐对证据。
   * 不写任何状态；仅用于 P2 接入前的策略对比。
   */
  replay(baseScores: Map<string, number> | Record<string, number> = {}): ReplayReport {
    const events = this.readEvents()
    const hypotheses = this.readHypotheses()
    const aggregate = aggregateConceptPairWeights(events, hypotheses, this.config, this.now)
    const base =
      baseScores instanceof Map ? baseScores : new Map(Object.entries(baseScores).map(([k, v]) => [k, v]))
    const weightByKey = new Map(aggregate.pairs.map((p) => [p.pairKey, p]))

    const comparisons: ReplayComparison[] = []
    let traceable = 0
    for (const [pairKey, baseScore] of base) {
      const weight = weightByKey.get(pairKey)
      if (!weight) {
        comparisons.push({
          pairKey,
          attribution: 'hypothesis_only',
          baseScore,
          feedbackScore: baseScore,
          delta: 0,
          evidenceCount: 0,
          posteriorMean: 0.5,
          confidence: 0,
          clampedAdjustment: 0,
        })
        continue
      }
      const adjustment: FeedbackAdjustment = replayFeedbackAdjustment(weight, this.config)
      traceable += adjustment.evidenceCount
      comparisons.push({
        pairKey,
        attribution: weight.attribution,
        baseScore,
        feedbackScore: baseScore + adjustment.clampedAdjustment * this.scoreRange,
        delta: adjustment.clampedAdjustment * this.scoreRange,
        evidenceCount: adjustment.evidenceCount,
        posteriorMean: adjustment.posteriorMean,
        confidence: adjustment.confidence,
        clampedAdjustment: adjustment.clampedAdjustment,
      })
    }
    comparisons.sort((a, b) => (a.pairKey < b.pairKey ? -1 : a.pairKey > b.pairKey ? 1 : 0))
    return {
      version: buildFeedbackSnapshot(events, hypotheses, this.config, this.now).version,
      configHash: buildFeedbackSnapshot(events, hypotheses, this.config, this.now).configHash,
      generatedAt: this.now,
      eventCount: events.length,
      attributionCoverage: aggregate.attributionCoverage,
      duplicateApplicationRate: aggregate.duplicateApplicationRate,
      dedupedEventCount: aggregate.dedupedEventCount,
      comparisons,
      traceableEvidenceCount: traceable,
    }
  }
}
