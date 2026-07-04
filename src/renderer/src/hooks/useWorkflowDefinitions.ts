import { useEffect, useCallback } from 'react'
import { useIPCEvent } from './useIPCEvent'
import { useWorkflowStore } from '../store/workflowStore'
import { isWorkflowActive, isStepActive } from '../workflow/workflowTypes'
import type { WorkflowEvent, StepRun } from '../workflow/workflowTypes'

export function useWorkflowDefinitions() {
  const store = useWorkflowStore()

  const refresh = useCallback(() => {
    Promise.all([window.electronAPI.listWorkflowDefinitions(), window.electronAPI.listWorkflowRuns(20)]).then(([defs, runList]) => {
      store.setDefinitions(defs)
      store.setLoading(false)
      // Hydrate initial runs from list via workflow.created events
      for (const run of runList) {
        const steps: StepRun[] = (run.steps || []).map((s: any) => {
          if (s.status === 'running' || s.status === 'in_progress') {
            return { status: 'running', stepId: s.stepId, startedAt: s.startedAt ?? Date.now() }
          }
          if (s.status === 'done' || s.status === 'completed') {
            return {
              status: 'done',
              stepId: s.stepId,
              startedAt: s.startedAt ?? Date.now(),
              endedAt: s.completedAt ?? Date.now(),
              agentResult: s.agentResult,
            }
          }
          if (s.status === 'failed') {
            return {
              status: 'failed',
              stepId: s.stepId,
              startedAt: s.startedAt ?? Date.now(),
              endedAt: s.completedAt ?? Date.now(),
              error: s.error,
            }
          }
          if (s.status === 'skipped') {
            return { status: 'skipped', stepId: s.stepId, startedAt: s.startedAt ?? Date.now(), endedAt: s.completedAt ?? Date.now() }
          }
          return { status: 'pending', stepId: s.stepId }
        })
        store.addWorkflowEvent({
          type: 'workflow.created',
          runId: run.runId,
          workflowDefId: run.workflowDefId,
          workflowName: run.workflowName || '',
          steps,
          timestamp: run.startedAt || Date.now(),
        })
      }
    })
  }, [store])

  useEffect(() => {
    if (store.loading) refresh()
  }, [store.loading, refresh])

  useIPCEvent(window.electronAPI.onWorkflowRunCreated, (data: any) => {
    const steps: StepRun[] = (data.steps || []).map((s: any) => ({
      stepId: s.stepId,
      status: 'pending' as const,
    }))
    store.addWorkflowEvent({
      type: 'workflow.created',
      runId: data.runId,
      workflowDefId: data.workflowDefId,
      workflowName: data.workflowName || '',
      steps,
      timestamp: data.startedAt || Date.now(),
    })
  })

  useIPCEvent(window.electronAPI.onWorkflowDefCreated, () => {
    window.electronAPI.listWorkflowDefinitions().then((defs) => store.setDefinitions(defs))
  })

  useIPCEvent(window.electronAPI.onWorkflowRunUpdated, (data) => {
    const ts = Date.now()
    const status = data.status
    if (status === 'running') {
      store.addWorkflowEvent({ type: 'workflow.started', runId: data.runId, timestamp: ts })
    } else if (status === 'done' || status === 'completed') {
      store.addWorkflowEvent({ type: 'workflow.completed', runId: data.runId, timestamp: ts })
    } else if (status === 'failed') {
      store.addWorkflowEvent({ type: 'workflow.failed', runId: data.runId, error: data.error || 'unknown', timestamp: ts })
    } else if (status === 'paused') {
      store.addWorkflowEvent({ type: 'workflow.paused', runId: data.runId, timestamp: ts })
    }
  })

  useIPCEvent(window.electronAPI.onWorkflowRunStep, (data) => {
    const ts = Date.now()
    const status = data.status
    if (status === 'running' || status === 'in_progress') {
      store.addWorkflowEvent({ type: 'step.started', runId: data.runId, stepId: data.stepId, timestamp: ts })
    } else if (status === 'done' || status === 'completed') {
      store.addWorkflowEvent({
        type: 'step.completed',
        runId: data.runId,
        stepId: data.stepId,
        agentResult: data.agentResult || '',
        timestamp: ts,
      })
    } else if (status === 'failed') {
      store.addWorkflowEvent({ type: 'step.failed', runId: data.runId, stepId: data.stepId, error: data.error || 'unknown', timestamp: ts })
    } else if (status === 'skipped') {
      store.addWorkflowEvent({ type: 'step.skipped', runId: data.runId, stepId: data.stepId, timestamp: ts })
    }
  })

  const activeRuns = store.workflowRuns.filter(isWorkflowActive)

  return {
    definitions: store.definitions,
    workflowRuns: store.workflowRuns,
    activeRuns,
    loading: store.loading,
    refresh,
  }
}
