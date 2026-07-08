import { create } from 'zustand'

// =============================================================================
// 桌面工具栏状态类型
// =============================================================================

export interface DesktopTask {
  id: string
  title: string
  tool: string
  status: 'pending' | 'running' | 'success' | 'error'
  result?: string
  error?: string
  createdAt: number
}

export interface ToolFeedback {
  tool: string
  label: string
  success: boolean
  message: string
  timestamp: number
}

interface DesktopToolbarState {
  /** 任务队列 */
  tasks: DesktopTask[]
  /** 最近一次工具执行反馈（短暂显示） */
  feedback: ToolFeedback | null
  /** 工具栏是否可见 */
  visible: boolean
  /** 是否展开显示任务队列 */
  expanded: boolean
}

interface DesktopToolbarActions {
  /** 添加任务到队列 */
  addTask: (task: DesktopTask) => void
  /** 更新任务状态 */
  updateTask: (id: string, patch: Partial<DesktopTask>) => void
  /** 移除任务 */
  removeTask: (id: string) => void
  /** 显示工具执行反馈（3 秒后自动清除） */
  showFeedback: (feedback: ToolFeedback) => void
  /** 清除反馈 */
  clearFeedback: () => void
  /** 切换工具栏可见性 */
  toggleVisible: () => void
  /** 切换任务队列展开 */
  toggleExpanded: () => void
}

type DesktopToolbarStore = DesktopToolbarState & DesktopToolbarActions

const MAX_TASKS = 20
let feedbackTimer: ReturnType<typeof setTimeout> | null = null

export const useDesktopToolbarStore = create<DesktopToolbarStore>((set) => ({
  tasks: [],
  feedback: null,
  visible: true,
  expanded: false,

  addTask: (task) =>
    set((s) => {
      const tasks = [task, ...s.tasks].slice(0, MAX_TASKS)
      return { tasks }
    }),

  updateTask: (id, patch) =>
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),

  removeTask: (id) =>
    set((s) => ({
      tasks: s.tasks.filter((t) => t.id !== id),
    })),

  showFeedback: (feedback) => {
    if (feedbackTimer) clearTimeout(feedbackTimer)
    set({ feedback })
    feedbackTimer = setTimeout(() => {
      set({ feedback: null })
      feedbackTimer = null
    }, 3000)
  },

  clearFeedback: () => {
    if (feedbackTimer) {
      clearTimeout(feedbackTimer)
      feedbackTimer = null
    }
    set({ feedback: null })
  },

  toggleVisible: () => set((s) => ({ visible: !s.visible })),
  toggleExpanded: () => set((s) => ({ expanded: !s.expanded })),
}))
