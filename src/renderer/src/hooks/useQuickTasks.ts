/**
 * useQuickTasks — 快捷任务 React Hook
 *
 * 连接渲染进程的 QuickTaskStore 与主进程的 QuickTaskService：
 * - 订阅 IPC push 事件（推荐推送、状态更新）
 * - 提供执行/关闭/编辑等操作方法
 * - 初始时拉取全量任务列表
 */

import { useEffect, useCallback } from 'react'
import { useQuickTaskStore } from '../store/quickTaskStore'
import { useIPCEvent } from './useIPCEvent'
import type { QuickTaskStep } from '../store/quickTaskStore'

// =============================================================================
// Hook
// =============================================================================

export function useQuickTasks() {
  const store = useQuickTaskStore()

  // ── 订阅主进程推送的推荐 ──
  useIPCEvent(window.electronAPI?.onQuickTaskRecommend, (data: { tasks: any[]; timestamp: number }) => {
    store.mergeRecommendations(data.tasks as any)
  })

  // ── 订阅主进程推送的任务更新 ──
  useIPCEvent(window.electronAPI?.onQuickTaskUpdate, (data: { task: any; action: string; timestamp: number }) => {
    if (data.action === 'executed') {
      store.updateTask(data.task.id, { status: 'executed', executionCount: data.task.executionCount })
    } else if (data.action === 'dismissed') {
      store.updateTask(data.task.id, { status: 'dismissed' })
    } else if (data.action === 'edited') {
      store.updateTask(data.task.id, {
        steps: data.task.steps,
        title: data.task.title,
        description: data.task.description,
      })
    }
  })

  // ── 初始加载 ──
  useEffect(() => {
    if (window.electronAPI?.getQuickTasks) {
      store.setLoading(true)
      window.electronAPI.getQuickTasks().then((result) => {
        if (result.success && result.tasks) {
          store.setTasks(result.tasks as any)
        }
        store.setLoading(false)
      })
    }
  }, [])

  // ── 操作方法 ──

  const executeTask = useCallback(async (taskId: string) => {
    const result = await window.electronAPI?.quickTaskExecute(taskId)
    if (result?.success) {
      store.updateTask(taskId, { status: 'executed' })
    }
    return result
  }, [])

  const dismissTask = useCallback(async (taskId: string) => {
    const result = await window.electronAPI?.quickTaskDismiss(taskId)
    if (result?.success) {
      store.updateTask(taskId, { status: 'dismissed' })
    }
    return result
  }, [])

  const snoozeTask = useCallback(async (taskId: string) => {
    return window.electronAPI?.quickTaskSnooze(taskId)
  }, [])

  const editTask = useCallback(async (taskId: string, steps: QuickTaskStep[]) => {
    const result = await window.electronAPI?.quickTaskEdit(taskId, steps)
    if (result?.success && result.task) {
      store.updateTask(taskId, {
        steps: result.task.steps,
        title: result.task.title,
        description: result.task.description,
      })
    }
    return result
  }, [])

  const refreshTasks = useCallback(async () => {
    store.setLoading(true)
    const result = await window.electronAPI?.getQuickTasks()
    if (result?.success && result.tasks) {
      store.setTasks(result.tasks as any)
    }
    store.setLoading(false)
  }, [])

  const analyzeNow = useCallback(async () => {
    store.setLoading(true)
    const result = await window.electronAPI?.quickTaskAnalyze()
    if (result?.success && result.tasks) {
      store.mergeRecommendations(result.tasks as any)
    }
    store.setLoading(false)
    return result
  }, [])

  const recommendNow = useCallback(async () => {
    const result = await window.electronAPI?.quickTaskRecommendNow()
    if (result?.success && result.tasks) {
      store.mergeRecommendations(result.tasks as any)
    }
    return result
  }, [])

  const getSnapshot = useCallback(async () => {
    const result = await window.electronAPI?.getQuickTaskSnapshot()
    if (result?.success && result.snapshot) {
      store.setSnapshot(result.snapshot as any)
    }
    return result
  }, [])

  const setSensitivity = useCallback(async (threshold: number) => {
    return window.electronAPI?.quickTaskSetSensitivity(threshold)
  }, [])

  return {
    // 状态
    tasks: store.tasks,
    activeRecommendations: store.activeRecommendations,
    hasUnreadRecommendation: store.hasUnreadRecommendation,
    loading: store.loading,
    snapshot: store.snapshot,

    // 操作
    executeTask,
    dismissTask,
    snoozeTask,
    editTask,
    refreshTasks,
    analyzeNow,
    recommendNow,
    getSnapshot,
    setSensitivity,
    markRead: store.markRead,
  }
}
