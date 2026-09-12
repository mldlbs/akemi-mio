import { create } from 'zustand'
import type { WorkflowState, WorkflowEvent, StepRun } from '../workflow/workflowTypes'
import {
  createRun,
  transitionToRunning,
  transitionToDone,
  transitionToFailed,
  transitionToCancelled,
  transitionToPaused,
  transitionToResumed,
  transitionStepToRunning,
  transitionStepToDone,
  transitionStepToFailed,
  transitionStepToSkipped,
} from '../workflow/workflowTypes'

export interface WorkflowDef {
  id: string
  name: string
  description: string
  steps: any[]
  createdAt: number
  updatedAt: number
  /** 是否启用。与后端 packages/capabilities/src/workflow/types.ts 的定义保持一致（可选） */
  enabled?: boolean
}

interface WorkflowStateData {
  definitions: WorkflowDef[]
  workflowRuns: WorkflowState[]
  loading: boolean
}

interface WorkflowActions {
  setDefinitions: (defs: WorkflowDef[]) => void
  setLoading: (loading: boolean) => void
  addWorkflowEvent: (event: WorkflowEvent) => void
}

type WorkflowStore = WorkflowStateData & WorkflowActions

export const useWorkflowStore = create<WorkflowStore>((set) => ({
  definitions: [],
  workflowRuns: [],
  loading: true,

  setDefinitions: (definitions) => set({ definitions }),
  setLoading: (loading) => set({ loading }),

  addWorkflowEvent: (event) =>
    set((s) => {
      const { workflowRuns } = s

      // New run from a created event
      if (event.type === 'workflow.created') {
        if (workflowRuns.some((r) => r.runId === event.runId)) return s
        const pending = createRun(event)
        // IPC always creates runs as already running — chain pending → running
        const running = transitionToRunning(pending, {
          type: 'workflow.started',
          runId: event.runId,
          timestamp: event.timestamp,
        })
        return { workflowRuns: [running, ...workflowRuns].slice(0, 20) }
      }

      // Existing run — find it and apply transition
      const idx = workflowRuns.findIndex((r) => r.runId === event.runId)
      if (idx === -1) return s

      const existing = workflowRuns[idx]
      let next: WorkflowState | null = null

      switch (event.type) {
        case 'workflow.started':
          next = transitionToRunning(existing, event)
          break
        case 'workflow.completed':
          next = transitionToDone(existing, event)
          break
        case 'workflow.failed':
          next = transitionToFailed(existing, event)
          break
        case 'workflow.cancelled':
          next = transitionToCancelled(existing, event)
          break
        case 'workflow.paused':
          next = transitionToPaused(existing, event)
          break
        case 'workflow.resumed':
          next = transitionToResumed(existing, event)
          break
        case 'step.started':
          next = transitionStepToRunning(existing, event)
          break
        case 'step.completed':
          next = transitionStepToDone(existing, event)
          break
        case 'step.failed':
          next = transitionStepToFailed(existing, event)
          break
        case 'step.skipped':
          next = transitionStepToSkipped(existing, event)
          break
      }

      if (!next) return s
      const updated = [...workflowRuns]
      updated[idx] = next
      return { workflowRuns: updated }
    }),
}))
