/**
 * quickTaskStore — 快捷任务 Zustand Store
 *
 * 管理从主进程推送的快捷任务推荐状态，提供执行/关闭/稍后操作。
 * 与 main/behavior/QuickTaskService 通过 IPC 通信。
 */

import { create } from 'zustand'

// =============================================================================
// 类型定义
// =============================================================================

export interface QuickTaskStep {
  tool: string
  label: string
  args?: Record<string, unknown>
}

export type QuickTaskStatus = 'pending' | 'active' | 'dismissed' | 'executed'
export type RecommendationLevel = 'suggested' | 'auto' | 'suppressed'

export interface QuickTask {
  id: string
  title: string
  description: string
  steps: QuickTaskStep[]
  toolSequence: string[]
  frequency: number
  confidence: number
  recommendationLevel: RecommendationLevel
  status: QuickTaskStatus
  firstRecommendedAt: number
  lastActiveAt: number
  executionCount: number
  dismissCount: number
}

export interface QuickTaskSnapshot {
  totalTasksLearned: number
  activeRecommendations: number
  suppressedTasks: number
  totalExecuted: number
  sensitivityThreshold: number
  lastAnalysisAt: number | null
  activeTasks: QuickTask[]
}

// =============================================================================
// Store
// =============================================================================

interface QuickTaskStateData {
  /** 所有已学习的快捷任务 */
  tasks: QuickTask[]
  /** 当前活跃的推荐列表 */
  activeRecommendations: QuickTask[]
  /** 是否有推荐未读 */
  hasUnreadRecommendation: boolean
  /** 是否正在加载 */
  loading: boolean
  /** 服务快照 */
  snapshot: QuickTaskSnapshot | null
}

interface QuickTaskActions {
  /** 设置全量任务列表 */
  setTasks: (tasks: QuickTask[]) => void
  /** 设置活跃推荐 */
  setActiveRecommendations: (tasks: QuickTask[]) => void
  /** 合并推送过来的推荐（增量更新，防止覆盖已有的状态） */
  mergeRecommendations: (tasks: QuickTask[]) => void
  /** 更新单个任务的状态 */
  updateTask: (taskId: string, patch: Partial<QuickTask>) => void
  /** 标记推荐已读 */
  markRead: () => void
  /** 设置加载状态 */
  setLoading: (loading: boolean) => void
  /** 设置服务快照 */
  setSnapshot: (snapshot: QuickTaskSnapshot) => void
  /** 重置所有状态 */
  reset: () => void
}

type QuickTaskStore = QuickTaskStateData & QuickTaskActions

const initialState: QuickTaskStateData = {
  tasks: [],
  activeRecommendations: [],
  hasUnreadRecommendation: false,
  loading: false,
  snapshot: null,
}

export const useQuickTaskStore = create<QuickTaskStore>((set) => ({
  ...initialState,

  setTasks: (tasks) => set({ tasks }),

  setActiveRecommendations: (tasks) => set({ activeRecommendations: tasks }),

  mergeRecommendations: (tasks) =>
    set((s) => {
      // 合并新的推荐到已有列表：新增或更新，保留 dismissed/executed 状态
      const merged = [...s.tasks]
      for (const task of tasks) {
        const idx = merged.findIndex((t) => t.id === task.id)
        if (idx >= 0) {
          // 不覆盖用户已操作的状态
          if (merged[idx].status === 'dismissed' || merged[idx].status === 'executed') {
            // 只更新 lastActiveAt 和 frequency
            merged[idx] = { ...merged[idx], lastActiveAt: task.lastActiveAt, frequency: task.frequency }
          } else {
            merged[idx] = { ...merged[idx], ...task }
          }
        } else {
          merged.push(task)
        }
      }

      // 活跃推荐 = 所有 status === 'active' 且未被用户关闭的任务
      const active = merged.filter((t) => t.status === 'active' && t.recommendationLevel !== 'suppressed')

      return {
        tasks: merged,
        activeRecommendations: active,
        hasUnreadRecommendation: active.length > 0,
      }
    }),

  updateTask: (taskId, patch) =>
    set((s) => {
      const tasks = s.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t))
      const active = tasks.filter((t) => t.status === 'active' && t.recommendationLevel !== 'suppressed')
      return { tasks, activeRecommendations: active }
    }),

  markRead: () => set({ hasUnreadRecommendation: false }),

  setLoading: (loading) => set({ loading }),

  setSnapshot: (snapshot) => set({ snapshot }),

  reset: () => set(initialState),
}))
