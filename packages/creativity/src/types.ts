/**
 * 生成策略 �?�?ConceptMixer 之前选择，约束配对空�?
 * - stable:   同类型组合，禁止 novelty bonus 主导，输出收�?
 * - explore:  跨类型组合，提高 diversity weight，允许结构差�?
 * - signal:   强制注入 trend/ provocation/insight 来源，限�?randomness
 */
export type Strategy = 'stable' | 'explore' | 'signal'

/**
 * 规范化概念身份（正向反馈闭环 spec §五.2）：稳定字段 `origin` 优先，
 * `name` 仅作展示，缺失时回退 `name:<name>` 以避免与 origin 碰撞。
 * ConceptMixer 与 FeedbackLearning 共用此规则，防止双套身份漂移（R2）。
 */
export function sourceConceptId(s: { name: string; origin?: string }): string {
  const origin = s.origin ? s.origin.trim() : ''
  return origin || `name:${s.name}`
}

/** 规范化无序概念对键：(A,B) ≡ (B,A)。 */
export function conceptPairKey(a: string, b: string): string {
  return [a, b].sort().join('|')
}

export interface CreativitySource {
  name: string
  content: string
  fullContent?: string
  sourceDepth?: 'shallow' | 'medium' | 'full'
  type: 'knowledge' | 'behavior' | 'insight' | 'failure' | 'random' | 'provocation' | 'feedback'
  weight: number
  /** Provider + record id, e.g. `memory:mem_1791…`. Required on auto-aggregated sources (spec Capability 2). */
  origin?: string
  /** Original record id for back-referencing. */
  originId?: string
  /** 0-1 credibility hint; omit when unknowable. */
  confidence?: number
  /** Source record time, ISO 8601. */
  timestamp?: string
}

/** Where and how an idea.generate result was produced (spec Capability 1). */
export interface HypothesisProvenance {
  /** Pairing strategy used to build source combos: explore | stable | signal. */
  strategy?: string
  /** Rotation technique used for the prompt (mirrors `Hypothesis.technique`). */
  technique?: string
  /** Memory record ids that grounded the goal (0-3, newest first). */
  relatedMemoryIds?: string[]
  /** Assembled sources that fed generation, filtered to the labels actually used. */
  sources?: Array<{ name: string; type: string; origin?: string; timestamp?: string }>
  /** When the idea was generated, ISO 8601. */
  generatedAt?: string
}

export interface ConceptCombo {
  id: string
  sources: [string, string]
  description: string
  createdAt: number
}

export type FermentVerdict = 'promote' | 'keep' | 'reject' | 'merge'

export interface FermentLogEntry {
  at: number
  verdict: FermentVerdict
  reason: string
  score?: { novelty: number; feasibility: number; impact: number; logic?: number }
}

export interface HypothesisFermentationPatch {
  status?: Hypothesis['status']
  fermentCount?: number
  lastFermentedAt?: number
  fermentLog?: FermentLogEntry[]
  idea?: string
  novelty?: number
  feasibility?: number
  impact?: number
  logic?: number
  mergedInto?: string
}

export interface Hypothesis {
  id: string
  title: string
  idea: string
  expectedBenefit: string
  risk: string
  sourceLabels: string[]
  sourceDetails?: Array<{ name: string; depth: 'shallow' | 'medium' | 'full' }>
  novelty: number
  feasibility: number
  impact: number
  /** 逻辑一致性评分 0-100（第四维，评审/生成时打分，可缺省视为 50） */
  logic?: number
  status: 'draft' | 'active' | 'testing' | 'validated' | 'rejected'
  createdAt: number
  /** The rotation technique this hypothesis was generated with (idea.generate provenance.technique). */
  technique?: string
  /** Idea-generation provenance; `mio.idea.generate` persists this with the record. */
  provenance?: HypothesisProvenance
  /** 实现难度 1-5（LLM 生成�?*/
  implementationDifficulty?: number
  /** 预计开发时间（LLM 生成，如 "1-2�?�?*/
  estimatedDevTime?: string
  /** 多视角评估（LLM 生成�?*/
  perspectives?: {
    self: string
    user: string
    maintainer: string
  }
  /** 已发酵轮�?*/
  fermentCount?: number
  /** 最近发酵时间戳 */
  lastFermentedAt?: number
  /** 发酵历史记录 */
  fermentLog?: FermentLogEntry[]
  /** merge 后指向的�?hypothesis id */
  mergedInto?: string
  implementedCommitSha?: string
  implementedAt?: number
  implementationNote?: string
  /** 机制假设：提出的关系边（带 proposedRelations 即机制假设，否则普通创意） */
  proposedRelations?: ProposedRelation[]
  /** 证伪条件：命中任一条件则机制假设可被拒绝 */
  falsificationConditions?: string[]
  /** 触发本假设的 observation/trace id 溯源 */
  sourceObservationIds?: string[]
}

