import { useState, useEffect, useCallback } from 'react'
import { useIPCEvent } from './useIPCEvent'

interface WorkflowDef {
  id: string
  name: string
  description: string
  steps: any[]
  createdAt: number
  updatedAt: number
}

interface WorkflowStepRun {
  stepId: string
  status: string
  agentResult?: string
  error?: string
  startedAt?: number
  completedAt?: number
}

interface WorkflowRun {
  runId: string
  workflowDefId: string
  workflowName: string
  status: string
  steps: WorkflowStepRun[]
  startedAt: number
  completedAt?: number
}

export function useWorkflowDefinitions() {
  const [definitions, setDefinitions] = useState<WorkflowDef[]>([])
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(() => {
    Promise.all([window.electronAPI.listWorkflowDefinitions(), window.electronAPI.listWorkflowRuns(20)]).then(([defs, runList]) => {
      setDefinitions(defs)
      setRuns(runList)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // 工作流新运行创建 → 直接使用事件携带的全量数据
  useIPCEvent(window.electronAPI.onWorkflowRunCreated, (data: any) => {
    setRuns((prev) => {
      if (prev.some((r) => r.runId === data.runId)) return prev
      const run: WorkflowRun = {
        runId: data.runId,
        workflowDefId: data.workflowDefId,
        workflowName: data.workflowName || '',
        status: 'running',
        steps: data.steps || [],
        startedAt: data.startedAt || Date.now(),
      }
      return [run, ...prev].slice(0, 20)
    })
  })

  // 工作流定义创建 → 全量刷新列表
  useIPCEvent(window.electronAPI.onWorkflowDefCreated, () => {
    window.electronAPI.listWorkflowDefinitions().then(setDefinitions)
  })

  // 运行状态变更 → 原地更新
  useIPCEvent(window.electronAPI.onWorkflowRunUpdated, (data) => {
    setRuns((prev) => prev.map((r) => (r.runId === data.runId ? { ...r, status: data.status } : r)))
  })

  // 步骤状态变更 → 原地更新（含 error / agentResult）
  useIPCEvent(window.electronAPI.onWorkflowRunStep, (data) => {
    setRuns((prev) =>
      prev.map((r) =>
        r.runId === data.runId
          ? {
              ...r,
              steps: r.steps.map((s) =>
                s.stepId === data.stepId
                  ? { ...s, status: data.status, error: data.error ?? s.error, agentResult: data.agentResult ?? s.agentResult }
                  : s,
              ),
            }
          : r,
      ),
    )
  })

  const activeRuns = runs.filter((r) => r.status === 'running')

  return { definitions, runs, activeRuns, loading, refresh }
}
