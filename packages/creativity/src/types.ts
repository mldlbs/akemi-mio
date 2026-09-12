/**
 * 生成策略 �?�?ConceptMixer 之前选择，约束配对空�?
 * - stable:   同类型组合，禁止 novelty bonus 主导，输出收�?
 * - explore:  跨类型组合，提高 diversity weight，允许结构差�?
 * - signal:   强制注入 trend/ provocation/insight 来源，限�?randomness
 */
export type Strategy = 'stable' | 'explore' | 'signal'

export interface CreativitySource {
  name: string
  content: string
  fullContent?: string
  sourceDepth?: 'shallow' | 'medium' | 'full'
  type: 'knowledge' | 'behavior' | 'insight' | 'failure' | 'random' | 'provocation' | 'feedback'
  weight: number
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
  score?: { novelty: number; feasibility: number; impact: number }
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
  status: 'draft' | 'active' | 'experimenting' | 'validated' | 'rejected'
  createdAt: number
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
