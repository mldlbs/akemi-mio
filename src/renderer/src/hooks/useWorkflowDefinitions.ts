import { useEffect, useCallback } from 'react'
import { useIPCEvent } from './useIPCEvent'
import { useWorkflowStore } from '../store/workflowStore'
import type { WorkflowRun } from '../store/workflowStore'

export function useWorkflowDefinitions() {
  const store = useWorkflowStore()

  const refresh = useCallback(() => {
    Promise.all([window.electronAPI.listWorkflowDefinitions(), window.electronAPI.listWorkflowRuns(20)]).then(([defs, runList]) => {
      store.setDefinitions(defs)
      store.setRuns(runList)
      store.setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // 工作流新运行创建 → 直接使用事件携带的全量数据
  useIPCEvent(window.electronAPI.onWorkflowRunCreated, (data: any) => {
    store.addRun({
      runId: data.runId,
      workflowDefId: data.workflowDefId,
      workflowName: data.workflowName || '',
      status: 'running',
      steps: data.steps || [],
      startedAt: data.startedAt || Date.now(),
    })
  })

  // 工作流定义创建 → 全量刷新列表
  useIPCEvent(window.electronAPI.onWorkflowDefCreated, () => {
    window.electronAPI.listWorkflowDefinitions().then((defs) => store.setDefinitions(defs))
  })

  // 运行状态变更 → 原地更新
  useIPCEvent(window.electronAPI.onWorkflowRunUpdated, (data) => {
    store.updateRunStatus(data.runId, data.status)
  })

  // 步骤状态变更 → 原地更新（含 error / agentResult）
  useIPCEvent(window.electronAPI.onWorkflowRunStep, (data) => {
    store.updateRunStep(data.runId, data.stepId, {
      status: data.status,
      error: data.error,
      agentResult: data.agentResult,
    })
  })

  return {
    definitions: store.definitions,
    runs: store.runs,
    activeRuns: store.runs.filter((r) => r.status === 'running'),
    loading: store.loading,
    refresh,
  }
}
