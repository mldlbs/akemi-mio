import { create } from 'zustand'

export interface WorkflowDef {
  id: string
  name: string
  description: string
  steps: any[]
  createdAt: number
  updatedAt: number
}

export interface WorkflowStepRun {
  stepId: string
  status: string
  agentResult?: string
  error?: string
  startedAt?: number
  completedAt?: number
}

export interface WorkflowRun {
  runId: string
  workflowDefId: string
  workflowName: string
  status: string
  steps: WorkflowStepRun[]
  startedAt: number
  completedAt?: number
}

interface WorkflowState {
  definitions: WorkflowDef[]
  runs: WorkflowRun[]
  loading: boolean
}

interface WorkflowActions {
  setDefinitions: (defs: WorkflowDef[]) => void
  setRuns: (runs: WorkflowRun[]) => void
  setLoading: (loading: boolean) => void
  addRun: (run: WorkflowRun) => void
  updateRunStatus: (runId: string, status: string) => void
  updateRunStep: (runId: string, stepId: string, data: Partial<WorkflowStepRun>) => void
}

type WorkflowStore = WorkflowState & WorkflowActions

export const useWorkflowStore = create<WorkflowStore>((set) => ({
  definitions: [],
  runs: [],
  loading: true,

  setDefinitions: (definitions) => set({ definitions }),
  setRuns: (runs) => set({ runs }),
  setLoading: (loading) => set({ loading }),
  addRun: (run) =>
    set((state) => ({
      runs: state.runs.some((r) => r.runId === run.runId) ? state.runs : [run, ...state.runs].slice(0, 20),
    })),
  updateRunStatus: (runId, status) =>
    set((state) => ({
      runs: state.runs.map((r) => (r.runId === runId ? { ...r, status } : r)),
    })),
  updateRunStep: (runId, stepId, data) =>
    set((state) => ({
      runs: state.runs.map((r) =>
        r.runId === runId ? { ...r, steps: r.steps.map((s) => (s.stepId === stepId ? { ...s, ...data } : s)) } : r,
      ),
    })),
}))