/** 机制图的一条候选边：A --[effect]--> B */
export interface ProposedRelation {
  from: string
  to: string
  effect: string
  /** 推断来源：identity=verified | inferred（A6 confidence 映射） */
  inference?: 'identity' | 'inferred'
}

export interface ExperimentPlan {
  hypothesisId: string
  title: string
  steps: string[]
  successCriteria: string[]
  estimatedDuration: string
  createdAt: number
}

export interface CreativeIdea {
  hypothesis: Hypothesis
  experiment: ExperimentPlan | null
}

export interface DreamCycleLog {
  timestamp: number
  sourcesExamined: number
  combosGenerated: number
  hypothesesGenerated: number
  topIdea: string | null
}

export interface IdeaStoreLike {
  addCombo: (combo: ConceptCombo) => void
  addHypothesis: (h: Hypothesis) => void
  addManyHypotheses: (hs: Hypothesis[]) => void
  addExperiment: (exp: ExperimentPlan) => void
  logDreamCycle: (entry: DreamCycleLog) => void
  getHypotheses: (options?: { status?: string; limit?: number }) => Hypothesis[]
  getNovelHypotheses: (threshold?: number, limit?: number) => Hypothesis[]
  getActiveExperiments: () => ExperimentPlan[]
  getRecentCombos: (limit?: number) => ConceptCombo[]
  getRecentDreamCycles: (limit?: number) => DreamCycleLog[]
  updateHypothesisStatus: (id: string, status: Hypothesis['status']) => boolean
  addExploredPair: (nameA: string, nameB: string) => void
  getExploredPairs: () => string[]
  resetExploredPairs: () => void
  count: () => { combos: number; hypotheses: number; experiments: number; dreamCycles: number }
  templateAdoptionStats: () => Record<string, { total: number; active: number; rejected: number; adopted: number }>
  adoptionReport: (limit?: number) => string
  getFermentableHypotheses: (limit?: number) => Hypothesis[]
  updateHypothesisFermentation: (id: string, patch: HypothesisFermentationPatch) => boolean
}

export interface CreativityStoreData {
  version: number
  combos: ConceptCombo[]
  hypotheses: Hypothesis[]
  experiments: ExperimentPlan[]
  dreamCycles: DreamCycleLog[]
  exploredPairs: string[]
}

export const CREATIVITY_STORE_VERSION = 2
export const DREAM_CYCLE_INTERVAL_MS = 30 * 60 * 1000 // 30min
export const NORMAL_CYCLE_INTERVAL_MS = 5 * 60 * 1000 // 5min
export const FERMENT_INTERVAL_MS = 10 * 60 * 1000 // 10min
/** 发酵与创意周期错峰偏移：避免同一时刻并发占用 code 模型上游 */
export const FERMENT_PHASE_OFFSET_MS = 2 * 60 * 1000 // 2min

/**
 * 外部信号 �?不进入配对空�?
 *
 * Observer 的外部数据在此层保持�?不可配对"的原始语义，
 * 直接注入 LLM 作为约束/挑战，而非组合概念�?
 *
 * �?CreativitySource 的关键区别：
 * - 不能进入 ConceptMixer
 * - 不参�?combinatorial pairing
 * - 不参�?scoring/ranking
 * - 只作�?prompt 中的"外部审视"�?
 */
export interface ExternalSignal {
  source: string
  raw: string
  type: 'trend' | 'event' | 'anomaly' | 'insight'
}
