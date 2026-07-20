/**
 * TaskPanelService — 桌面悬浮任务面板状态聚合服务
 *
 * 聚合 Agent 当前状态、计划进度、可用快捷操作，并通过 IPC 推送到
 * 壁纸 Overlay 上的 TaskPanelWidget 渲染。
 *
 * 集成方式：
 * - 由 AppRuntime 在启动阶段实例化并设置 AgentService 引用
 * - 提供 getState() 方法供 IPC handler 调用
 * - 通过 pushUpdate() 主动推送状态变更到渲染进程
 */

import { BrowserWindow } from 'electron'
import { log } from '../logger/Logger'
import type { AgentService } from '../agent/AgentService'

// =============================================================================
// 类型定义
// =============================================================================

export interface TaskPanelQuickAction {
  id: string
  label: string
  icon: string
  description: string
  tool: string
  args: Record<string, string>
  /** 是否需要用户输入参数 */
  needsInput?: boolean
  inputPrompt?: string
  inputField?: string
}

export interface TaskPanelPlanInfo {
  hasActivePlan: boolean
  planTitle: string
  totalSteps: number
  completedSteps: number
  percentComplete: number
  currentStep: string
}

export interface TaskPanelState {
  agent: {
    busy: boolean
    paused: boolean
    statusLabel: string
    toolName: string | null
    toolStatus: 'idle' | 'running' | 'success' | 'error' | null
  }
  plan: TaskPanelPlanInfo
  quickActions: TaskPanelQuickAction[]
  recentActions: Array<{
    id: string
    tool: string
    status: 'running' | 'success' | 'error'
    summary: string
    timestamp: number
  }>
  visible: boolean
  timestamp: number
}

// =============================================================================
// 默认快捷操作定义
// =============================================================================

const DEFAULT_QUICK_ACTIONS: TaskPanelQuickAction[] = [
  {
    id: 'screenshot_translate',
    label: '截图并翻译',
    icon: '📷',
    description: '截取屏幕区域并翻译内容',
    tool: 'desktop_screenshot_translate',
    args: {},
  },
  {
    id: 'quick_note',
    label: '快速笔记',
    icon: '📝',
    description: '记录快速笔记到工作区',
    tool: 'desktop_quick_note',
    args: {},
    needsInput: true,
    inputPrompt: '输入笔记内容',
    inputField: 'content',
  },
  {
    id: 'todo_add',
    label: '添加待办',
    icon: '✓',
    description: '添加新的待办事项',
    tool: 'desktop_todo_add',
    args: { priority: 'normal' },
    needsInput: true,
    inputPrompt: '输入待办事项',
    inputField: 'title',
  },
  {
    id: 'screenshot_analyze',
    label: '截图分析',
    icon: '🔍',
    description: '截取屏幕区域并进行分析',
    tool: 'desktop_screenshot_analyze',
    args: {},
  },
  {
    id: 'clipboard_process',
    label: '处理剪贴板',
    icon: '📋',
    description: '处理剪贴板内容（翻译 / 总结 / 格式化）',
    tool: 'desktop_clipboard_process',
    args: {},
    needsInput: true,
    inputPrompt: '处理方式（翻译/总结/格式化）',
    inputField: 'mode',
  },
  {
    id: 'app_launch',
    label: '启动应用',
    icon: '🚀',
    description: '快速启动应用程序',
    tool: 'desktop_app_launch',
    args: {},
    needsInput: true,
    inputPrompt: '输入应用名（如 vscode, chrome）',
    inputField: 'appName',
  },
  {
    id: 'ask_agent',
    label: '快捷提问',
    icon: '💬',
    description: '向 Agent 发送简短指令',
    tool: 'desktop_ask_agent',
    args: {},
    needsInput: true,
    inputPrompt: '输入指令内容',
    inputField: 'prompt',
  },
  {
    id: 'trigger_evolution',
    label: '触发进化',
    icon: '🧬',
    description: '手动触发自进化周期',
    tool: 'evolution_trigger',
    args: {},
  },
]

// =============================================================================
// 服务类
// =============================================================================

export class TaskPanelService {
  private agentService: AgentService | null = null
  private planManager: any = null
  private windows: BrowserWindow[] = []
  private _visible = false
  private recentActions: TaskPanelState['recentActions'] = []
  private retainActionCount = 5

  // ── 依赖注入 ──

  setAgentService(svc: AgentService): void {
    this.agentService = svc
  }

  setPlanManager(pm: any): void {
    this.planManager = pm
  }

  setWindow(win: BrowserWindow): void {
    if (!this.windows.includes(win)) {
      this.windows.push(win)
    }
  }

  // ── 可见性控制 ──

  get visible(): boolean {
    return this._visible
  }

  toggleVisibility(): boolean {
    this._visible = !this._visible
    this.pushUpdate()
    log('INFO', 'task_panel_toggle_visibility', { visible: this._visible })
    return this._visible
  }

  setVisible(v: boolean): void {
    if (this._visible !== v) {
      this._visible = v
      this.pushUpdate()
    }
  }

  // ── 记录最近操作 ──

  recordAction(action: { tool: string; status: 'running' | 'success' | 'error'; summary: string }): void {
    this.recentActions.unshift({
      id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      ...action,
      timestamp: Date.now(),
    })
    if (this.recentActions.length > this.retainActionCount) {
      this.recentActions = this.recentActions.slice(0, this.retainActionCount)
    }
    this.pushUpdate()
  }

  // ── 状态聚合 ──

  getState(): TaskPanelState {
    let busy = false
    let paused = false
    let statusLabel = '待机'
    let toolName: string | null = null
    let toolStatus: TaskPanelState['agent']['toolStatus'] = null

    if (this.agentService) {
      busy = this.agentService.isBusy()
      paused = this.agentService.isPaused()

      if (paused) {
        statusLabel = '已暂停'
      } else if (busy) {
        statusLabel = '处理中…'
      } else {
        statusLabel = '待机'
      }
    }

    // 计划进度
    let plan: TaskPanelPlanInfo = {
      hasActivePlan: false,
      planTitle: '',
      totalSteps: 0,
      completedSteps: 0,
      percentComplete: 0,
      currentStep: '',
    }

    try {
      if (this.planManager) {
        const activePlan = this.planManager.getActivePlan()
        if (activePlan) {
          const steps = activePlan.steps || []
          const completedSteps = steps.filter(
            (s: any) => s.status === 'done' || s.status === 'completed',
          ).length
          const totalSteps = steps.length
          const current = steps.find((s: any) => s.status === 'in_progress')
          plan = {
            hasActivePlan: true,
            planTitle: activePlan.title || '',
            totalSteps,
            completedSteps,
            percentComplete: totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0,
            currentStep: current?.description || '',
          }
        }
      }
    } catch {
      // planManager 不可用时降级
    }

    return {
      agent: {
        busy,
        paused,
        statusLabel,
        toolName,
        toolStatus,
      },
      plan,
      quickActions: DEFAULT_QUICK_ACTIONS,
      recentActions: this.recentActions,
      visible: this._visible,
      timestamp: Date.now(),
    }
  }

  // ── 推送更新到渲染进程 ──

  pushUpdate(): void {
    const state = this.getState()
    for (const win of this.windows) {
      if (win && !win.isDestroyed()) {
        win.webContents.send('task-panel:state', state)
      }
    }
  }

  // ── 清理 ──

  destroy(): void {
    this.windows = []
    this.recentActions = []
  }
}
