export interface CreativitySource {
  name: string
  content: string
  type: 'knowledge' | 'behavior' | 'insight' | 'failure' | 'random'
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
}

export const CREATIVITY_STORE_VERSION = 1
export const DREAM_CYCLE_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h
export const NORMAL_CYCLE_INTERVAL_MS = 60 * 60 * 1000 // 1h
