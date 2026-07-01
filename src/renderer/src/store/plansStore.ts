import { create } from 'zustand'

export interface OtparEntry {
  type: 'observe' | 'think' | 'reflect'
  requestId: string
  step: number
  durationMs?: number
  timestamp: number
  detail: string
}

export interface PlanStepData {
  id: string
  description: string
  status: string
  result?: string
}

export interface PlanData {
  id: string
  title: string
  description: string
  steps: PlanStepData[]
  status: string
  createdAt: number
  updatedAt: number
}

interface PlansState {
  activePlan: PlanData | null
  planHistory: PlanData[]
  otparStages: OtparEntry[]
}

interface PlansActions {
  setActivePlan: (plan: PlanData | null) => void
  setPlanHistory: (history: PlanData[]) => void
  updateActivePlanStep: (stepIndex: number, status: string) => void
  completeActivePlan: () => void
  addOtparStage: (entry: OtparEntry) => void
}

type PlansStore = PlansState & PlansActions

export const usePlansStore = create<PlansStore>((set) => ({
  activePlan: null,
  planHistory: [],
  otparStages: [],

  setActivePlan: (activePlan) => set({ activePlan }),
  setPlanHistory: (planHistory) => set({ planHistory }),
  updateActivePlanStep: (stepIndex, status) =>
    set((state) => {
      if (!state.activePlan) return state
      return {
        activePlan: {
          ...state.activePlan,
          steps: state.activePlan.steps.map((s, i) => (i === stepIndex ? { ...s, status } : s)),
        },
      }
    }),
  completeActivePlan: () =>
    set((state) => ({
      activePlan: state.activePlan ? { ...state.activePlan, status: 'completed' } : null,
    })),
  addOtparStage: (entry) =>
    set((state) => ({
      otparStages: [...state.otparStages.slice(-19), entry],
    })),
}))
