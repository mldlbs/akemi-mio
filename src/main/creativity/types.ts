/**
 * 生成策略 — 在 ConceptMixer 之前选择，约束配对空间
 * - stable:   同类型组合，禁止 novelty bonus 主导，输出收敛
 * - explore:  跨类型组合，提高 diversity weight，允许结构差异
 * - signal:   强制注入 trend/ provocation/insight 来源，限制 randomness
 */
export type Strategy = 'stable' | 'explore' | 'signal'

export interface CreativitySource {
  name: string
  content: string
  type: 'knowledge' | 'behavior' | 'insight' | 'failure' | 'random' | 'provocation'
  weight: number
}

export interface ConceptCombo {
  id: string
  sources: [string, string]
  description: string
  createdAt: number
}

export interface Hypothesis {
  id: string
  title: string
  idea: string
  expectedBenefit: string
  risk: string
  sourceLabels: string[]
  novelty: number
  feasibility: number
  impact: number
  status: 'draft' | 'active' | 'experimenting' | 'validated' | 'rejected'
  createdAt: number
  /** 实现难度 1-5（LLM 生成） */
  implementationDifficulty?: number
  /** 预计开发时间（LLM 生成，如 "1-2天"） */
  estimatedDevTime?: string
  /** 多视角评估（LLM 生成） */
  perspectives?: {
    self: string
    user: string
    maintainer: string
  }
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
export const DREAM_CYCLE_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h
export const NORMAL_CYCLE_INTERVAL_MS = 60 * 60 * 1000 // 1h
